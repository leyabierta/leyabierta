/**
 * Embeddings A/B (2026-05-01 redo): Gemini-2 (cached) vs local Qwen3-Embedding-8B
 * vs local embeddinggemma-300m, all running on the same gold set + corpus.
 *
 * Design:
 *  - Gemini-2 corpus embeddings already exist in the DB from the prior A/B.
 *  - Gemini-2 query embeddings are computed ONCE, cached to JSON, reused forever.
 *  - Local models (Qwen, Gemma) call llama-server /v1/embeddings on a port we control.
 *  - All variants run cosine search over the same 60.281-chunk filtered store.
 *
 * Pre-flight:
 *   1. Embed corpus for each local model:
 *        bun packages/api/research/ab/embed-corpus-llamacpp.ts --model qwen3-local-q8 --port 8090
 *        bun packages/api/research/ab/embed-corpus-llamacpp.ts --model embgemma-local --port 8091
 *   2. Start the right llama-server on the right port for the variant being run.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun packages/api/research/ab/eval-2026-05-local-vs-gemini.ts                    # all variants
 *   bun packages/api/research/ab/eval-2026-05-local-vs-gemini.ts --variants=A,G                            # subset
 *   bun packages/api/research/ab/eval-2026-05-local-vs-gemini.ts --variants=A --skip-local                 # Gemini only (uses cache)
 *   bun packages/api/research/ab/eval-2026-05-local-vs-gemini.ts --limit 20                                # smoke
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
import { matryoshkaTruncate } from "./ollama-embeddings.ts";

// ── Args ──
const args = process.argv.slice(2);
function arg(name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}
const variantsArg = args.find((a) => a.startsWith("--variants="));
const variantFilter = variantsArg
	? new Set(variantsArg.split("=")[1]!.split(","))
	: null;
const skipLocal = args.includes("--skip-local");
const limitArg = arg("--limit");
const limit = limitArg ? Number(limitArg) : undefined;
const qwenPort = Number(arg("--qwen-port") ?? "8090");
const gemmaPort = Number(arg("--gemma-port") ?? "8091");

// ── Paths ──
const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const evalPath = join(repoRoot, "data", "eval-answers-504-omnibus.json");
const outDir = join(repoRoot, "data", "ab-results");
const geminiCachePath = join(outDir, "gemini-query-embeddings.json");
await Bun.write(`${outDir}/.keep`, "");

// ── DB ──
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// ── Gold set ──
interface EvalQ {
	id: number;
	question: string;
	expectedNorms?: string[];
}
const evalData = (await Bun.file(evalPath).json()) as { results: EvalQ[] };
let questions = evalData.results.filter(
	(r) => (r.expectedNorms?.length ?? 0) > 0,
);
if (limit) questions = questions.slice(0, limit);
console.log(`Gold set: ${questions.length} questions`);

// ── Query embedders ──

/**
 * Gemini-2 with the production prefix. Caches all 65 queries to disk on first run.
 */
async function loadGeminiQueries(): Promise<Map<number, Float32Array>> {
	const cache = new Map<number, Float32Array>();
	if (await Bun.file(geminiCachePath).exists()) {
		const raw = (await Bun.file(geminiCachePath).json()) as Record<
			string,
			number[]
		>;
		for (const [id, vec] of Object.entries(raw)) {
			cache.set(Number(id), new Float32Array(vec));
		}
		console.log(`  Loaded ${cache.size} cached Gemini query embeddings.`);
	}

	const missing = questions.filter((q) => !cache.has(q.id));
	if (missing.length === 0) return cache;

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		throw new Error(
			`Need OPENROUTER_API_KEY to embed ${missing.length} missing Gemini queries (cache: ${geminiCachePath}).`,
		);
	}
	console.log(`  Embedding ${missing.length} missing Gemini queries...`);
	const model = EMBEDDING_MODELS["gemini-embedding-2"]!;
	for (const q of missing) {
		const input = `task: question answering | query: ${q.question}`;
		const res = await fetchWithRetry(apiKey, model.id, input);
		const data = (await res.json()) as {
			data: Array<{ embedding: number[] }>;
		};
		const vec = new Float32Array(data.data[0]!.embedding);
		cache.set(q.id, vec);
	}
	// Save cache
	const obj: Record<string, number[]> = {};
	for (const [id, vec] of cache.entries()) {
		obj[id] = Array.from(vec);
	}
	await Bun.write(geminiCachePath, JSON.stringify(obj));
	console.log(`  ✓ Cached ${cache.size} Gemini queries → ${geminiCachePath}`);
	return cache;
}

/**
 * Local llama-server with Qwen3 instruction prefix.
 */
function qwen3Prefix(q: string): string {
	return `Instruct: Given a Spanish citizen's legal question, retrieve the article of Spanish law that best answers it.\nQuery: ${q}`;
}

/**
 * embeddinggemma uses a different documented prefix per model card.
 * From Google Gemma docs: "task: search result | query: <text>" for retrieval.
 * See: https://huggingface.co/google/embeddinggemma-300m
 */
function gemmaQueryPrefix(q: string): string {
	return `task: search result | query: ${q}`;
}

async function embedLocal(
	port: number,
	modelKey: string,
	text: string,
): Promise<Float32Array> {
	const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: modelKey, input: text }),
	});
	if (!res.ok) {
		throw new Error(
			`local ${port}: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
		);
	}
	const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
	return new Float32Array(data.data[0]!.embedding);
}

// ── Variants ──
interface Variant {
	id: string;
	label: string;
	corpusModel: string; // DB model key for stored corpus vectors
	embedQuery: (q: EvalQ) => Promise<Float32Array>;
	truncateTo?: number; // MRL target dim
	requiresLocal: boolean;
}

let geminiQueries: Map<number, Float32Array> | null = null;

const ALL_VARIANTS: Variant[] = [
	{
		id: "A",
		label: "Gemini-2 + task prefix (production baseline)",
		corpusModel: "gemini-embedding-2",
		embedQuery: async (q) => {
			if (!geminiQueries) geminiQueries = await loadGeminiQueries();
			return geminiQueries.get(q.id)!;
		},
		requiresLocal: false,
	},
	{
		id: "G",
		label: "Qwen3-Embedding-8B local Q8_0 + Instruct (EN)",
		corpusModel: "qwen3-local-q8",
		embedQuery: (q) =>
			embedLocal(qwenPort, "qwen3-local-q8", qwen3Prefix(q.question)),
		requiresLocal: true,
	},
	{
		id: "H",
		label: "Qwen3 local + Instruct + MRL@2048",
		corpusModel: "qwen3-local-q8",
		embedQuery: (q) =>
			embedLocal(qwenPort, "qwen3-local-q8", qwen3Prefix(q.question)),
		truncateTo: 2048,
		requiresLocal: true,
	},
	{
		id: "I",
		label: "Qwen3 local + Instruct + MRL@1024",
		corpusModel: "qwen3-local-q8",
		embedQuery: (q) =>
			embedLocal(qwenPort, "qwen3-local-q8", qwen3Prefix(q.question)),
		truncateTo: 1024,
		requiresLocal: true,
	},
	{
		id: "M",
		label: "embeddinggemma-300m local BF16 + task: search result",
		corpusModel: "embgemma-local",
		embedQuery: (q) =>
			embedLocal(gemmaPort, "embgemma-local", gemmaQueryPrefix(q.question)),
		requiresLocal: true,
	},
	{
		id: "N",
		label: "embeddinggemma-300m local BF16 + task: question answering",
		corpusModel: "embgemma-local",
		embedQuery: (q) =>
			embedLocal(
				gemmaPort,
				"embgemma-local",
				`task: question answering | query: ${q.question}`,
			),
		requiresLocal: true,
	},
];

const activeVariants = ALL_VARIANTS.filter((v) => {
	if (variantFilter && !variantFilter.has(v.id)) return false;
	if (skipLocal && v.requiresLocal) return false;
	return true;
});
console.log(`Active variants: ${activeVariants.map((v) => v.id).join(", ")}`);

// ── Corpus plan + stores ──
console.log("Building corpus plan...");
const plan = await buildCorpusPlan(db);
console.log(
	`  Corpus: ${plan.normIds.length} norms, ${plan.counts.chunks} chunks`,
);

function loadFilteredStore(
	modelKey: string,
	normIds: string[],
): EmbeddingStore | null {
	const m = EMBEDDING_MODELS[modelKey];
	if (!m) return null;
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
	const dims = m.dimensions;
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

const stores: Record<string, EmbeddingStore> = {};
for (const v of activeVariants) {
	if (stores[v.corpusModel]) continue;
	console.log(`Loading corpus for ${v.corpusModel}...`);
	const s = loadFilteredStore(v.corpusModel, plan.normIds);
	if (!s) {
		console.error(
			`  ✗ No embeddings for "${v.corpusModel}". Run embed-corpus-llamacpp.ts first.`,
		);
		process.exit(1);
	}
	const uniqueNorms = new Set(s.articles.map((a) => a.normId)).size;
	console.log(
		`  ${s.count} vectors (${s.dimensions} dims) from ${uniqueNorms} norms`,
	);
	stores[v.corpusModel] = s;
}

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
		norms[i] = 1;
		if (n > 0) {
			for (let j = 0; j < targetDim; j++)
				vectors[i * targetDim + j] = vectors[i * targetDim + j]! / n;
		}
	}
	return {
		model: `${s.model}-mrl${targetDim}`,
		dimensions: targetDim,
		count: s.count,
		articles: s.articles,
		vectors,
		norms,
	};
}

const mrlStores: Record<string, EmbeddingStore> = {};
for (const v of activeVariants) {
	if (!v.truncateTo) continue;
	const key = `${v.corpusModel}-mrl${v.truncateTo}`;
	if (mrlStores[key]) continue;
	console.log(`Building MRL@${v.truncateTo} of ${v.corpusModel}...`);
	mrlStores[key] = truncateStore(stores[v.corpusModel]!, v.truncateTo);
}

// ── Eval ──
interface VariantResult {
	variant: string;
	label: string;
	perQuestion: Array<{
		id: number;
		question: string;
		expectedNorms: string[];
		hitRank: number | null;
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
	const baseStore = stores[v.corpusModel]!;
	const searchStore = v.truncateTo
		? mrlStores[`${v.corpusModel}-mrl${v.truncateTo}`]!
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
		let qVec = await v.embedQuery(q);
		if (v.truncateTo) qVec = matryoshkaTruncate(qVec, v.truncateTo);
		const latency = Date.now() - t0;
		latencySum += latency;

		const results = vectorSearch(qVec, searchStore, 60);
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

console.log(`\n${"=".repeat(100)}`);
console.log("SUMMARY");
console.log("=".repeat(100));
console.log(`Var  ${"Label".padEnd(50)}R@1   R@5   R@10  R@60  MRR@10 Latency`);
for (const r of allResults) {
	console.log(
		`${r.variant}    ` +
			r.label.padEnd(50) +
			`${(r.aggregate.recallAt1 * 100).toFixed(1).padStart(5)} ${(r.aggregate.recallAt5 * 100).toFixed(1).padStart(5)} ${(r.aggregate.recallAt10 * 100).toFixed(1).padStart(5)} ${(r.aggregate.recallAt60 * 100).toFixed(1).padStart(5)} ${r.aggregate.mrrAt10.toFixed(3).padStart(6)} ${r.aggregate.avgQueryLatencyMs.toFixed(0).padStart(5)}ms`,
	);
}

const outPath = `${outDir}/eval-2026-05-${Date.now()}.json`;
await Bun.write(
	outPath,
	JSON.stringify({ questions: questions.length, results: allResults }, null, 2),
);
console.log(`\nResults saved to ${outPath}`);

db.close();
