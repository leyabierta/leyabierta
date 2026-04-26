/**
 * A/B evaluation harness for embeddings.
 *
 * Reads ground-truth from data/eval-answers-504-omnibus.json (65 Q with
 * expectedNorms). For each variant, embeds the query, runs cosine-similarity
 * over the model's stored vectors, and computes norm-level retrieval metrics.
 *
 * Metrics (norm-level, because the eval set only has expectedNorms not article IDs):
 *   - Recall@1: did any chunk of the expected norm land at rank 1?
 *   - Recall@5 / @10 / @60: same but within top-K (RRF pool, rerank pool)
 *   - MRR@10: mean reciprocal rank of the first expected-norm hit
 *
 * Variants compared (each is a model_key + query transform + optional MRL trunc):
 *   A. Gemini-2 + "task: question answering | query:" prefix  (production)
 *   B. Gemini-2 raw query (ablation)
 *   C. Qwen3-8B raw query, raw doc (baseline local)
 *   D. Qwen3-8B Instruct prefix on query, raw doc (Qwen3-recommended)
 *   E. Qwen3-8B Instruct + Matryoshka @2048
 *   F. Qwen3-8B Instruct + Matryoshka @1024
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun packages/api/research/ab/eval-ab.ts
 *   OPENROUTER_API_KEY=... bun packages/api/research/ab/eval-ab.ts --variants=A,D,E
 *   bun packages/api/research/ab/eval-ab.ts --only-local   # skip Gemini (requires API key)
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "../../../pipeline/src/db/schema.ts";
import {
	EMBEDDING_MODELS,
	type EmbeddingStore,
	fetchWithRetry,
	vectorSearch,
} from "../../src/services/rag/embeddings.ts";
import { buildCorpusPlan } from "./corpus.ts";
import { matryoshkaTruncate, qwen3QueryPrefix } from "./ollama-embeddings.ts";

const QWEN3_KEY = "qwen3"; // OpenRouter qwen/qwen3-embedding-8b (already registered)

/**
 * Load embeddings for ONE model, restricted to a set of norm_ids.
 * Avoids OOM when the production Gemini store (484k vectors @ 3072 dims ≈ 5.7 GB)
 * would exceed Bun's ArrayBuffer cap. We only need the A/B corpus (~60k vectors).
 */
function loadFilteredStore(
	db: Database,
	modelKey: string,
	normIds: string[],
): EmbeddingStore | null {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) return null;
	const ph = normIds.map(() => "?").join(",");
	const rows = db
		.query<{ norm_id: string; block_id: string; vector: Buffer }, string[]>(
			`SELECT norm_id, block_id, vector
			 FROM embeddings
			 WHERE model = ? AND norm_id IN (${ph})
			 ORDER BY norm_id, block_id`,
		)
		.all(modelKey, ...normIds);
	if (rows.length === 0) return null;

	const dims = model.dimensions;
	const count = rows.length;
	const articles: Array<{ normId: string; blockId: string }> = [];
	const vectors = new Float32Array(count * dims);
	const norms = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		const row = rows[i]!;
		articles.push({ normId: row.norm_id, blockId: row.block_id });
		const rv = new Float32Array(row.vector.buffer, row.vector.byteOffset, dims);
		vectors.set(rv, i * dims);
		let sum = 0;
		for (let j = 0; j < dims; j++) sum += rv[j]! * rv[j]!;
		norms[i] = Math.sqrt(sum);
	}
	return { model: modelKey, dimensions: dims, count, articles, vectors, norms };
}

// ── Args ──
const args = process.argv.slice(2);
const variantsArg = args.find((a) => a.startsWith("--variants="));
const variantFilter = variantsArg
	? new Set(variantsArg.split("=")[1]!.split(","))
	: null;
const onlyLocal = args.includes("--only-local");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;

// ── Paths ──
const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const evalPath = join(repoRoot, "data", "eval-answers-504-omnibus.json");
const outDir = join(repoRoot, "data", "ab-results");
await Bun.write(`${outDir}/.keep`, ""); // mkdir

// ── DB ──
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// ── Load gold set ──
interface EvalResult {
	id: number;
	question: string;
	expectedNorms?: string[];
}
const evalData = (await Bun.file(evalPath).json()) as { results: EvalResult[] };
let questions = evalData.results.filter(
	(r) => (r.expectedNorms?.length ?? 0) > 0,
);
if (limit) questions = questions.slice(0, limit);
console.log(`Gold set: ${questions.length} questions`);

// ── Query embedders ──
const OR_KEY = process.env.OPENROUTER_API_KEY;

async function embedGemini(
	q: string,
	withPrefix: boolean,
): Promise<Float32Array> {
	if (!OR_KEY)
		throw new Error("OPENROUTER_API_KEY required for Gemini variants");
	const model = EMBEDDING_MODELS["gemini-embedding-2"]!;
	const input = withPrefix ? `task: question answering | query: ${q}` : q;
	const res = await fetchWithRetry(OR_KEY, model.id, input);
	const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
	return new Float32Array(data.data[0]!.embedding);
}

async function embedQwen3(
	q: string,
	withInstruct: boolean,
): Promise<Float32Array> {
	if (!OR_KEY)
		throw new Error("OPENROUTER_API_KEY required for Qwen3 variants");
	const input = withInstruct ? qwen3QueryPrefix(q) : q;
	const res = await fetchWithRetry(
		OR_KEY,
		EMBEDDING_MODELS[QWEN3_KEY]!.id,
		input,
	);
	const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
	return new Float32Array(data.data[0]!.embedding);
}

// ── Variant definitions ──
interface Variant {
	id: string;
	label: string;
	modelKey: string; // which stored vectors to search against
	embedQuery: (q: string) => Promise<Float32Array>;
	truncateTo?: number; // Matryoshka target dim
	requiresOpenrouter: boolean;
}

const ALL_VARIANTS: Variant[] = [
	{
		id: "A",
		label: "Gemini-2 + task prefix (production)",
		modelKey: "gemini-embedding-2",
		embedQuery: (q) => embedGemini(q, true),
		requiresOpenrouter: true,
	},
	{
		id: "B",
		label: "Gemini-2 raw query (ablation)",
		modelKey: "gemini-embedding-2",
		embedQuery: (q) => embedGemini(q, false),
		requiresOpenrouter: true,
	},
	{
		id: "C",
		label: "Qwen3-8B raw query",
		modelKey: QWEN3_KEY,
		embedQuery: (q) => embedQwen3(q, false),
		requiresOpenrouter: true,
	},
	{
		id: "D",
		label: "Qwen3-8B + Instruct prefix",
		modelKey: QWEN3_KEY,
		embedQuery: (q) => embedQwen3(q, true),
		requiresOpenrouter: true,
	},
	{
		id: "E",
		label: "Qwen3-8B + Instruct + MRL@2048",
		modelKey: QWEN3_KEY,
		embedQuery: (q) => embedQwen3(q, true),
		truncateTo: 2048,
		requiresOpenrouter: true,
	},
	{
		id: "F",
		label: "Qwen3-8B + Instruct + MRL@1024",
		modelKey: QWEN3_KEY,
		embedQuery: (q) => embedQwen3(q, true),
		truncateTo: 1024,
		requiresOpenrouter: true,
	},
];

const activeVariants = ALL_VARIANTS.filter((v) => {
	if (variantFilter && !variantFilter.has(v.id)) return false;
	if (onlyLocal && v.requiresOpenrouter) return false;
	if (!OR_KEY && v.requiresOpenrouter) {
		console.log(`  (skipping ${v.id}: no OPENROUTER_API_KEY)`);
		return false;
	}
	return true;
});
console.log(`Active variants: ${activeVariants.map((v) => v.id).join(", ")}`);

// ── Build corpus plan (same 123 norms used for Qwen3 embedding)
//     so both models are compared over the SAME retrieval pool
console.log("Building corpus plan...");
const plan = await buildCorpusPlan(db);
console.log(
	`  Corpus: ${plan.normIds.length} norms (${plan.counts.chunks} expected chunks)`,
);

// ── Load stores (one per model_key, truncate is done on-the-fly) ──
const stores: Record<string, EmbeddingStore> = {};
for (const v of activeVariants) {
	if (stores[v.modelKey]) continue;
	console.log(`Loading store: ${v.modelKey}...`);
	const s = loadFilteredStore(db, v.modelKey, plan.normIds);
	if (!s) {
		console.error(`  ✗ No embeddings for ${v.modelKey} in DB.`);
		process.exit(1);
	}
	console.log(
		`  ${s.count} vectors (${s.dimensions} dims) from ${new Set(s.articles.map((a) => a.normId)).size} norms`,
	);
	stores[v.modelKey] = s;
}

// ── Truncate+renormalize a whole store to MRL dim N ──
function truncateStore(s: EmbeddingStore, targetDim: number): EmbeddingStore {
	const vectors = new Float32Array(s.count * targetDim);
	const norms = new Float32Array(s.count);
	for (let i = 0; i < s.count; i++) {
		const srcOff = i * s.dimensions;
		let sum = 0;
		for (let j = 0; j < targetDim; j++) {
			const v = s.vectors[srcOff + j]!;
			vectors[i * targetDim + j] = v;
			sum += v * v;
		}
		const n = Math.sqrt(sum);
		norms[i] = n;
		if (n > 0) {
			for (let j = 0; j < targetDim; j++) {
				vectors[i * targetDim + j] = vectors[i * targetDim + j]! / n;
			}
		}
	}
	// Recompute norms for renormalized vectors (should all be ~1)
	return {
		model: `${s.model}-mrl${targetDim}`,
		dimensions: targetDim,
		count: s.count,
		articles: s.articles,
		vectors,
		norms,
	};
}

// Pre-build truncated stores
const mrlStores: Record<string, EmbeddingStore> = {};
for (const v of activeVariants) {
	if (!v.truncateTo) continue;
	const key = `${v.modelKey}-mrl${v.truncateTo}`;
	if (mrlStores[key]) continue;
	console.log(`Building MRL@${v.truncateTo} of ${v.modelKey}...`);
	mrlStores[key] = truncateStore(stores[v.modelKey]!, v.truncateTo);
}

// ── Metric computation ──
interface VariantResult {
	variant: string;
	label: string;
	perQuestion: Array<{
		id: number;
		question: string;
		expectedNorms: string[];
		hitRank: number | null; // rank (1-indexed) of first expected norm in top-60
		topNorms: string[];
		latencyMs: number;
	}>;
	aggregate: {
		recallAt1: number;
		recallAt5: number;
		recallAt10: number;
		recallAt60: number;
		mrrAt10: number;
		avgQueryLatencyMs: number;
	};
}

async function evaluateVariant(v: Variant): Promise<VariantResult> {
	const baseStore = stores[v.modelKey]!;
	const searchStore = v.truncateTo
		? mrlStores[`${v.modelKey}-mrl${v.truncateTo}`]!
		: baseStore;

	const perQuestion: VariantResult["perQuestion"] = [];
	let latencySum = 0;
	let hits1 = 0,
		hits5 = 0,
		hits10 = 0,
		hits60 = 0,
		mrrSum = 0;

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const expected = new Set(q.expectedNorms!);

		const t0 = Date.now();
		let qVec = await v.embedQuery(q.question);
		if (v.truncateTo) qVec = matryoshkaTruncate(qVec, v.truncateTo);
		const latency = Date.now() - t0;
		latencySum += latency;

		const results = vectorSearch(qVec, searchStore, 60);
		// Find the rank of the first expected norm
		let hitRank: number | null = null;
		for (let r = 0; r < results.length; r++) {
			if (expected.has(results[r]!.normId)) {
				hitRank = r + 1;
				break;
			}
		}

		if (hitRank) {
			if (hitRank <= 1) hits1++;
			if (hitRank <= 5) hits5++;
			if (hitRank <= 10) {
				hits10++;
				mrrSum += 1 / hitRank;
			}
			if (hitRank <= 60) hits60++;
		}

		// Collect top unique norms for qualitative review
		const topNorms: string[] = [];
		const seen = new Set<string>();
		for (const r of results) {
			if (!seen.has(r.normId)) {
				seen.add(r.normId);
				topNorms.push(r.normId);
				if (topNorms.length >= 5) break;
			}
		}

		perQuestion.push({
			id: q.id,
			question: q.question,
			expectedNorms: q.expectedNorms!,
			hitRank,
			topNorms,
			latencyMs: latency,
		});

		if ((i + 1) % 10 === 0) {
			process.stdout.write(
				`\r  ${v.id} [${i + 1}/${questions.length}] R@1=${((hits1 / (i + 1)) * 100).toFixed(0)}% R@5=${((hits5 / (i + 1)) * 100).toFixed(0)}%`,
			);
		}
	}

	const n = questions.length;
	return {
		variant: v.id,
		label: v.label,
		perQuestion,
		aggregate: {
			recallAt1: hits1 / n,
			recallAt5: hits5 / n,
			recallAt10: hits10 / n,
			recallAt60: hits60 / n,
			mrrAt10: mrrSum / n,
			avgQueryLatencyMs: latencySum / n,
		},
	};
}

// ── Run all active variants ──
const allResults: VariantResult[] = [];
for (const v of activeVariants) {
	console.log(`\n=== Variant ${v.id}: ${v.label} ===`);
	const res = await evaluateVariant(v);
	allResults.push(res);
	process.stdout.write("\n");
	console.log(
		`  R@1=${(res.aggregate.recallAt1 * 100).toFixed(1)}%  ` +
			`R@5=${(res.aggregate.recallAt5 * 100).toFixed(1)}%  ` +
			`R@10=${(res.aggregate.recallAt10 * 100).toFixed(1)}%  ` +
			`R@60=${(res.aggregate.recallAt60 * 100).toFixed(1)}%  ` +
			`MRR@10=${res.aggregate.mrrAt10.toFixed(3)}  ` +
			`lat=${res.aggregate.avgQueryLatencyMs.toFixed(0)}ms`,
	);
}

// ── Summary table ──
console.log(`\n${"=".repeat(100)}`);
console.log("SUMMARY");
console.log("=".repeat(100));
console.log(`Var  ${"Label".padEnd(46)}R@1   R@5   R@10  R@60  MRR@10 Latency`);
for (const r of allResults) {
	console.log(
		`${r.variant}    ` +
			r.label.padEnd(46) +
			`${(r.aggregate.recallAt1 * 100).toFixed(1).padStart(5)} ${(r.aggregate.recallAt5 * 100).toFixed(1).padStart(5)} ${(r.aggregate.recallAt10 * 100).toFixed(1).padStart(5)} ${(r.aggregate.recallAt60 * 100).toFixed(1).padStart(5)} ${r.aggregate.mrrAt10.toFixed(3).padStart(6)} ${r.aggregate.avgQueryLatencyMs.toFixed(0).padStart(5)}ms`,
	);
}

// ── Save JSON ──
const outPath = `${outDir}/eval-${Date.now()}.json`;
await Bun.write(
	outPath,
	JSON.stringify({ questions: questions.length, results: allResults }, null, 2),
);
console.log(`\nResults saved to ${outPath}`);

db.close();
