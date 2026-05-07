/**
 * End-to-end A/B harness: Vector + BM25 → RRF → Cohere Rerank.
 *
 * This is the apples-to-apples production-equivalent comparison. eval-ab.ts
 * measures pure dense retrieval; this script measures what users actually see.
 *
 * Variants compared:
 *   A_e2e  — Gemini-2 (prod) → vector + BM25 + RRF + Cohere rerank
 *   L_e2e  — Qwen-NAN (modern-bias prompt) → same pipeline
 *
 * Optional flags: --variants=A_e2e,L_e2e --no-rerank --limit N
 *
 * Usage:
 *   set -a; source .env; set +a
 *   bun packages/api/research/ab/eval-hybrid-rerank.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "../../../pipeline/src/db/schema.ts";
import {
	bm25ArticleSearch,
	ensureBlocksFts,
} from "../../src/services/rag/blocks-fts.ts";
import {
	EMBEDDING_MODELS,
	type EmbeddingStore,
	fetchWithRetry,
	vectorSearch,
} from "../../src/services/rag/embeddings.ts";
import { rerank, type RerankerCandidate } from "../../src/services/rag/reranker.ts";
import { reciprocalRankFusion } from "../../src/services/rag/rrf.ts";
import { buildCorpusPlan } from "./corpus.ts";

// ── Config ──
const args = process.argv.slice(2);
const variantsArg = args.find((a) => a.startsWith("--variants="));
const variantFilter = variantsArg
	? new Set(variantsArg.split("=")[1]!.split(","))
	: null;
const noRerank = args.includes("--no-rerank");
const noBm25 = args.includes("--no-bm25");
const limitArg = args.indexOf("--limit");
const questionLimit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;
const poolArg = args.indexOf("--pool");
const userPool = poolArg >= 0 ? Number(args[poolArg + 1]) : undefined;

const POOL_VECTOR = 60;
const POOL_BM25 = 60;
const POOL_RRF = userPool ?? 30; // candidates passed to reranker
const TOP_K = 10; // final ranked output

const NAN_URL = "https://api.nan.builders/v1/embeddings";
const QWEN3_NAN_KEY = "qwen3-nan";

// ── Paths ──
const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const evalPath = join(repoRoot, "data", "eval-answers-504-omnibus.json");
const outDir = join(repoRoot, "data", "ab-results");
await Bun.write(`${outDir}/.keep`, "");

// ── DB ──
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);
ensureBlocksFts(db);

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
if (questionLimit) questions = questions.slice(0, questionLimit);
console.log(`Gold set: ${questions.length} questions`);

// ── API keys ──
const OR_KEY = process.env.OPENROUTER_API_KEY;
const NAN_KEY = process.env.NAN_API_KEY;
const COHERE_KEY = process.env.COHERE_API_KEY;
if (!OR_KEY) {
	console.error("OPENROUTER_API_KEY required (for Gemini variants and as rerank fallback)");
	process.exit(1);
}

// ── Query embedders ──
async function embedGemini(q: string): Promise<Float32Array> {
	const model = EMBEDDING_MODELS["gemini-embedding-2"]!;
	const input = `task: question answering | query: ${q}`;
	const res = await fetchWithRetry(OR_KEY!, model.id, input);
	const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
	return new Float32Array(data.data[0]!.embedding);
}

function qwenModernBiasPrompt(q: string): string {
	return `Instruct: Given a Spanish citizen's legal question, retrieve the article of Spanish law that best answers it. Prefer modern specific laws (Estatuto, LOPDGDD, LAU, LOE) over historical general codes (Código Civil, Código Penal, LECrim) when both apply.\nQuery: ${q}`;
}

async function embedQwenNan(q: string): Promise<Float32Array> {
	if (!NAN_KEY) throw new Error("NAN_API_KEY required");
	const body = JSON.stringify({
		model: EMBEDDING_MODELS[QWEN3_NAN_KEY]!.id,
		input: qwenModernBiasPrompt(q),
		encoding_format: "float",
	});
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt > 0) {
			await new Promise((r) =>
				setTimeout(r, 30_000 + Math.floor(Math.random() * 10_000)),
			);
		}
		try {
			const res = await fetch(NAN_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${NAN_KEY}`,
					"Content-Type": "application/json",
				},
				body,
				signal: AbortSignal.timeout(60_000),
			});
			if (res.status === 429 || res.status >= 500) continue;
			if (!res.ok) throw new Error(`nan ${res.status}: ${await res.text()}`);
			const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
			return new Float32Array(data.data[0]!.embedding);
		} catch {}
	}
	throw new Error("nan.builders embed failed after retries");
}

// ── Load embedding store ──
function loadStore(modelKey: string, normIds: string[]): EmbeddingStore {
	const model = EMBEDDING_MODELS[modelKey]!;
	const ph = normIds.map(() => "?").join(",");
	const rows = db
		.query<{ norm_id: string; block_id: string; vector: Buffer }, string[]>(
			`SELECT norm_id, block_id, vector
			 FROM embeddings
			 WHERE model = ? AND norm_id IN (${ph})
			 ORDER BY norm_id, block_id`,
		)
		.all(modelKey, ...normIds);
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
		let s = 0;
		for (let j = 0; j < dims; j++) s += rv[j]! * rv[j]!;
		norms[i] = Math.sqrt(s);
	}
	return { model: modelKey, dimensions: dims, count, articles, vectors, norms };
}

// ── Fetch block text for rerank candidates ──
const blockTextStmt = db.prepare<
	{ norm_id: string; block_id: string; title: string; text: string },
	[string, string]
>(
	`SELECT norm_id, block_id, title, current_text as text
	 FROM blocks
	 WHERE norm_id = ? AND block_id = ?`,
);

function getBlocks(
	keys: Array<{ normId: string; blockId: string }>,
): RerankerCandidate[] {
	return keys
		.map(({ normId, blockId }) => {
			const row = blockTextStmt.get(normId, blockId);
			if (!row || !row.text) return null;
			return {
				key: `${normId}:${blockId}`,
				title: row.title || normId,
				text: row.text.slice(0, 4000),
			};
		})
		.filter((x): x is RerankerCandidate => x !== null);
}

// ── Variants ──
interface Variant {
	id: string;
	label: string;
	modelKey: string;
	embed: (q: string) => Promise<Float32Array>;
}
const ALL: Variant[] = [
	{
		id: "A_e2e",
		label: "Gemini-2 prod + BM25 + RRF + Rerank",
		modelKey: "gemini-embedding-2",
		embed: embedGemini,
	},
	{
		id: "L_e2e",
		label: "Qwen-NAN modern-bias + BM25 + RRF + Rerank",
		modelKey: QWEN3_NAN_KEY,
		embed: embedQwenNan,
	},
];
const active = ALL.filter((v) => !variantFilter || variantFilter.has(v.id));
console.log(`Active: ${active.map((v) => v.id).join(", ")}`);
console.log(
	`Pipeline: vector(${POOL_VECTOR})${noBm25 ? "" : ` + BM25(${POOL_BM25})`} → ${noBm25 ? "vec-top" : "RRF"}(${POOL_RRF}) → ${noRerank ? "no rerank" : "Cohere rerank"} → top-${TOP_K}\n`,
);

// ── Corpus plan to restrict BM25 search ──
const plan = await buildCorpusPlan(db);
console.log(`Corpus: ${plan.normIds.length} norms\n`);

const stores: Record<string, EmbeddingStore> = {};
for (const v of active) {
	if (!stores[v.modelKey]) {
		console.log(`Loading store: ${v.modelKey}...`);
		stores[v.modelKey] = loadStore(v.modelKey, plan.normIds);
		console.log(
			`  ${stores[v.modelKey]!.count} vectors, ${stores[v.modelKey]!.dimensions}d`,
		);
	}
}

// ── Run a variant ──
interface PerQ {
	id: number;
	question: string;
	expectedNorms: string[];
	finalRanked: Array<{ key: string; normId: string }>;
	hitRank: number | null;
	bm25HitRank: number | null;
	vectorHitRank: number | null;
	rrfHitRank: number | null;
}

async function evalVariant(v: Variant) {
	const store = stores[v.modelKey]!;
	const perQ: PerQ[] = [];
	let h1 = 0,
		h5 = 0,
		h10 = 0,
		mrr = 0;

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const expected = new Set(q.expectedNorms!);

		// Vector
		const qVec = await v.embed(q.question);
		const vecHits = vectorSearch(qVec, store, POOL_VECTOR);
		const vecRanked = vecHits.map((h) => ({
			key: `${h.normId}:${h.blockId}`,
			score: h.similarity,
			normId: h.normId,
		}));

		// BM25
		const bm25Hits = bm25ArticleSearch(db, q.question, POOL_BM25, plan.normIds);
		const bm25Ranked = bm25Hits.map((h) => ({
			key: `${h.normId}:${h.blockId}`,
			score: h.score,
			normId: h.normId,
		}));

		// RRF (or vector-only when --no-bm25)
		const fused = noBm25
			? vecRanked.slice(0, POOL_RRF).map((v, i) => ({
					key: v.key,
					rrfScore: 1 / (60 + i + 1),
					sources: [{ system: "vector", rank: i + 1, originalScore: v.score }],
				}))
			: reciprocalRankFusion(
					new Map([
						["vector", vecRanked],
						["bm25", bm25Ranked],
					]),
					60,
					POOL_RRF,
				);

		// Map back to normIds
		const keyToNorm = new Map<string, string>();
		for (const r of vecRanked) keyToNorm.set(r.key, r.normId);
		for (const r of bm25Ranked) keyToNorm.set(r.key, r.normId);

		// Rerank
		let final: Array<{ key: string; normId: string }>;
		if (noRerank) {
			final = fused.map((f) => ({
				key: f.key,
				normId: keyToNorm.get(f.key) ?? "?",
			}));
		} else {
			const candidates = getBlocks(
				fused.map((f) => {
					const [normId, blockId] = f.key.split(":");
					return { normId: normId!, blockId: blockId! };
				}),
			);
			const reranked = await rerank(q.question, candidates, TOP_K, {
				cohereApiKey: COHERE_KEY,
				openrouterApiKey: OR_KEY,
			});
			final = reranked.results.map((r) => ({
				key: r.key,
				normId: keyToNorm.get(r.key) ?? "?",
			}));
		}

		// First expected norm in final list
		let hitRank: number | null = null;
		for (let r = 0; r < final.length; r++) {
			if (expected.has(final[r]!.normId)) {
				hitRank = r + 1;
				break;
			}
		}
		// Also track at each stage for diagnostics
		const findRank = (
			arr: Array<{ normId: string }>,
		): number | null => {
			for (let r = 0; r < arr.length; r++) {
				if (expected.has(arr[r]!.normId)) return r + 1;
			}
			return null;
		};
		const vecHitRank = findRank(vecRanked);
		const bm25HitRank = findRank(bm25Ranked);
		const rrfHitRank = findRank(
			fused.map((f) => ({ normId: keyToNorm.get(f.key) ?? "?" })),
		);

		if (hitRank) {
			if (hitRank === 1) h1++;
			if (hitRank <= 5) h5++;
			if (hitRank <= 10) {
				h10++;
				mrr += 1 / hitRank;
			}
		}

		perQ.push({
			id: q.id,
			question: q.question,
			expectedNorms: q.expectedNorms!,
			finalRanked: final.slice(0, 10),
			hitRank,
			bm25HitRank,
			vectorHitRank: vecHitRank,
			rrfHitRank,
		});

		if ((i + 1) % 10 === 0) {
			process.stdout.write(
				`\r  ${v.id} [${i + 1}/${questions.length}] R@1=${((h1 / (i + 1)) * 100).toFixed(0)}% R@5=${((h5 / (i + 1)) * 100).toFixed(0)}%`,
			);
		}
	}

	const n = questions.length;
	return {
		variant: v.id,
		label: v.label,
		perQuestion: perQ,
		aggregate: {
			recallAt1: h1 / n,
			recallAt5: h5 / n,
			recallAt10: h10 / n,
			mrrAt10: mrr / n,
		},
	};
}

// ── Run ──
const results: Awaited<ReturnType<typeof evalVariant>>[] = [];
for (const v of active) {
	console.log(`\n=== ${v.id}: ${v.label} ===`);
	const r = await evalVariant(v);
	results.push(r);
	process.stdout.write("\n");
	const a = r.aggregate;
	console.log(
		`  R@1=${(a.recallAt1 * 100).toFixed(1)}%  R@5=${(a.recallAt5 * 100).toFixed(1)}%  R@10=${(a.recallAt10 * 100).toFixed(1)}%  MRR@10=${a.mrrAt10.toFixed(3)}`,
	);
}

console.log(`\n${"=".repeat(100)}\nSUMMARY (end-to-end with BM25+RRF${noRerank ? "" : "+Rerank"})`);
console.log("=".repeat(100));
console.log(`Var      ${"Label".padEnd(54)}R@1   R@5   R@10  MRR@10`);
for (const r of results) {
	const a = r.aggregate;
	console.log(
		`${r.variant.padEnd(8)} ${r.label.padEnd(54)}${(a.recallAt1 * 100).toFixed(1).padStart(5)} ${(a.recallAt5 * 100).toFixed(1).padStart(5)} ${(a.recallAt10 * 100).toFixed(1).padStart(5)} ${a.mrrAt10.toFixed(3).padStart(6)}`,
	);
}

// Save
const outPath = `${outDir}/eval-e2e-${Date.now()}.json`;
await Bun.write(outPath, JSON.stringify({ questions: questions.length, results }, null, 2));
console.log(`\nSaved: ${outPath}`);

db.close();
