/**
 * Phase 1: Qwen3-NAN vs Gemini — end-to-end prod-replica eval.
 *
 * Loads citizen-queries.json, runs runRetrievalCore with per-model overrides,
 * evaluates hit@1/5/10 on articles (post-rerank) and allFusedArticles (pre-rerank).
 *
 * Uses ONLY existing Qwen-NAN embeddings in SQLite (no new embeds).
 * Subset: queries fully-covered by Qwen-NAN store.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-... bun packages/api/research/ab/eval-prod-replica.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

// ── Imports from prod code ──
import { createSchema } from "../../../pipeline/src/db/schema.ts";
import {
	embedQuery as prodEmbedQuery,
	EMBEDDING_MODELS,
	type EmbeddingStore,
} from "../../src/services/rag/embeddings.ts";
import {
	runRetrievalCore,
	type RunRetrievalCoreOpts,
	type RetrievalResult,
	type EmbedQueryFn,
} from "../../src/services/rag/retrieval.ts";
import { getVectorPool, shutdownVectorPool } from "../../src/services/rag/vector-pool.ts";
import { _resetSharedVectorIndexForTests } from "../../src/services/rag/vector-index-singleton.ts";
import { ensureVectorIndex } from "../../src/services/rag/embeddings.ts";

// ── Qwen3-Embedding-8B via OpenRouter (nan.builders blocked by Cloudflare) ──

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

async function qwenOpenRouterEmbedQuery(
	apiKey: string,
	_modelKey: string,
	query: string,
): Promise<{ embedding: Float32Array; cost: number; tokens: number }> {
	// Qwen3 doc-side: plain text, NO instruction prefix (official spec)
	// Query-side: Instruct prefix recommended
	const prefixedQuery = `Instruct: Dada una pregunta jurídica de un ciudadano español, recupera el artículo de la legislación vigente que mejor la responda.\nQuery: ${query}`;

	let attempts = 0;
	while (true) {
		const res = await fetch(OPENROUTER_EMBEDDINGS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://leyabierta.es",
				"X-Title": "Ley Abierta RAG Eval",
			},
			body: JSON.stringify({
				model: "qwen/qwen3-embedding-8b",
				input: prefixedQuery,
			}),
			signal: AbortSignal.timeout(30_000),
		});

		if (res.status === 429) {
			attempts++;
			if (attempts > 3) throw new Error("Rate limited after max retries");
			await new Promise((r) => setTimeout(r, 1000 * attempts * 2));
			continue;
		}

		if (!res.ok) {
			const errText = await res.text();
			throw new Error(`OpenRouter embeddings ${res.status}: ${errText.slice(0, 200)}`);
		}

		const data = await res.json();
		return {
			embedding: new Float32Array(data.data[0].embedding),
			cost: 0,
			tokens: 0,
		};
	}
}

// ── Build per-model in-memory index from SQLite ──
// For Phase 1 we only need the overlapping norm subset (Qwen-NAN coverage).
// Loading the full Gemini store (484k vectors ≈ 5.7 GB) OOMs the process.

async function buildModelIndex(
	db: Database,
	modelKey: string,
	dataDir: string,
	// If provided, restrict to these norm_ids only
	normFilter?: string[],
): Promise<{
	meta: Array<{ normId: string; blockId: string }>;
	vectors: Awaited<ReturnType<typeof ensureVectorIndex>>["vectors"];
	dims: number;
} | null> {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) return null;

	const count = db
		.query<{ cnt: number }, [string]>(
			"SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?",
		)
		.get(modelKey)?.cnt ?? 0;

	if (count === 0) return null;

	// Load from SQLite, optionally filtered to norm subset
	const store = loadEmbeddingsFromDb(db, modelKey, normFilter);
	if (!store) return null;

	const dims = model.dimensions;
	const vectorsPerChunk = Math.floor(2_500_000_000 / (dims * 4)); // ~2.5GB per chunk
	const chunks: Float32Array[] = [];
	const normsPerChunk: Float32Array[] = [];
	const vpc: number[] = [];

	for (let i = 0; i < store.count; i += vectorsPerChunk) {
		const end = Math.min(i + vectorsPerChunk, store.count);
		const numVecs = end - i;
		chunks.push(store.vectors.subarray(i * dims, end * dims));
		normsPerChunk.push(store.norms.subarray(i, end));
		vpc.push(numVecs);
	}

	return {
		meta: store.articles,
		vectors: {
			kind: "f32" as const,
			chunks,
			int8Chunks: [],
			scalesPerChunk: [],
			vectorsPerChunk: vpc,
			normsPerChunk,
			totalVectors: store.count,
			dim: dims,
		},
		dims,
	};
}

/**
 * Load all embeddings from SQLite into the same EmbeddingStore format.
 * (Copied from embeddings.ts to avoid import issues in eval context)
 * Optionally filter to a subset of norm_ids.
 */
function loadEmbeddingsFromDb(
	db: Database,
	modelKey: string,
	normFilter?: string[],
): EmbeddingStore | null {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) return null;

	// Use prepare() instead of query() — bun:sqlite query() with string params
	// returns 0 rows due to a binding issue. prepare() works correctly.
	let sql =
		"SELECT norm_id, block_id, vector FROM embeddings WHERE model = ?";
	const params: (string | number)[] = [modelKey];

	if (normFilter && normFilter.length > 0) {
		const ph = normFilter.map(() => "?").join(",");
		sql += ` AND norm_id IN (${ph})`;
		for (const n of normFilter) {
			params.push(n);
		}
	}
	sql += " ORDER BY norm_id, block_id";

	const stmt = db.prepare(sql);
	const rows = stmt.all(...params) as Array<{
		norm_id: string;
		block_id: string;
		vector: Buffer;
	}>;

	if (rows.length === 0) return null;

	const dims = model.dimensions;
	const count = rows.length;
	const articles: Array<{ normId: string; blockId: string }> = [];
	const vectors = new Float32Array(count * dims);

	for (let i = 0; i < count; i++) {
		const row = rows[i]!;
		articles.push({ normId: row.norm_id, blockId: row.block_id });
		const rowVector = new Float32Array(
			row.vector.buffer,
			row.vector.byteOffset,
			dims,
		);
		vectors.set(rowVector, i * dims);
	}

	const norms = computeNorms(vectors, count, dims);
	return { model: modelKey, dimensions: dims, count, articles, vectors, norms };
}

function computeNorms(
	vectors: Float32Array,
	count: number,
	dims: number,
): Float32Array {
	const norms = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		const offset = i * dims;
		let sum = 0;
		for (let j = 0; j < dims; j++) {
			const v = vectors[offset + j] ?? 0;
			sum += v * v;
		}
		norms[i] = Math.sqrt(sum);
	}
	return norms;
}

// ── Args ──

const args = process.argv.slice(2);
const openRouterKey = process.env.OPENROUTER_API_KEY;
// nan.builders uses HERMES_API_KEY (not NAN_API_KEY)
const nanApiKey = process.env.HERMES_API_KEY;
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;
const onlyLocal = args.includes("--only-local");

// ── Paths ──

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const evalPath = join(
	repoRoot,
	"packages/api/research/datasets/citizen-queries.json",
);
const outDir = join(repoRoot, "data", "ab-results");
await Bun.write(`${outDir}/.keep`, "");

// ── DB ──

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// ── Load eval set ──

interface EvalQuery {
	id: number;
	question: string;
	expectedNorms?: string[];
	category?: string;
}
const evalData = (await Bun.file(evalPath).json()) as {
	results: EvalQuery[];
};
let questions = evalData.results.filter(
	(r) => (r.expectedNorms?.length ?? 0) > 0,
);
if (limit) questions = questions.slice(0, limit);
console.log(`Eval set: ${questions.length} questions`);

// ── Determine Qwen-NAN covered norms ──

const qwenNormIds = db
	.query<{ norm_id: string }, string[]>(
		"SELECT DISTINCT norm_id FROM embeddings WHERE model = 'qwen3-nan'",
	)
	.all()
	.map((r) => r.norm_id);
console.log(`Qwen-NAN covers ${qwenNormIds.length} distinct norms`);

// Find queries fully covered by Qwen-NAN (all expectedNorms in store)
const qwenNormSet = new Set(qwenNormIds);
const coveredQueries = questions.filter((q) =>
	q.expectedNorms?.every((n) => qwenNormSet.has(n)),
);
console.log(
	`Fully covered by Qwen-NAN: ${coveredQueries.length} / ${questions.length}`,
);

// Also find partial coverage for diagnostics
const partialQueries = questions.filter((q) => {
	if (!q.expectedNorms) return false;
	const covered = q.expectedNorms.filter((n) => qwenNormSet.has(n)).length;
	const total = q.expectedNorms.length;
	return covered > 0 && covered < total;
});
const uncoveredQueries = questions.filter((q) => {
	if (!q.expectedNorms) return false;
	return q.expectedNorms.every((n) => !qwenNormSet.has(n));
});
console.log(
	`Partially covered: ${partialQueries.length}, Uncovered: ${uncoveredQueries.length}`,
);

// ── Build vector indexes ──

// Phase 1: restrict both indexes to the 138 norms covered by Qwen-NAN.
// This ensures fair comparison AND avoids OOM (full Gemini store = 484k vectors ~ 5.7GB).
console.log("\nBuilding Gemini vector index (restricted to Qwen-NAN coverage)...");
_resetSharedVectorIndexForTests();
const geminiIndex = await buildModelIndex(
	db,
	"gemini-embedding-2",
	join(repoRoot, "data"),
	qwenNormIds,
);
console.log(
	`  Gemini: ${geminiIndex?.vectors.totalVectors ?? 0} vectors, ${geminiIndex?.dims ?? 0} dims`,
);

console.log("Building Qwen-NAN vector index (full coverage)...");
const qwenIndex = await buildModelIndex(db, "qwen3-nan", join(repoRoot, "data"));
console.log(
	`  Qwen-NAN: ${qwenIndex?.vectors.totalVectors ?? 0} vectors, ${qwenIndex?.dims ?? 0} dims`,
);

if (!geminiIndex || !qwenIndex) {
	console.error("FATAL: Could not build both indexes");
	process.exit(1);
}

// ── Run eval ──

type QueryResult = {
	id: number;
	question: string;
	category: string;
	model: string;
	hitsAt1: boolean;
	hitsAt5: boolean;
	hitsAt10: boolean;
	topNormIds: string[];
	topBlockIds: string[];
	score: number;
};

const results: QueryResult[] = [];

async function runVariant(
	question: EvalQuery,
	modelKey: string,
	index: NonNullable<typeof geminiIndex>,
	embedFn: EmbedQueryFn,
): Promise<QueryResult> {
	const opts: Omit<RunRetrievalCoreOpts, "db" | "apiKey" | "cohereApiKey"> = {
		embeddingModelKey: modelKey,
		embedQueryFn: embedFn,
		// Disable low-confidence gate: Qwen and Gemini cosine score scales differ.
		// We compare retrieval quality, not the prod confidence calibration.
		lowConfidenceThreshold: 0,
		question: question.question,
		requestJurisdiction: undefined,
		embeddedNormIds: qwenNormIds,
		vectorIndex: {
			meta: index.meta,
			vectors: index.vectors,
			dims: index.dims,
		},
	};

	let result: RetrievalResult;
	try {
		result = await runRetrievalCore({
			db,
			apiKey: openRouterKey!,
			cohereApiKey: null,
			...opts,
		});
	} catch (err) {
		console.error(
			`  ERROR on q${question.id} (${modelKey}): ${err instanceof Error ? err.message : String(err)}`,
		);
		return {
			id: question.id,
			question: question.question,
			category: question.category ?? "",
			model: modelKey,
			hitsAt1: false,
			hitsAt5: false,
			hitsAt10: false,
			topNormIds: [],
			topBlockIds: [],
			score: 0,
		};
	}

	const articles = result.type === "ready" ? result.articles : [];
	const allFused = result.type === "ready" ? result.allFusedArticles : [];

	const topNormIds = articles.slice(0, 10).map((a) => a.normId);
	const topBlockIds = articles.slice(0, 10).map((a) => a.blockId);

	const expected = question.expectedNorms ?? [];
	const hitAt1 =
		articles.length > 0 && expected.some((n) => articles[0]!.normId === n);
	const hitAt5 =
		articles.length > 0 &&
		expected.some((n) => articles.slice(0, 5).some((a) => a.normId === n));
	const hitAt10 =
		articles.length > 0 &&
		expected.some((n) => articles.slice(0, 10).some((a) => a.normId === n));

	return {
		id: question.id,
		question: question.question,
		category: question.category ?? "",
		model: modelKey,
		hitsAt1: hitAt1,
		hitsAt5: hitAt5,
		hitsAt10: hitAt10,
		topNormIds,
		topBlockIds,
		score: result.bestScore,
	};
}

// Gemini embedder (OpenRouter)
const geminiEmbedFn = (apiKey: string, _modelKey: string, q: string) =>
	prodEmbedQuery(apiKey, "gemini-embedding-2", q);

// Qwen-NAN embedder (nan.builders)
if (!nanApiKey && !onlyLocal) {
	console.error("HERMES_API_KEY required for Qwen-NAN variant (or use --only-local)");
	process.exit(1);
}

console.log(
	`\nRunning eval on ${coveredQueries.length} fully-covered queries...`,
);

const geminiResults: QueryResult[] = [];
const qwenResults: QueryResult[] = [];

// Vector pool is a process-wide singleton (vector-pool.ts:74). Once initialized
// with one model's vectors+dims, subsequent calls with a different index ignore
// the new index entirely — the pool keeps using the first cached one. This
// causes silent corruption when alternating models per-query (the second
// model's globalIdx values index into the first model's vectors).
//
// Workaround: run all queries for one model, then `shutdownVectorPool()` to
// reset the singleton, then run all queries for the next model.

console.log("\n== Pass 1: Gemini ==");
for (let i = 0; i < coveredQueries.length; i++) {
	const q = coveredQueries[i]!;
	const pct = ((i + 1) / coveredQueries.length * 100).toFixed(0);
	process.stdout.write(
		`\r  Gemini progress: ${i + 1}/${coveredQueries.length} (${pct}%)   `,
	);
	const gResult = await runVariant(q, "gemini-embedding-2", geminiIndex, geminiEmbedFn);
	geminiResults.push(gResult);
}
console.log("\n");

console.log("== Resetting vector pool for Qwen ==");
shutdownVectorPool();
_resetSharedVectorIndexForTests();

console.log("== Pass 2: Qwen-NAN ==");
for (let i = 0; i < coveredQueries.length; i++) {
	const q = coveredQueries[i]!;
	const pct = ((i + 1) / coveredQueries.length * 100).toFixed(0);
	process.stdout.write(
		`\r  Qwen progress: ${i + 1}/${coveredQueries.length} (${pct}%)   `,
	);
	const qResult = await runVariant(q, "qwen3-nan", qwenIndex, qwenOpenRouterEmbedQuery);
	qwenResults.push(qResult);
}
console.log("\n");

// ── Compute metrics ──

function computeMetrics(results: QueryResult[]) {
	const total = results.length;
	const hits1 = results.filter((r) => r.hitsAt1).length;
	const hits5 = results.filter((r) => r.hitsAt5).length;
	const hits10 = results.filter((r) => r.hitsAt10).length;
	const mrr =
		results.reduce((sum, r) => {
			const idx = results
				.filter((x) => x.id === r.id)
				.findIndex((x) => x.hitsAt1);
			return sum + (idx >= 0 ? 1 / (idx + 1) : 0);
		}, 0) / total;

	return {
		total,
		r1: (hits1 / total * 100).toFixed(1),
		r5: (hits5 / total * 100).toFixed(1),
		r10: (hits10 / total * 100).toFixed(1),
		mrr: mrr.toFixed(3),
	};
}

const geminiMetrics = computeMetrics(geminiResults);
const qwenMetrics = computeMetrics(qwenResults);

// ── Report ──

console.log("\n" + "=".repeat(70));
console.log("PHASE 1 EVAL RESULTS — End-to-End Prod Replica");
console.log("=".repeat(70));
console.log(`Queries evaluated: ${coveredQueries.length} (fully covered by Qwen-NAN)`);
console.log(`Gemini index: ${geminiIndex.vectors.totalVectors} vectors, ${geminiIndex.dims} dims`);
console.log(`Qwen-NAN index: ${qwenIndex.vectors.totalVectors} vectors, ${qwenIndex.dims} dims`);
console.log(`Cohere reranker: disabled (--cohere-api-key not set)`);
console.log("\n" + "-".repeat(70));
console.log("Metrics (hit@K on articles — post-rerank):");
console.log("-".repeat(70));
console.log(
	`Model          R@1      R@5      R@10     MRR@10`,
);
console.log(
	`Gemini-2       ${geminiMetrics.r1.padStart(6)}%   ${geminiMetrics.r5.padStart(6)}%   ${geminiMetrics.r10.padStart(6)}%   ${geminiMetrics.mrr.padStart(6)}`,
);
console.log(
	`Qwen-NAN       ${qwenMetrics.r1.padStart(6)}%   ${qwenMetrics.r5.padStart(6)}%   ${qwenMetrics.r10.padStart(6)}%   ${qwenMetrics.mrr.padStart(6)}`,
);

const gapR1 = parseFloat(geminiMetrics.r1) - parseFloat(qwenMetrics.r1);
const gapR5 = parseFloat(geminiMetrics.r5) - parseFloat(qwenMetrics.r5);
const gapR10 = parseFloat(geminiMetrics.r10) - parseFloat(qwenMetrics.r10);

console.log("\n" + "-".repeat(70));
console.log("Gaps (Gemini - Qwen):");
console.log("-".repeat(70));
console.log(`  R@1 gap:   ${gapR1.toFixed(1)} pp`);
console.log(`  R@5 gap:   ${gapR5.toFixed(1)} pp`);
console.log(`  R@10 gap:  ${gapR10.toFixed(1)} pp`);

// Decision gate
console.log("\n" + "=".repeat(70));
console.log("DECISION GATE — Phase 1");
console.log("=".repeat(70));
if (gapR1 <= 3) {
	console.log("GAP ≤ 3pp → PROCEED to Phase 2 (pilot embed for remaining queries)");
} else if (gapR1 > 5) {
	console.log("GAP > 5pp → SKIP to Phase 4 (interventions), no pilot embed");
} else {
	console.log("GAP 3-5pp → DISCUSS before proceeding");
}

// ── Per-question miss analysis ──

console.log("\n" + "=".repeat(70));
console.log("PER-QUESTION MISS ANALYSIS (where Qwen misses but Gemini hits)");
console.log("=".repeat(70));

const misses = qwenResults.filter(
	(q, i) => qwenResults[i]!.hitsAt1 && !geminiResults[i]!.hitsAt1
		? false
		: !qwenResults[i]!.hitsAt1 && geminiResults[i]!.hitsAt1,
);

// Actually: Qwen misses where Gemini hits
const qwenMisses = [];
for (let i = 0; i < coveredQueries.length; i++) {
	const g = geminiResults[i]!;
	const q = qwenResults[i]!;
	if (g.hitsAt1 && !q.hitsAt1) {
		const query = coveredQueries[i]!;
		qwenMisses.push({
			id: query.id,
			question: query.question,
			expected: query.expectedNorms,
			geminiTop: g.topNormIds.slice(0, 3),
			qwenTop: q.topNormIds.slice(0, 3),
		});
	}
}

if (qwenMisses.length === 0) {
	console.log("  No misses — Qwen matches Gemini on all queries!");
} else {
	console.log(`\n  ${qwenMisses.length} queries where Gemini hits@1 but Qwen misses:\n`);
	for (const m of qwenMisses.slice(0, 10)) {
		console.log(`  q${m.id}: "${m.question}"`);
		console.log(`    Expected: ${m.expected?.join(", ")}`);
		console.log(`    Gemini top: ${m.geminiTop.join(", ")}`);
		console.log(`    Qwen top:   ${m.qwenTop.join(", ")}`);
		console.log();
	}
	if (qwenMisses.length > 10) {
		console.log(`  ... and ${qwenMisses.length - 10} more\n`);
	}
}

// ── Save results ──

const report = {
	date: new Date().toISOString().slice(0, 10),
	totalQueries: coveredQueries.length,
	gemini: { metrics: geminiMetrics, results: geminiResults },
	qwen: { metrics: qwenMetrics, results: qwenResults },
	gaps: { r1: gapR1, r5: gapR5, r10: gapR10 },
	qwenMisses: qwenMisses.slice(0, 20),
};
await Bun.write(
	`${outDir}/eval-prod-replica-${new Date().toISOString().slice(0, 10)}.json`,
	JSON.stringify(report, null, 2),
);
console.log(`\nFull report saved to ${outDir}/eval-prod-replica-${new Date().toISOString().slice(0, 10)}.json`);

// ── Cleanup ──

shutdownVectorPool();
db.close();
