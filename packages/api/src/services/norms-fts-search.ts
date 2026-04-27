/**
 * Norm-level FTS5 search — robust BM25 retrieval for /v1/laws.
 *
 * Mirrors the adaptive AND→OR pattern proven in services/rag/blocks-fts.ts,
 * adapted for the two-pass title-then-content shape that searchLaws needs.
 *
 * Why this exists:
 *  - The previous implementation ran content MATCH without bm25() ordering and
 *    capped at FTS_CAP * 3 = 6000 rows, scanning the full posting lists for
 *    common tokens ("casa", "alquiler") in doc-id order.
 *  - Multi-token queries were AND-joined as quoted phrases, so a frase like
 *    "ley de vivienda por el derecho ..." intersected 9 phrase postings —
 *    common particles ("de", "la", "por") have huge lists and dominate cost.
 *
 * Two robustness ideas, both data-driven (no hardcoded stop-word list):
 *
 *  1. ORDER BY bm25(...) LIMIT k on every FTS read so SQLite can use top-k
 *     early termination instead of scanning the full intersection.
 *  2. Adaptive AND→OR fallback (cardinality-based) plus high-DF token pruning
 *     via the fts5vocab built-in. Tokens that appear in >30% of norms are
 *     dropped from the OR fallback because every document matches them and
 *     they explode the postings traversal without contributing signal.
 *
 * The DF cutoff adapts to the corpus: as new laws are ingested, the docfreq
 * cache is reset and the next query re-reads the fresh vocab table. No list
 * of words to maintain.
 */

import type { Database } from "bun:sqlite";

/**
 * Tokens whose document frequency exceeds this fraction of the corpus are
 * dropped from the OR fallback. Tuned empirically: with ~12k norms and a
 * threshold of 0.3, words present in >3.6k norms are pruned. Tracks the
 * value used in blocks-fts.ts (which has been in prod since 2026-03).
 */
const OR_DOCFREQ_PRUNE_RATIO = 0.3;

/**
 * Cardinality threshold for AND→OR fallback. If the strict AND match returns
 * at least this many candidates we stick with AND (cheaper, more relevant).
 * Below the threshold we relax to OR so users searching with rare tokens or
 * long phrases still get results.
 */
const AND_FALLBACK_THRESHOLD = 20;

/**
 * Soft TTL for the docfreq cache. The daily ingest job adds new norms but runs
 * in a separate process, so the API can't be told to flush. A 15-minute TTL
 * caps staleness at the cost of one extra vocab lookup per term every 15 min
 * (each lookup is sub-millisecond and the working set is small). Container
 * restarts (Watchtower, deploys) also reset everything implicitly.
 */
const DOCFREQ_CACHE_TTL_MS = 15 * 60 * 1000;

const docfreqCache = new Map<string, { value: number; expiresAt: number }>();
let totalDocsCache: { value: number; expiresAt: number } | null = null;

/**
 * Drop the cached docfreq entries — call manually if you know the FTS index
 * was just rebuilt in-process (eg. inside a long-running script).
 */
export function resetNormsFtsCaches(): void {
	docfreqCache.clear();
	totalDocsCache = null;
}

const CREATE_VOCAB = `
CREATE VIRTUAL TABLE IF NOT EXISTS norms_fts_vocab USING fts5vocab(norms_fts, 'row')`;

export function ensureNormsFtsVocab(db: Database): void {
	try {
		db.exec(CREATE_VOCAB);
	} catch (err) {
		console.warn(
			`[norms-fts] failed to create norms_fts_vocab: ${(err as Error).message}`,
		);
	}
}

function getTotalDocs(db: Database): number {
	const now = Date.now();
	if (totalDocsCache !== null && totalDocsCache.expiresAt > now) {
		return totalDocsCache.value;
	}
	try {
		const row = db
			.query<{ cnt: number }, []>("SELECT count(*) as cnt FROM norms_fts")
			.get();
		const value = row?.cnt ?? 0;
		totalDocsCache = { value, expiresAt: now + DOCFREQ_CACHE_TTL_MS };
		return value;
	} catch {
		totalDocsCache = { value: 0, expiresAt: now + DOCFREQ_CACHE_TTL_MS };
		return 0;
	}
}

function getDocfreq(db: Database, quotedToken: string): number {
	const now = Date.now();
	const cached = docfreqCache.get(quotedToken);
	if (cached !== undefined && cached.expiresAt > now) return cached.value;
	const term = quotedToken.replace(/^"|"$/g, "").toLowerCase();
	try {
		const row = db
			.query<{ doc: number }, [string]>(
				"SELECT doc FROM norms_fts_vocab WHERE term = ?",
			)
			.get(term);
		const value = row?.doc ?? 0;
		docfreqCache.set(quotedToken, {
			value,
			expiresAt: now + DOCFREQ_CACHE_TTL_MS,
		});
		return value;
	} catch {
		// vocab table not built yet — treat as unknown (don't prune)
		return 0;
	}
}

/**
 * Drop tokens whose document frequency is above OR_DOCFREQ_PRUNE_RATIO of
 * the corpus. If pruning would leave nothing, keep the original list (recall
 * trumps speed in that edge case).
 */
function pruneCommonTokens(db: Database, tokens: string[]): string[] {
	if (tokens.length <= 1) return tokens;
	const total = getTotalDocs(db);
	if (total <= 0) return tokens;
	const cutoff = total * OR_DOCFREQ_PRUNE_RATIO;
	const kept = tokens.filter((t) => getDocfreq(db, t) < cutoff);
	return kept.length === 0 ? tokens : kept;
}

/**
 * Tokenize a free-text user query into FTS5 phrase tokens.
 * Strips punctuation, drops <=2-char tokens (Spanish particles "de", "la",
 * "el" plus noise), wraps in quotes so hyphens and special chars don't
 * become FTS5 operators.
 */
export function tokenizeQuery(query: string): string[] {
	return query
		.replace(/["¿?¡!'()[\]{},.:;]/g, "")
		.split(/\s+/)
		.filter((t) => t.length > 2)
		.slice(0, 12)
		.map((t) => `"${t}"`);
}

/**
 * Build an FTS5 MATCH expression for the given column with adaptive AND→OR.
 *
 * Strategy:
 *   1. If single token: just return it.
 *   2. Multi-token: build AND expression. Caller runs it; if cardinality is
 *      below AND_FALLBACK_THRESHOLD it should retry with the OR expression
 *      returned by `buildOrFallback` (DF-pruned).
 */
export function buildAndExpr(tokens: string[], column?: string): string {
	const joined = tokens.join(" AND ");
	return column ? `${column}:(${joined})` : joined;
}

export function buildOrFallback(
	db: Database,
	tokens: string[],
	column?: string,
): string {
	const pruned = pruneCommonTokens(db, tokens);
	const joined = pruned.join(" OR ");
	return column ? `${column}:(${joined})` : joined;
}

interface AdaptiveSearchOpts {
	matchExprBuilder: (tokens: string[], joiner: "AND" | "OR") => string;
	runMatch: (matchExpr: string) => string[];
	tokens: string[];
}

/**
 * Run an adaptive AND→OR search:
 *  - 0 tokens → []
 *  - 1 token → run as-is
 *  - 2+ tokens → AND first; if results < threshold, retry with OR (pruned).
 */
export function adaptiveSearch(
	db: Database,
	opts: AdaptiveSearchOpts,
): string[] {
	const { tokens, matchExprBuilder, runMatch } = opts;
	if (tokens.length === 0) return [];
	if (tokens.length === 1) return runMatch(tokens[0]!);

	const andResults = runMatch(matchExprBuilder(tokens, "AND"));
	if (andResults.length >= AND_FALLBACK_THRESHOLD) return andResults;

	// pruneCommonTokens never returns an empty list — it falls back to the
	// original tokens when pruning would zero out the query (recall trumps
	// speed in that edge case).
	const orPruned = pruneCommonTokens(db, tokens);
	return runMatch(matchExprBuilder(orPruned, "OR"));
}

/**
 * Test-only: expose docfreq cache state for assertions.
 */
export function _internalCacheState(): {
	totalDocs: number | null;
	size: number;
} {
	return {
		totalDocs: totalDocsCache?.value ?? null,
		size: docfreqCache.size,
	};
}
