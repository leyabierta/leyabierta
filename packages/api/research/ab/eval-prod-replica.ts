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
import { callNan } from "../../src/services/nan.ts";
import {
	EMBEDDING_MODELS,
	type ensureVectorIndex,
	embedQuery as prodEmbedQuery,
} from "../../src/services/rag/embeddings.ts";
import {
	type EmbedQueryFn,
	type RetrievalResult,
	type RunRetrievalCoreOpts,
	runRetrievalCore,
} from "../../src/services/rag/retrieval.ts";
import { _resetSharedVectorIndexForTests } from "../../src/services/rag/vector-index-singleton.ts";
import { shutdownVectorPool } from "../../src/services/rag/vector-pool.ts";

// ── Qwen3-Embedding-8B via OpenRouter (nan.builders blocked by Cloudflare) ──

// Query-side embedding via NaN (free, OpenAI-compatible). Same model/dims as
// the corpus embeddings; using NaN consistently keeps the eval 100% on the
// free stack and avoids any OpenRouter dependency for embeddings.
const NAN_EMBEDDINGS_URL = "https://api.nan.builders/v1/embeddings";

async function qwenNanEmbedQuery(
	_apiKey: string, // ignored; we use HERMES_API_KEY for NaN
	_modelKey: string,
	query: string,
): Promise<{ embedding: Float32Array; cost: number; tokens: number }> {
	// Doc-side embeddings have no prompt (Qwen3 official spec). Match that on
	// query-side: --no-instruct (default for fair raw eval). Phase 4 ablation
	// confirmed Instruct prefix HURTS R@1 by ~10pp on this corpus.
	const prefixedQuery = QWEN_USE_INSTRUCT
		? `Instruct: Dada una pregunta jurídica de un ciudadano español, recupera el artículo de la legislación vigente que mejor la responda.\nQuery: ${query}`
		: query;

	const apiKey = process.env.HERMES_API_KEY;
	if (!apiKey) {
		throw new Error("HERMES_API_KEY required for NaN embeddings");
	}

	let attempts = 0;
	while (true) {
		const res = await fetch(NAN_EMBEDDINGS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "qwen3-embedding",
				input: prefixedQuery,
				encoding_format: "float",
			}),
			signal: AbortSignal.timeout(60_000),
		});

		if (res.status === 429 || res.status >= 500) {
			attempts++;
			if (attempts > 5)
				throw new Error(
					`NaN embeddings ${res.status} after ${attempts} retries`,
				);
			await new Promise((r) => setTimeout(r, 2000 * attempts));
			continue;
		}

		if (!res.ok) {
			const errText = await res.text();
			throw new Error(`NaN embeddings ${res.status}: ${errText.slice(0, 200)}`);
		}

		const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
		return {
			embedding: new Float32Array(data.data[0]!.embedding),
			cost: 0,
			tokens: 0,
		};
	}
}

// Backwards-compat alias (older callsites use the OpenRouter name).
const qwenOpenRouterEmbedQuery = qwenNanEmbedQuery;

// ── Build per-model in-memory index from SQLite ──
// For Phase 1 we only need the overlapping norm subset (Qwen-NAN coverage).
// Loading the full Gemini store (484k vectors ≈ 5.7 GB) OOMs the process.

async function buildModelIndex(
	db: Database,
	modelKey: string,
	_dataDir: string,
	// If provided, restrict to these norm_ids only
	normFilter?: string[],
): Promise<{
	meta: Array<{ normId: string; blockId: string }>;
	vectors: Awaited<ReturnType<typeof ensureVectorIndex>>["vectors"];
	dims: number;
} | null> {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) return null;

	const dims = model.dimensions;

	// Count rows first to size chunks. Apply same filter as the streaming load.
	let countSql = "SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?";
	const countParams: (string | number)[] = [modelKey];
	if (normFilter && normFilter.length > 0) {
		const ph = normFilter.map(() => "?").join(",");
		countSql += ` AND norm_id IN (${ph})`;
		for (const n of normFilter) countParams.push(n);
	}
	const totalCount =
		(db.prepare(countSql).get(...countParams) as { cnt: number } | null)?.cnt ??
		0;
	if (totalCount === 0) return null;

	// Stream rows from SQLite in chunks, allocating one Float32Array per chunk.
	// Chunk size ~1 GB (well under JSC's per-allocation limit) keeps both
	// indexes loadable sequentially on 48 GB hosts.
	const vectorsPerChunk = Math.max(1, Math.floor(1_000_000_000 / (dims * 4)));
	const articles: Array<{ normId: string; blockId: string }> = [];
	const chunks: Float32Array[] = [];
	const normsPerChunk: Float32Array[] = [];
	const vpc: number[] = [];

	let sql = "SELECT norm_id, block_id, vector FROM embeddings WHERE model = ?";
	const params: (string | number)[] = [modelKey];
	if (normFilter && normFilter.length > 0) {
		const ph = normFilter.map(() => "?").join(",");
		sql += ` AND norm_id IN (${ph})`;
		for (const n of normFilter) params.push(n);
	}
	sql += " ORDER BY norm_id, block_id";
	const stmt = db.prepare(sql);

	let chunkVecs = new Float32Array(
		Math.min(vectorsPerChunk, totalCount) * dims,
	);
	let chunkNorms = new Float32Array(Math.min(vectorsPerChunk, totalCount));
	let inChunk = 0;
	let loaded = 0;

	const flushChunk = () => {
		if (inChunk === 0) return;
		// Trim to actual size used, then attach.
		const trimmedVecs =
			inChunk * dims === chunkVecs.length
				? chunkVecs
				: chunkVecs.slice(0, inChunk * dims);
		const trimmedNorms =
			inChunk === chunkNorms.length ? chunkNorms : chunkNorms.slice(0, inChunk);
		chunks.push(trimmedVecs);
		normsPerChunk.push(trimmedNorms);
		vpc.push(inChunk);
		inChunk = 0;
	};

	for (const row of stmt.iterate(...params) as IterableIterator<{
		norm_id: string;
		block_id: string;
		vector: Buffer;
	}>) {
		articles.push({ normId: row.norm_id, blockId: row.block_id });

		// Copy vector into current chunk, computing norm inline.
		const rowVector = new Float32Array(
			row.vector.buffer,
			row.vector.byteOffset,
			dims,
		);
		const offset = inChunk * dims;
		let sum = 0;
		for (let j = 0; j < dims; j++) {
			const v = rowVector[j] ?? 0;
			chunkVecs[offset + j] = v;
			sum += v * v;
		}
		chunkNorms[inChunk] = Math.sqrt(sum);
		inChunk++;
		loaded++;

		if (inChunk >= vectorsPerChunk) {
			flushChunk();
			const remaining = totalCount - loaded;
			const nextSize = Math.min(vectorsPerChunk, remaining);
			if (nextSize > 0) {
				chunkVecs = new Float32Array(nextSize * dims);
				chunkNorms = new Float32Array(nextSize);
			}
		}
	}
	flushChunk();

	return {
		meta: articles,
		vectors: {
			kind: "f32" as const,
			chunks,
			int8Chunks: [],
			scalesPerChunk: [],
			vectorsPerChunk: vpc,
			normsPerChunk,
			totalVectors: loaded,
			dim: dims,
		},
		dims,
	};
}

// ── Args ──

const args = process.argv.slice(2);
const openRouterKey = process.env.OPENROUTER_API_KEY;
// nan.builders uses HERMES_API_KEY (not NAN_API_KEY)
const nanApiKey = process.env.HERMES_API_KEY;
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;
const onlyLocal = args.includes("--only-local");
// Phase 3: full-corpus eval (no qwenNormIds filter on Gemini, all 50 queries)
const fullCorpus = args.includes("--full");
// Ablation: run Qwen without Instruct prefix to isolate prompt contribution
const QWEN_USE_INSTRUCT = !args.includes("--no-instruct");
// Phase 3: full-corpus eval OOMs when both indexes live in memory simultaneously.
// Use --only-gemini / --only-qwen to run each pass in its own process.
// Per-model results are persisted to JSON; the final pass merges and reports.
const onlyGemini = args.includes("--only-gemini");
const onlyQwen = args.includes("--only-qwen");
// Phase 4: HyDE — pre-rewrite queries to legal jargon before embedding.
const useHyde = args.includes("--hyde");
// Optional override of the HyDE cache file (relative to outDir).
const hydeCacheArg = args.indexOf("--hyde-cache");
const hydeCacheName =
	hydeCacheArg >= 0 ? args[hydeCacheArg + 1]! : "hyde-cache.json";
// Phase 4: search the citizen-summary embedding store instead of raw-text.
const useSummaryIndex = args.includes("--summary-index");
// Phase 4: multi-vector — score = max(raw_score, summary_score) per article.
const useMultiVector = args.includes("--multi-vector");
// Phase 5: NaN-only stack — replace OpenRouter analyzer with qwen3.6 NaN.
const useNanAnalyzer = args.includes("--nan-analyzer");
// Phase 5: NaN-only stack — replace Cohere/OpenRouter rerank with qwen3.6 NaN.
const useNanRerank = args.includes("--nan-rerank");
// Tag for output files (separates each variant's saved results). The harness
// auto-derives a base tag from active flags; --tag adds an extra suffix only
// when explicitly given.
const tagParts: string[] = [QWEN_USE_INSTRUCT ? "instruct" : "no-instruct"];
if (useHyde) tagParts.push("hyde");
if (useSummaryIndex) tagParts.push("summary");
if (useMultiVector) tagParts.push("multi");
if (useNanAnalyzer) tagParts.push("nan-analyzer");
if (useNanRerank) tagParts.push("nan-rerank");
const variantTagArg = args.indexOf("--tag");
if (variantTagArg >= 0) {
	const t = args[variantTagArg + 1]!;
	// Avoid duplicates: if the user passed --tag with a part already auto-added
	// (e.g. --hyde --tag hyde), don't re-append.
	if (!tagParts.includes(t)) tagParts.push(t);
}
const tag = tagParts.join("-");

// ── Paths ──

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
// Allow overriding the eval dataset (e.g. --dataset packages/api/research/datasets/citizen-queries-v3.json).
// Default keeps the legacy path so existing scripts/CI runs are unchanged.
const datasetArgIdx = args.indexOf("--dataset");
const datasetArg = datasetArgIdx >= 0 ? args[datasetArgIdx + 1] : undefined;
const evalPath = datasetArg
	? datasetArg.startsWith("/")
		? datasetArg
		: join(repoRoot, datasetArg)
	: join(repoRoot, "packages/api/research/datasets/citizen-queries.json");
const outDir = join(repoRoot, "data", "ab-results");
await Bun.write(`${outDir}/.keep`, "");

// ── HyDE cache ──
let hydeCache: Record<string, string> = {};
if (useHyde) {
	const hydeFile = Bun.file(`${outDir}/${hydeCacheName}`);
	if (await hydeFile.exists()) {
		hydeCache = (await hydeFile.json()) as Record<string, string>;
		console.log(
			`Loaded HyDE cache: ${Object.keys(hydeCache).length} rewrites (${hydeCacheName})`,
		);
	} else {
		console.warn(
			`--hyde requires ${outDir}/${hydeCacheName} — run precompute-hyde.ts first`,
		);
	}
}

// ── DB ──

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// ── Load eval set ──

interface EvalQuery {
	// v3 dataset uses string ids ("q_d08970e3"); legacy citizen-queries.json uses numbers.
	id: number | string;
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

// Always use the FULL raw-text Qwen scope as the BM25 haystack so that
// summary-index variants are comparable against Gemini's full coverage. The
// vector index of summary-index variants may be smaller (partial embed); the
// retrieval simply returns no vector hit for un-embedded norms, while BM25
// still searches the full 9.7k corpus through embeddedNormIds.
const qwenNormIds = db
	.query<{ norm_id: string }, [string]>(
		"SELECT DISTINCT norm_id FROM embeddings WHERE model = ?",
	)
	.all("qwen3-nan")
	.map((r) => r.norm_id);
const summaryNormCount = useSummaryIndex
	? (db
			.query<{ c: number }, [string]>(
				"SELECT COUNT(DISTINCT norm_id) as c FROM embeddings WHERE model = ?",
			)
			.get("qwen3-nan-summary")?.c ?? 0)
	: 0;
console.log(
	`Qwen-NAN BM25/RRF haystack: ${qwenNormIds.length} norms` +
		(useSummaryIndex
			? ` · summary vector index: ${summaryNormCount} norms`
			: ""),
);

// Find queries fully covered by Qwen-NAN (all expectedNorms in store)
const qwenNormSet = new Set(qwenNormIds);
const coveredQueriesSubset = questions.filter((q) =>
	q.expectedNorms?.every((n) => qwenNormSet.has(n)),
);
console.log(
	`Fully covered by Qwen-NAN: ${coveredQueriesSubset.length} / ${questions.length}`,
);
// Phase 3: --full uses ALL queries with full haystack (Qwen now covers same scope as Gemini)
const coveredQueries = fullCorpus ? questions : coveredQueriesSubset;
console.log(
	`Eval mode: ${fullCorpus ? "FULL corpus" : "Qwen-NAN subset"} → ${coveredQueries.length} queries`,
);
console.log(
	`Qwen prompt: ${QWEN_USE_INSTRUCT ? "WITH Instruct prefix" : "NO instruct (ablation)"}`,
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

// Phase 1/2: restrict both indexes to the norms covered by Qwen-NAN (subset).
// Phase 3 (--full): no restriction — Qwen now covers same scope as Gemini, but
// loading both indexes simultaneously OOMs (~13 GB combined). We build & evaluate
// one model at a time, freeing the index between passes.
const haystackFilter = fullCorpus ? undefined : qwenNormIds;

// ── Run eval ──

type QueryResult = {
	id: number | string;
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

const _results: QueryResult[] = [];

async function runVariant(
	question: EvalQuery,
	modelKey: string,
	index: NonNullable<Awaited<ReturnType<typeof buildModelIndex>>>,
	embedFn: EmbedQueryFn,
): Promise<QueryResult> {
	// HyDE: keep the original question for BM25/analyzer (preserves citizen
	// keywords and category hints), but swap in the legal-jargon rewrite for
	// the vector embedding. The composed-query approach (original + rewrite)
	// in earlier iterations diluted BM25 keyword extraction (analyzer pulls
	// generic "responsabilidad civil", "obligación" terms).
	let effectiveEmbedFn = embedFn;
	if (useHyde && hydeCache[question.question]) {
		const rewrite = hydeCache[question.question];
		// HyDE substitution mode: depending on env, use rewrite-only,
		// composed (orig + rewrite), or hybrid (rewrite alone for embedding).
		const mode = process.env.HYDE_MODE ?? "embed-rewrite-only";
		const textForEmbed =
			mode === "composed"
				? `${question.question}\n\n${rewrite}`
				: mode === "embed-rewrite-only"
					? rewrite!
					: question.question;
		effectiveEmbedFn = async (k, m, _q) => embedFn(k, m, textForEmbed);
	}

	// Optional analyzer override (qwen3.6 via NaN instead of OpenRouter).
	const analyzerOverrides = useNanAnalyzer
		? {
				apiKey: nanApiKey!,
				model: "qwen3.6",
				llmFn:
					callNan as import("../../src/services/rag/analyzer.ts").AnalyzerLlmFn,
			}
		: undefined;
	// Optional reranker override (qwen3.6 LLM rerank via NaN).
	const rerankerOverrides = useNanRerank
		? {
				nanApiKey: nanApiKey!,
				preferredBackend: "nan-llm" as const,
			}
		: undefined;

	const opts: Omit<RunRetrievalCoreOpts, "db" | "apiKey" | "cohereApiKey"> = {
		embeddingModelKey: modelKey,
		embedQueryFn: effectiveEmbedFn,
		// Disable low-confidence gate: Qwen and Gemini cosine score scales differ.
		// We compare retrieval quality, not the prod confidence calibration.
		lowConfidenceThreshold: 0,
		question: question.question,
		requestJurisdiction: undefined,
		// In --full mode Qwen covers same scope as Gemini, so qwenNormIds is the full haystack.
		embeddedNormIds: qwenNormIds,
		vectorIndex: {
			meta: index.meta,
			vectors: index.vectors,
			dims: index.dims,
		},
		analyzerOverrides,
		rerankerOverrides,
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
	const _allFused = result.type === "ready" ? result.allFusedArticles : [];

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
	console.error(
		"HERMES_API_KEY required for Qwen-NAN variant (or use --only-local)",
	);
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

// File paths for per-pass result persistence (Phase 3 split).
// Gemini pass is invariant across Qwen-side variants (HyDE / summary / multi
// only affect Qwen's query and index), so we cache it under a stable name and
// reuse across runs. Qwen pass uses the full variant tag.
const geminiPassFile = `${outDir}/eval-pass-gemini-baseline.json`;
const qwenPassFile = `${outDir}/eval-pass-qwen-${tag}.json`;

let geminiDims = 0;
let geminiTotal = 0;
let qwenDims = 0;
let qwenTotal = 0;

if (!onlyQwen) {
	console.log(
		`\n== Pass 1: Gemini (${fullCorpus ? "FULL corpus" : "subset"}) ==`,
	);
	console.log("  Building Gemini vector index...");
	_resetSharedVectorIndexForTests();
	const geminiIndex = await buildModelIndex(
		db,
		"gemini-embedding-2",
		join(repoRoot, "data"),
		haystackFilter,
	);
	if (!geminiIndex) {
		console.error("FATAL: Could not build Gemini index");
		process.exit(1);
	}
	console.log(
		`  Gemini: ${geminiIndex.vectors.totalVectors} vectors, ${geminiIndex.dims} dims`,
	);
	geminiDims = geminiIndex.dims;
	geminiTotal = geminiIndex.vectors.totalVectors;

	for (let i = 0; i < coveredQueries.length; i++) {
		const q = coveredQueries[i]!;
		const pct = (((i + 1) / coveredQueries.length) * 100).toFixed(0);
		process.stdout.write(
			`\r  Gemini progress: ${i + 1}/${coveredQueries.length} (${pct}%)   `,
		);
		const gResult = await runVariant(
			q,
			"gemini-embedding-2",
			geminiIndex,
			geminiEmbedFn,
		);
		geminiResults.push(gResult);
	}
	console.log("\n");

	await Bun.write(
		geminiPassFile,
		JSON.stringify(
			{ dims: geminiDims, total: geminiTotal, results: geminiResults },
			null,
			2,
		),
	);
	console.log(`  Saved Gemini pass results → ${geminiPassFile}`);

	shutdownVectorPool();
	_resetSharedVectorIndexForTests();
}

if (onlyGemini) {
	console.log(
		"\nDone Gemini pass. Run again with --only-qwen to complete the eval.",
	);
	db.close();
	process.exit(0);
}

// If we skipped Pass 1, load saved Gemini results from disk.
if (onlyQwen) {
	const file = Bun.file(geminiPassFile);
	if (!(await file.exists())) {
		console.error(
			`FATAL: --only-qwen requires ${geminiPassFile} (run --only-gemini first)`,
		);
		process.exit(1);
	}
	const saved = (await file.json()) as {
		dims: number;
		total: number;
		results: QueryResult[];
	};
	geminiDims = saved.dims;
	geminiTotal = saved.total;
	geminiResults.push(...saved.results);
	console.log(
		`Loaded Gemini pass from disk: ${geminiResults.length} results, ${geminiTotal} vectors`,
	);
}

console.log(
	`\n== Pass 2: Qwen-NAN (${fullCorpus ? "FULL corpus" : "subset"}) ==`,
);
console.log("  Building Qwen-NAN vector index...");
const qwenModelKey = useSummaryIndex ? "qwen3-nan-summary" : "qwen3-nan";
const qwenIndex = await buildModelIndex(
	db,
	qwenModelKey,
	join(repoRoot, "data"),
	haystackFilter,
);
if (!qwenIndex) {
	console.error("FATAL: Could not build Qwen index");
	process.exit(1);
}
console.log(
	`  Qwen-NAN: ${qwenIndex.vectors.totalVectors} vectors, ${qwenIndex.dims} dims`,
);
qwenDims = qwenIndex.dims;
qwenTotal = qwenIndex.vectors.totalVectors;

for (let i = 0; i < coveredQueries.length; i++) {
	const q = coveredQueries[i]!;
	const pct = (((i + 1) / coveredQueries.length) * 100).toFixed(0);
	process.stdout.write(
		`\r  Qwen progress: ${i + 1}/${coveredQueries.length} (${pct}%)   `,
	);
	const qResult = await runVariant(
		q,
		qwenModelKey,
		qwenIndex,
		qwenOpenRouterEmbedQuery,
	);
	qwenResults.push(qResult);
}
console.log("\n");

await Bun.write(
	qwenPassFile,
	JSON.stringify(
		{ dims: qwenDims, total: qwenTotal, results: qwenResults },
		null,
		2,
	),
);
console.log(`  Saved Qwen pass results → ${qwenPassFile}`);

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
		r1: ((hits1 / total) * 100).toFixed(1),
		r5: ((hits5 / total) * 100).toFixed(1),
		r10: ((hits10 / total) * 100).toFixed(1),
		mrr: mrr.toFixed(3),
	};
}

const geminiMetrics = computeMetrics(geminiResults);
const qwenMetrics = computeMetrics(qwenResults);

// ── Report ──

console.log(`\n${"=".repeat(70)}`);
console.log("PHASE 1 EVAL RESULTS — End-to-End Prod Replica");
console.log("=".repeat(70));
console.log(
	`Queries evaluated: ${coveredQueries.length} (fully covered by Qwen-NAN)`,
);
console.log(`Gemini index: ${geminiTotal} vectors, ${geminiDims} dims`);
console.log(`Qwen-NAN index: ${qwenTotal} vectors, ${qwenDims} dims`);
console.log(`Cohere reranker: disabled (--cohere-api-key not set)`);
console.log(`\n${"-".repeat(70)}`);
console.log("Metrics (hit@K on articles — post-rerank):");
console.log("-".repeat(70));
console.log(`Model          R@1      R@5      R@10     MRR@10`);
console.log(
	`Gemini-2       ${geminiMetrics.r1.padStart(6)}%   ${geminiMetrics.r5.padStart(6)}%   ${geminiMetrics.r10.padStart(6)}%   ${geminiMetrics.mrr.padStart(6)}`,
);
console.log(
	`Qwen-NAN       ${qwenMetrics.r1.padStart(6)}%   ${qwenMetrics.r5.padStart(6)}%   ${qwenMetrics.r10.padStart(6)}%   ${qwenMetrics.mrr.padStart(6)}`,
);

const gapR1 = parseFloat(geminiMetrics.r1) - parseFloat(qwenMetrics.r1);
const gapR5 = parseFloat(geminiMetrics.r5) - parseFloat(qwenMetrics.r5);
const gapR10 = parseFloat(geminiMetrics.r10) - parseFloat(qwenMetrics.r10);

console.log(`\n${"-".repeat(70)}`);
console.log("Gaps (Gemini - Qwen):");
console.log("-".repeat(70));
console.log(`  R@1 gap:   ${gapR1.toFixed(1)} pp`);
console.log(`  R@5 gap:   ${gapR5.toFixed(1)} pp`);
console.log(`  R@10 gap:  ${gapR10.toFixed(1)} pp`);

// Decision gate
console.log(`\n${"=".repeat(70)}`);
console.log("DECISION GATE — Phase 1");
console.log("=".repeat(70));
if (gapR1 <= 3) {
	console.log(
		"GAP ≤ 3pp → PROCEED to Phase 2 (pilot embed for remaining queries)",
	);
} else if (gapR1 > 5) {
	console.log("GAP > 5pp → SKIP to Phase 4 (interventions), no pilot embed");
} else {
	console.log("GAP 3-5pp → DISCUSS before proceeding");
}

// ── Per-question miss analysis ──

console.log(`\n${"=".repeat(70)}`);
console.log("PER-QUESTION MISS ANALYSIS (where Qwen misses but Gemini hits)");
console.log("=".repeat(70));

const _misses = qwenResults.filter((_q, i) =>
	qwenResults[i]!.hitsAt1 && !geminiResults[i]!.hitsAt1
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
	console.log(
		`\n  ${qwenMisses.length} queries where Gemini hits@1 but Qwen misses:\n`,
	);
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
console.log(
	`\nFull report saved to ${outDir}/eval-prod-replica-${new Date().toISOString().slice(0, 10)}.json`,
);

// ── Cleanup ──

shutdownVectorPool();
db.close();
