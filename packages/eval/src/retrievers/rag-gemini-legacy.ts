/**
 * Gemini legacy retriever — for A/B evaluation only.
 *
 * Mirrors rag-direct.ts exactly in structure and init/close/make API.
 * Three components differ from the Qwen prod stack:
 *
 *   1. Embedding model  → gemini-embedding-2 (3072 dims, OpenRouter)
 *   2. Vector binary    → data/vectors-gemini.bin + data/vectors-gemini.meta.jsonl
 *   3. Reranker         → Cohere rerank-v3.5 (direct) or cohere/rerank-4-pro
 *                         (OpenRouter proxy). See CohereReranker.
 *
 * Pipeline: query analysis (Qwen NaN) → Gemini embed → vector KNN + BM25 →
 *   RRF fusion + boosts → Cohere rerank → norm-level dedup.
 *
 * The analyzer and BM25 logic are unchanged (same runRetrievalCore). Only the
 * embedding model and reranker are swapped. We extract allFusedArticles (the
 * pre-rerank pool) from runRetrievalCore, then apply Cohere on that pool
 * as the authoritative ranking step.
 *
 * PREREQUISITE
 * ────────────
 * Before using this retriever, export the Gemini vectors from SQLite:
 *
 *   bun run packages/api/scripts/export-gemini-vectors.ts
 *
 * This produces ~5.7 GB data/vectors-gemini.bin. If the file is missing,
 * init() throws a clear error — no silent fallback.
 *
 * ENV VARS REQUIRED
 * ─────────────────
 * - OPENROUTER_API_KEY  — Gemini query embeddings (google/gemini-embedding-2-preview)
 * - COHERE_API_KEY      — optional; direct Cohere rerank (cheaper, faster)
 *
 * If COHERE_API_KEY is absent but OPENROUTER_API_KEY is present, rerank runs
 * via OpenRouter (cohere/rerank-4-pro). One of COHERE_API_KEY or
 * OPENROUTER_API_KEY must be set for construction to succeed.
 *
 * NOTE ON INTERNAL RERANKER
 * ─────────────────────────
 * runRetrievalCore() internally runs its own reranker (Qwen LLM via NaN) when
 * NAN_API_KEY is set. We do NOT use its output — we always re-apply Cohere on
 * allFusedArticles (the pre-rerank pool). Setting NAN_API_KEY='' in the shell
 * avoids the unnecessary Qwen rerank call and saves latency.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { InMemoryVectorIndex } from "../../../api/src/services/rag/embeddings.ts";
import {
	EMBEDDING_MODELS,
	embedQuery,
	getEmbeddedNormIds,
} from "../../../api/src/services/rag/embeddings.ts";
import { CohereReranker } from "../../../api/src/services/rag/rerankers/cohere.ts";
import { runRetrievalCore } from "../../../api/src/services/rag/retrieval.ts";
import type { EvalCandidate } from "../harness.ts";
import { loadVectorsGemini } from "./rag-gemini-legacy-vectors.ts";

// ── Env loading (same pattern as rag-direct.ts) ───────────────────────────────

async function loadEnv(repoRoot: string): Promise<void> {
	const envFile = Bun.file(join(repoRoot, ".env"));
	if (!(await envFile.exists())) return;
	const text = await envFile.text();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

// ── Module state ──────────────────────────────────────────────────────────────

const MODEL_KEY = "gemini-embedding-2";
const GEMINI_DIMS = EMBEDDING_MODELS[MODEL_KEY]!.dimensions; // 3072
const COHERE_POOL = 30; // candidates passed to Cohere (mirrors old prod pipeline)

let _db: Database | null = null;
let _openrouterKey = "";
let _reranker: CohereReranker | null = null;
let _vectorIndex: {
	meta: Array<{ normId: string; blockId: string }>;
	index: InMemoryVectorIndex;
} | null = null;
let _embeddedNormIds: string[] = [];

export interface GeminiLegacyOpts {
	/** Absolute path to data directory (default: <repo-root>/data) */
	dataDir?: string;
	/** Absolute path to SQLite DB (default: <dataDir>/leyabierta.db) */
	dbPath?: string;
	/** OpenRouter API key for Gemini query embeddings (default: OPENROUTER_API_KEY env) */
	openrouterApiKey?: string;
	/** Direct Cohere API key (preferred for reranking, default: COHERE_API_KEY env) */
	cohereApiKey?: string;
	/** Repository root for .env loading (default: auto-detected from import.meta) */
	repoRoot?: string;
}

/**
 * Initialise the Gemini legacy retriever. Call once before using.
 * Throws with a clear message if vectors-gemini.bin is missing or keys are absent.
 * Idempotent: safe to call multiple times.
 */
export async function initGeminiLegacy(
	opts: GeminiLegacyOpts = {},
): Promise<void> {
	if (_db) return; // already initialised

	const repoRoot = opts.repoRoot ?? join(import.meta.dir, "../../../../");
	await loadEnv(repoRoot);

	_openrouterKey =
		opts.openrouterApiKey ?? process.env.OPENROUTER_API_KEY ?? "";
	if (!_openrouterKey) {
		throw new Error(
			"[rag-gemini-legacy] OPENROUTER_API_KEY is required for Gemini query embeddings " +
				"(google/gemini-embedding-2-preview via OpenRouter). " +
				"Set OPENROUTER_API_KEY in your environment or .env file.",
		);
	}

	const dataDir =
		opts.dataDir ?? process.env.RAG_DATA_DIR ?? join(repoRoot, "data");
	const dbPath =
		opts.dbPath ?? process.env.DB_PATH ?? join(dataDir, "leyabierta.db");

	// Validate vectors binary exists BEFORE opening the DB (fast-fail).
	const vecPath = join(dataDir, "vectors-gemini.bin");
	const metaPath = join(dataDir, "vectors-gemini.meta.jsonl");

	if (
		!(await Bun.file(vecPath).exists()) ||
		!(await Bun.file(metaPath).exists())
	) {
		throw new Error(
			`[rag-gemini-legacy] vectors-gemini.bin not found at ${vecPath}.\n` +
				"Export the Gemini vectors first:\n\n" +
				"  bun run packages/api/scripts/export-gemini-vectors.ts\n\n" +
				"This reads the 483K Gemini embeddings from SQLite, writes ~5.7 GB binary,\n" +
				"and takes approximately 15 minutes.",
		);
	}

	// Init Cohere reranker — throws at construction time if neither key is set.
	_reranker = new CohereReranker({
		cohereApiKey: opts.cohereApiKey ?? process.env.COHERE_API_KEY,
		openrouterApiKey: _openrouterKey,
	});
	console.log(`[rag-gemini-legacy] Reranker: ${_reranker.backend}`);

	// Open DB (read-write for internal ask_log compat; eval path does not write).
	_db = new Database(dbPath);
	_db.exec("PRAGMA journal_mode = WAL");

	// Load Gemini vector index.
	console.log("[rag-gemini-legacy] Loading vectors-gemini.bin...");
	const loaded = await loadVectorsGemini(vecPath, metaPath);
	_vectorIndex = { meta: loaded.meta, index: loaded.index };
	console.log(
		`[rag-gemini-legacy] Loaded ${loaded.totalVectors.toLocaleString()} Gemini vectors (${GEMINI_DIMS} dims)`,
	);

	// Build embedded norm IDs set for BM25 scoping.
	_embeddedNormIds = getEmbeddedNormIds(_db, MODEL_KEY);
	console.log(
		`[rag-gemini-legacy] ${_embeddedNormIds.length.toLocaleString()} norms with Gemini embeddings`,
	);
}

/**
 * Close the shared DB connection. Call when the eval run is complete.
 */
export function closeGeminiLegacy(): void {
	_db?.close();
	_db = null;
	_reranker = null;
	_vectorIndex = null;
	_embeddedNormIds = [];
	_openrouterKey = "";
}

// ── Deduplication (same logic as rag-direct.ts) ───────────────────────────────

function dedupeToNorms(
	articles: Array<{ normId: string; [k: string]: unknown }>,
	topK: number,
): EvalCandidate[] {
	const normBestRank = new Map<string, { rank: number; score: number }>();
	for (let i = 0; i < articles.length; i++) {
		const article = articles[i]!;
		const existing = normBestRank.get(article.normId);
		if (!existing || i < existing.rank) {
			normBestRank.set(article.normId, {
				rank: i + 1,
				score: 1 / (i + 1),
			});
		}
	}
	return [...normBestRank.entries()]
		.sort(([, a], [, b]) => a.rank - b.rank)
		.slice(0, topK)
		.map(([norm_id, { rank, score }]) => ({ norm_id, rank, score }));
}

// ── Gemini query embedding ────────────────────────────────────────────────────

/**
 * Embeds a query with the Gemini task prefix used during corpus embedding.
 *
 * The prefix `task: question answering | query: <q>` was applied to all
 * corpus embeddings (see eval-2026-05-local-vs-gemini.ts variant A).
 * Query embeddings must use the same prefix for alignment.
 */
async function geminiEmbedQuery(
	_apiKey: string, // ignored — we use _openrouterKey
	modelKey: string,
	query: string,
): Promise<{ embedding: Float32Array; cost: number; tokens: number }> {
	const prefixedQuery = `task: question answering | query: ${query}`;
	return embedQuery(_openrouterKey, modelKey, prefixedQuery);
}

// ── Retriever factory ─────────────────────────────────────────────────────────

/**
 * Returns a `retrieve` function compatible with `runEval`.
 *
 * Pipeline: Gemini embed → BM25 + vector KNN (concurrent) → RRF fusion →
 *   boosts → allFusedArticles pool → Cohere rerank → norm-level dedup.
 *
 * We extract allFusedArticles from runRetrievalCore (the pre-internal-rerank
 * pool) and apply Cohere as the authoritative rerank step. This gives us the
 * exact Gemini+Cohere stack from Phase 3-4 production.
 */
export function makeGeminiLegacyRetriever(
	topK = 10,
): (q: string) => Promise<EvalCandidate[]> {
	return async (question: string): Promise<EvalCandidate[]> => {
		if (!_db || !_vectorIndex || !_reranker) {
			throw new Error(
				"[rag-gemini-legacy] Call initGeminiLegacy() before using the retriever.",
			);
		}

		const reranker = _reranker;

		const result = await runRetrievalCore({
			db: _db,
			apiKey: _openrouterKey,
			question,
			embeddingModelKey: MODEL_KEY,
			embedQueryFn: geminiEmbedQuery,
			embeddedNormIds: _embeddedNormIds,
			// Disable the low-confidence gate — score scales differ between Gemini
			// and Qwen embeddings, and the threshold was calibrated for Qwen.
			lowConfidenceThreshold: 0,
			vectorIndex: {
				meta: _vectorIndex.meta,
				vectors: _vectorIndex.index,
				dims: GEMINI_DIMS,
			},
			// No rerankerOverrides — the internal Qwen/NaN reranker will run if
			// NAN_API_KEY is set, otherwise passthrough. Either way we override
			// below with Cohere on allFusedArticles. To avoid the wasted Qwen call,
			// run with NAN_API_KEY='' in the shell.
		});

		if (result.type === "early") {
			return [];
		}

		// Apply Cohere rerank on the full fused pool (allFusedArticles) as the
		// authoritative ranking, matching the old production pipeline.
		const pool = result.allFusedArticles;
		if (pool.length === 0) {
			return [];
		}

		const coherePool = pool.slice(0, COHERE_POOL);
		const { results: reranked } = await reranker.rerank(
			question,
			coherePool.map((a) => ({
				key: `${a.normId}:${a.blockId}`,
				title: `${a.blockTitle} — ${a.normTitle}`,
				text: a.text,
			})),
			topK * 3, // get more than topK before norm-level dedup
		);

		// Map reranked keys back to articles.
		const articleByKey = new Map(
			coherePool.map((a) => [`${a.normId}:${a.blockId}`, a]),
		);
		const rerankedArticles = reranked
			.map((r) => articleByKey.get(r.key))
			.filter((a): a is (typeof coherePool)[0] => a !== undefined);

		return dedupeToNorms(rerankedArticles, topK);
	};
}
