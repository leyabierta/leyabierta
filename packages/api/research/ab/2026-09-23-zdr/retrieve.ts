/**
 * Stage 1 — run the production retrieval core (analyzer → embed → vector ||
 * BM25 → RRF → boosts) for every query, WITHOUT rerank, and cache the full
 * fused pool (up to 80 candidates) so every rerank variant (stage 2) and every
 * synthesis model (stage 3) is compared on exactly the same candidates.
 *
 * The prod reranker is neutralised by keeping OPENROUTER_API_KEY out of
 * process.env (see shared.ts): `getRerankCaller()` then returns the
 * passthrough caller, i.e. the same "no rerank" order production falls back to
 * when the Cohere call 404s under ZDR.
 *
 * Prereqs: local `data/leyabierta.db` + `data/vectors-int8.bin` (+ .norms.bin,
 * vectors.meta.jsonl) and the vector-simd dylib/so. Read-only on the DB.
 *
 * Usage:
 *   ZDR_EVAL_OUT=/tmp/zdr DATA_DIR=/path/to/data \
 *     bun packages/api/research/ab/2026-09-23-zdr/retrieve.ts [--analyzer google/gemini-2.5-flash-lite]
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { loadRetrievalSet, SYNTHESIS_QUESTIONS } from "./queries.ts";
import { OR_KEY, OUT_DIR, REPO_ROOT, record, spent } from "./shared.ts";

const args = process.argv.slice(2);
const argVal = (k: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1] : undefined;
};
const ANALYZER_MODEL = argVal("--analyzer") ?? "google/gemini-2.5-flash-lite";
const LIMIT = Number(argVal("--limit") ?? "0");
const DATA_DIR = process.env.DATA_DIR ?? join(REPO_ROOT, "data");
const DB_PATH = join(DATA_DIR, "leyabierta.db");
process.env.DB_PATH = DB_PATH; // worker pool opens its own read-only handle

// Dynamic imports AFTER shared.ts removed the key from process.env.
const { callOpenRouter } = await import("../../../src/services/openrouter.ts");
const { embedQuery, loadInt8VectorsToMemory } = await import(
	"../../../src/services/rag/embeddings.ts"
);
const { runRetrievalCore, EMBEDDING_MODEL_KEY } = await import(
	"../../../src/services/rag/retrieval.ts"
);
const { shutdownVectorPool } = await import(
	"../../../src/services/rag/vector-pool.ts"
);
const { getEmbeddedNormIds } = await import(
	"../../../src/services/rag/embeddings.ts"
);

const db = new Database(DB_PATH, { readonly: true });

console.log("[stage1] loading int8 vector index…");
const t0 = Date.now();
const metaLines = (await Bun.file(join(DATA_DIR, "vectors.meta.jsonl")).text())
	.split("\n")
	.filter(Boolean);
const meta = metaLines.map((l) => {
	const o = JSON.parse(l);
	return { normId: o.n as string, blockId: o.b as string };
});
const vectors = await loadInt8VectorsToMemory(
	join(DATA_DIR, "vectors-int8.bin"),
	join(DATA_DIR, "vectors-int8.norms.bin"),
);
if (vectors.totalVectors !== meta.length)
	throw new Error(
		`index/meta mismatch ${vectors.totalVectors} vs ${meta.length}`,
	);
const vectorIndex = { meta, vectors, dims: vectors.dim };
const embeddedNormIds = getEmbeddedNormIds(db, EMBEDDING_MODEL_KEY);
console.log(
	`[stage1] ${meta.length} vectors, ${embeddedNormIds.length} norms in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);

// Analyzer transport: OpenRouter with an explicit model + ledger.
// biome-ignore lint/suspicious/noExplicitAny: matches AnalyzerLlmFn
const analyzerFn = async (_k: string, opts: any) => {
	const r = await callOpenRouter(OR_KEY, { ...opts, model: ANALYZER_MODEL });
	record("analyzer", ANALYZER_MODEL, r.cost, {
		in: r.tokensIn,
		out: r.tokensOut,
		ms: r.elapsed,
	});
	return r;
};
const embedFn = async (key: string, modelKey: string, q: string) => {
	const r = await embedQuery(key, modelKey, q);
	record("embed", "qwen/qwen3-embedding-8b", r.cost, { tokens: r.tokens });
	return r;
};

const retrievalSet = await loadRetrievalSet();
const extra = SYNTHESIS_QUESTIONS.filter(
	(s) => !retrievalSet.some((r) => r.question === s.question),
).map((s, i) => ({
	id: `synth-${i}`,
	question: s.question,
	gold: [] as string[],
	topic: s.kind,
	source: "synthesis-only",
}));
let queries = [...retrievalSet, ...extra];
if (LIMIT) queries = queries.slice(0, LIMIT);
console.log(
	`[stage1] ${retrievalSet.length} retrieval queries + ${extra.length} synthesis-only`,
);

const outPath = join(
	OUT_DIR,
	`stage1-${ANALYZER_MODEL.replace(/[^a-z0-9.-]+/gi, "_")}.jsonl`,
);
// Resumable: one JSON line per query; already-done ids are skipped.
const done = new Set<string>(
	(await Bun.file(outPath).exists())
		? (await Bun.file(outPath).text())
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l).id as string)
		: [],
);
const { appendFileSync } = await import("node:fs");
const emit = (row: unknown) =>
	appendFileSync(outPath, `${JSON.stringify(row)}\n`);
for (const [i, q] of queries.entries()) {
	if (done.has(q.id)) continue;
	const st = performance.now();
	const r = await runRetrievalCore({
		db,
		apiKey: OR_KEY,
		question: q.question,
		embeddedNormIds,
		vectorIndex,
		embedQueryFn: embedFn,
		analyzerOverrides: { llmFn: analyzerFn, model: ANALYZER_MODEL },
	});
	const ms = performance.now() - st;
	const base = {
		...q,
		type: r.type,
		analyzed: r.analyzed,
		bestScore: r.bestScore,
		cost: r.cost,
		retrievalMs: Math.round(ms),
	};
	if (r.type === "early") {
		emit({ ...base, reason: r.reason });
	} else {
		emit({
			...base,
			useTemporal: r.useTemporal,
			rerankerBackend: r.rerankerBackend,
			noRerankKeys: r.articles.map((a) => `${a.normId}:${a.blockId}`),
			pool: r.allFusedArticles,
		});
	}
	const tag =
		r.type === "early"
			? `early:${r.reason}`
			: `${r.allFusedArticles.length} cand`;
	console.log(
		`[${i + 1}/${queries.length}] ${Math.round(ms)}ms ${tag} spent=$${spent().toFixed(4)} — ${q.question.slice(0, 60)}`,
	);
}
console.log(`[stage1] wrote ${outPath}`);
shutdownVectorPool();
db.close();
process.exit(0);
