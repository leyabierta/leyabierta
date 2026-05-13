/**
 * Direct (in-process) retriever for the Ley Abierta RAG pipeline.
 *
 * Default mode: wraps `RagPipeline._retrieveForEval` — the retrieval-only
 * gate that stops before synthesis, using the full hybrid stack
 * (BM25 + vector KNN, RRF fusion, Qwen3.6 reranker).
 *
 * BM25-only mode (bm25Only: true in initRagDirect opts): calls
 * `runRetrievalCore` directly with `vectorIndex: null`, skipping the
 * ~7-8GB vector file load. Useful on machines with limited free memory.
 * Quality is lower than the full hybrid stack — document in results.
 *
 * Configuration used (default / hybrid):
 *   - Embedding model: qwen3-nan (EMBEDDING_MODEL_KEY default)
 *   - Retrieval: hybrid BM25 + vector KNN, RRF fusion, Qwen3.6 reranker
 *   - TOP_K: 15 (pipeline default) — we then dedupe and expose top topK
 *   - DB: read-write handle (pipeline writes ask_log on .ask(); for eval we
 *     call _retrieveForEval which does NOT write to DB)
 *
 * Norm-level deduplication: the pipeline returns article-level candidates
 * (one chunk per article). Multiple chunks from the same norm are collapsed
 * to a single EvalCandidate, keeping the best (lowest) rank.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getEmbeddedNormIds } from "../../../api/src/services/rag/embeddings.ts";
import { RagPipeline } from "../../../api/src/services/rag/pipeline.ts";
import {
	EMBEDDING_MODEL_KEY,
	runRetrievalCore,
} from "../../../api/src/services/rag/retrieval.ts";
import type { EvalCandidate } from "../harness.ts";

// ── Env loading (mirrors eval-gate.ts pattern) ────────────────────────────────

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

let _pipeline: RagPipeline | null = null;
let _db: Database | null = null;
let _apiKey = "";
let _bm25Only = false;

export interface RagDirectOpts {
	/** Absolute path to data directory (default: <repo-root>/data) */
	dataDir?: string;
	/** Absolute path to SQLite DB (default: <dataDir>/leyabierta.db) */
	dbPath?: string;
	/** API key for the NaN/Hermes endpoint (default: reads HERMES_API_KEY env) */
	apiKey?: string;
	/** Repository root for .env loading (default: auto-detected from import.meta) */
	repoRoot?: string;
	/**
	 * Skip vector index loading and use BM25-only retrieval.
	 * Much lower memory footprint (~100MB vs ~7-8GB) at the cost of retrieval
	 * quality (no semantic search, no vector KNN). Use when the machine does
	 * not have enough free RAM to load vectors.bin.
	 *
	 * When true the retriever calls `runRetrievalCore` directly with
	 * `vectorIndex: null` — the production pipeline is NOT used in this mode.
	 */
	bm25Only?: boolean;
}

/**
 * Initialise the shared RagPipeline instance (or BM25-only state).
 * Call once before creating retrievers. Idempotent.
 */
export async function initRagDirect(opts: RagDirectOpts = {}): Promise<void> {
	if (_pipeline || (_bm25Only && _db)) return; // already initialised

	const repoRoot = opts.repoRoot ?? join(import.meta.dir, "../../../../");
	await loadEnv(repoRoot);

	_apiKey =
		opts.apiKey ??
		process.env.HERMES_API_KEY ??
		process.env.OPENROUTER_API_KEY ??
		"";
	if (!_apiKey) {
		throw new Error(
			"No API key found. Set HERMES_API_KEY (NaN endpoint) or OPENROUTER_API_KEY.",
		);
	}

	const dataDir =
		opts.dataDir ?? process.env.RAG_DATA_DIR ?? join(repoRoot, "data");
	const dbPath =
		opts.dbPath ?? process.env.DB_PATH ?? join(dataDir, "leyabierta.db");

	_db = new Database(dbPath, { readonly: true });
	_bm25Only = opts.bm25Only ?? false;

	if (!_bm25Only) {
		// Full pipeline — RagPipeline manages DB handle and vector loading
		_db.close();
		_db = new Database(dbPath);
		_db.exec("PRAGMA journal_mode = WAL");
		_pipeline = new RagPipeline(_db, _apiKey, dataDir);
	} else {
		console.log("[rag-direct] BM25-only mode — vector index NOT loaded");
	}
}

/**
 * Close the shared DB connection. Call when the eval run is complete.
 */
export function closeRagDirect(): void {
	_db?.close();
	_db = null;
	_pipeline = null;
	_bm25Only = false;
	_apiKey = "";
}

/**
 * Deduplicates article-level candidates to norm_id level.
 * Keeps the best (lowest) position per norm_id and returns sorted
 * EvalCandidates with 1-based ranks capped at topK.
 */
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

/**
 * Returns a `retrieve` function compatible with `runEval`.
 *
 * Deduplicates article-level candidates to norm_id level (best rank wins),
 * then returns sorted EvalCandidates with 1-based ranks.
 */
export function makeRagDirectRetriever(
	topK = 10,
): (q: string) => Promise<EvalCandidate[]> {
	if (_bm25Only) {
		return makeBm25OnlyRetriever(topK);
	}
	return makeHybridRetriever(topK);
}

/** Full hybrid pipeline via RagPipeline._retrieveForEval. */
function makeHybridRetriever(
	topK: number,
): (q: string) => Promise<EvalCandidate[]> {
	return async (question: string): Promise<EvalCandidate[]> => {
		if (!_pipeline) {
			throw new Error("Call initRagDirect() before using the retriever.");
		}

		const result = await _pipeline._retrieveForEval({ question });

		if (result.declined) {
			return [];
		}

		return dedupeToNorms(result.articles, topK);
	};
}

/**
 * BM25-only retriever — calls runRetrievalCore with vectorIndex: null.
 * No vector loading, no semantic search. Lower quality, much lower RAM.
 */
function makeBm25OnlyRetriever(
	topK: number,
): (q: string) => Promise<EvalCandidate[]> {
	return async (question: string): Promise<EvalCandidate[]> => {
		if (!_db) {
			throw new Error("Call initRagDirect() before using the retriever.");
		}

		const embeddedNormIds = getEmbeddedNormIds(_db, EMBEDDING_MODEL_KEY);

		const result = await runRetrievalCore({
			db: _db,
			apiKey: _apiKey,
			question,
			embeddedNormIds,
			vectorIndex: null,
			// Disable low-confidence gate (score distributions shift in BM25-only mode)
			lowConfidenceThreshold: 0,
		});

		if (result.type === "early") {
			return [];
		}

		return dedupeToNorms(result.articles, topK);
	};
}
