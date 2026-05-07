/**
 * Debug a single query through the full pipeline to see where the expected
 * norm gets ranked at each stage.
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

const repoRoot = join(import.meta.dir, "../../../../");
const db = new Database(join(repoRoot, "data", "leyabierta.db"));
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);
ensureBlocksFts(db);

const evalData = (await Bun.file(
	join(repoRoot, "data", "eval-answers-504-omnibus.json"),
).json()) as { results: Array<{ id: number; question: string; expectedNorms?: string[] }> };

const Q_ID = Number(process.argv[2] ?? "13"); // default: police+phone case
const q = evalData.results.find((r) => r.id === Q_ID);
if (!q || !q.expectedNorms) {
	console.error(`Question ${Q_ID} not found or has no expectedNorms`);
	process.exit(1);
}
console.log(`Question #${q.id}: ${q.question}`);
console.log(`Expected norms: ${q.expectedNorms.join(", ")}\n`);

const expected = new Set(q.expectedNorms);

const plan = await buildCorpusPlan(db);

// Load Gemini store
const model = EMBEDDING_MODELS["gemini-embedding-2"]!;
const ph = plan.normIds.map(() => "?").join(",");
const rows = db
	.query<{ norm_id: string; block_id: string; vector: Buffer }, string[]>(
		`SELECT norm_id, block_id, vector FROM embeddings WHERE model = ? AND norm_id IN (${ph})`,
	)
	.all("gemini-embedding-2", ...plan.normIds);
const dims = model.dimensions;
const count = rows.length;
const vectors = new Float32Array(count * dims);
const norms = new Float32Array(count);
const articles: Array<{ normId: string; blockId: string }> = [];
for (let i = 0; i < count; i++) {
	const r = rows[i]!;
	articles.push({ normId: r.norm_id, blockId: r.block_id });
	const rv = new Float32Array(r.vector.buffer, r.vector.byteOffset, dims);
	vectors.set(rv, i * dims);
	let s = 0;
	for (let j = 0; j < dims; j++) s += rv[j]! * rv[j]!;
	norms[i] = Math.sqrt(s);
}
const store: EmbeddingStore = {
	model: "gemini-embedding-2",
	dimensions: dims,
	count,
	articles,
	vectors,
	norms,
};
console.log(`Loaded ${count} Gemini vectors`);

// Embed query (Gemini)
const OR = process.env.OPENROUTER_API_KEY!;
const res = await fetchWithRetry(OR, model.id, `task: question answering | query: ${q.question}`);
const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
const qVec = new Float32Array(data.data[0]!.embedding);

// Stage 1: vector search
const vec = vectorSearch(qVec, store, 60);
function normRank(arr: Array<{ normId: string }>): { rank: number; normId: string } | null {
	for (let i = 0; i < arr.length; i++) {
		if (expected.has(arr[i]!.normId)) return { rank: i + 1, normId: arr[i]!.normId };
	}
	return null;
}
console.log(`Stage 1 (vector top-60): expected first hit at rank ${normRank(vec)?.rank ?? "MISS"}`);
console.log(`  top-5 norms: ${[...new Set(vec.slice(0, 5).map((v) => v.normId))].slice(0, 5).join(", ")}`);

// Stage 2: BM25
const bm = bm25ArticleSearch(db, q.question, 60, plan.normIds);
console.log(`Stage 2 (BM25 top-60):   expected first hit at rank ${normRank(bm)?.rank ?? "MISS"}`);
console.log(`  top-5 norms: ${[...new Set(bm.slice(0, 5).map((v) => v.normId))].slice(0, 5).join(", ")}`);

// Stage 3: RRF
const fused = reciprocalRankFusion(
	new Map([
		["vector", vec.map((h) => ({ key: `${h.normId}:${h.blockId}`, score: h.similarity }))],
		["bm25", bm.map((h) => ({ key: `${h.normId}:${h.blockId}`, score: h.score }))],
	]),
	60,
	30,
);
const keyToNorm = new Map<string, string>();
for (const v of vec) keyToNorm.set(`${v.normId}:${v.blockId}`, v.normId);
for (const v of bm) keyToNorm.set(`${v.normId}:${v.blockId}`, v.normId);
const rrfNorms = fused.map((f) => ({ normId: keyToNorm.get(f.key) ?? "?" }));
console.log(`Stage 3 (RRF top-30):    expected first hit at rank ${normRank(rrfNorms)?.rank ?? "MISS"}`);
console.log(`  top-5 norms: ${[...new Set(rrfNorms.slice(0, 5).map((v) => v.normId))].slice(0, 5).join(", ")}`);

// Stage 4: rerank
const blockTextStmt = db.prepare<
	{ norm_id: string; block_id: string; title: string; text: string },
	[string, string]
>(
	`SELECT norm_id, block_id, title, current_text as text FROM blocks WHERE norm_id = ? AND block_id = ?`,
);
const candidates: RerankerCandidate[] = [];
for (const f of fused) {
	const [normId, blockId] = f.key.split(":");
	const row = blockTextStmt.get(normId!, blockId!);
	if (row?.text) {
		candidates.push({
			key: f.key,
			title: row.title || normId!,
			text: row.text.slice(0, 4000),
		});
	}
}
console.log(`  Candidates passed to rerank: ${candidates.length}`);

const rerankResult = await rerank(q.question, candidates, 10, {
	openrouterApiKey: OR,
});
console.log(`  Rerank backend: ${rerankResult.backend}`);
const rerankNorms = rerankResult.results.map((r) => ({ normId: keyToNorm.get(r.key) ?? "?" }));
console.log(`Stage 4 (Rerank top-10): expected first hit at rank ${normRank(rerankNorms)?.rank ?? "MISS"}`);
console.log(`  top-5 norms: ${[...new Set(rerankNorms.slice(0, 5).map((v) => v.normId))].slice(0, 5).join(", ")}`);

// Show what rerank put at top
console.log(`\nRerank top-5 details:`);
for (let i = 0; i < Math.min(5, rerankResult.results.length); i++) {
	const r = rerankResult.results[i]!;
	const c = candidates.find((c) => c.key === r.key);
	console.log(`  ${i + 1}. score=${r.relevanceScore.toFixed(4)} [${r.key}] ${c?.title.slice(0, 60)}`);
}

db.close();
