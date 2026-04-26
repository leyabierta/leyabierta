/**
 * Article-level FTS5 for BM25 scoring.
 *
 * Creates a blocks_fts virtual table that indexes individual articles (blocks),
 * enabling article-level BM25 ranking for hybrid search with RRF fusion.
 *
 * The existing norms_fts indexes at norm level — fine for law search,
 * but for RAG we need article-level granularity to fuse with vector search.
 */

import type { Database } from "bun:sqlite";

const CREATE_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  norm_id UNINDEXED,
  block_id UNINDEXED,
  title,
  norm_title,
  content,
  tokenize='unicode61 remove_diacritics 2'
)`;

const POPULATE = `
INSERT INTO blocks_fts (norm_id, block_id, title, norm_title, content)
SELECT b.norm_id, b.block_id, b.title, n.title, b.current_text
FROM blocks b
JOIN norms n ON n.id = b.norm_id
WHERE b.block_type = 'precepto'
  AND b.current_text != ''`;

/**
 * Ensure blocks_fts exists and is populated. Idempotent — skips if already built.
 */
export function ensureBlocksFts(db: Database): void {
	// Check if the table already has data with the current schema
	try {
		const count = db
			.query<{ cnt: number }, []>("SELECT count(*) as cnt FROM blocks_fts")
			.get();
		if (count && count.cnt > 0) {
			// Verify schema has norm_title column (added in v2)
			try {
				db.query("SELECT norm_title FROM blocks_fts LIMIT 0").get();
				return; // schema is current, data exists
			} catch {
				// Old schema without norm_title — rebuild
				console.log(
					"  blocks_fts schema outdated (missing norm_title), rebuilding...",
				);
				db.exec("DROP TABLE IF EXISTS blocks_fts");
			}
		}
	} catch {
		// table doesn't exist yet
	}

	console.log("  Building blocks_fts (article-level BM25 index)...");
	db.exec(CREATE_TABLE);
	db.exec(POPULATE);

	const count = db
		.query<{ cnt: number }, []>("SELECT count(*) as cnt FROM blocks_fts")
		.get();
	console.log(`  blocks_fts ready: ${count?.cnt ?? 0} articles indexed`);
}

export interface BM25ArticleResult {
	normId: string;
	blockId: string;
	/** BM25 rank (1-based, lower is better) */
	rank: number;
}

/**
 * Threshold below which an AND-matched query is considered too sparse and
 * we re-run as OR. Tuned empirically: with K=20 the eval gold set keeps
 * R@1 ≥ baseline while killing the OR-explosion on generic-token queries
 * ("días tengo caso") where OR alone took 49s in prod.
 */
const AND_FALLBACK_THRESHOLD = 20;

/**
 * Search articles using BM25 via FTS5.
 *
 * Adaptive AND/OR: when a query has 2+ tokens we first run a strict AND
 * match (every token must appear). If that returns ≥ AND_FALLBACK_THRESHOLD
 * results we keep them — AND is dramatically cheaper for high-frequency
 * tokens because FTS5 can intersect short postings lists early. If it
 * returns less, we fall back to OR so that recall is preserved on
 * questions phrased with rare or domain-specific words.
 *
 * The decision is made by the cardinality of the result set, not by
 * a hardcoded stop-word list — so it adapts to the corpus.
 *
 * @param db - SQLite database
 * @param query - Search query (plain text, will be tokenized)
 * @param topK - Max results
 * @param normFilter - Optional: restrict to these norm IDs
 */
export function bm25ArticleSearch(
	db: Database,
	query: string,
	topK: number = 50,
	normFilter?: string[],
): BM25ArticleResult[] {
	// Sanitize query for FTS5: remove punctuation, wrap tokens in quotes.
	const tokens = query
		.replace(/[¿?¡!"'()[\]{},.:;]/g, "")
		.split(/\s+/)
		.filter((t) => t.length > 2)
		.slice(0, 12)
		.map((t) => `"${t}"`);

	if (tokens.length === 0) return [];

	const normPlaceholders = normFilter?.length
		? `AND norm_id IN (${normFilter.map(() => "?").join(",")})`
		: "";

	const runMatch = (matchExpr: string): BM25ArticleResult[] => {
		try {
			const params: (string | number)[] = [matchExpr];
			if (normFilter?.length) params.push(...normFilter);
			params.push(Math.floor(topK));

			const results = db
				.query<{ norm_id: string; block_id: string }, (string | number)[]>(
					`SELECT norm_id, block_id
           FROM blocks_fts
           WHERE blocks_fts MATCH ?
             ${normPlaceholders}
           ORDER BY bm25(blocks_fts, 0, 0, 5.0, 8.0, 1.0)
           LIMIT ?`,
				)
				.all(...params);

			return results.map((r, i) => ({
				normId: r.norm_id,
				blockId: r.block_id,
				rank: i + 1,
			}));
		} catch (err) {
			// FTS5 parse errors, schema mismatches and lock contention all
			// surface here. Returning [] is the right behaviour (the AND
			// path triggers OR fallback by length<threshold; the OR path
			// just yields zero candidates and the rest of the RRF systems
			// carry the load), but a silent swallow makes prod failures
			// invisible. Log so diagnostics show up in container logs and
			// Opik traces without breaking retrieval.
			console.warn(
				`[bm25] FTS5 query failed for "${matchExpr.slice(0, 80)}": ${(err as Error).message}`,
			);
			return [];
		}
	};

	// Single-token: AND ≡ OR, just run it once.
	if (tokens.length === 1) return runMatch(tokens[0]!);

	// Multi-token: try AND first, fall back to OR if too sparse.
	const andResults = runMatch(tokens.join(" AND "));
	if (andResults.length >= AND_FALLBACK_THRESHOLD) return andResults;
	return runMatch(tokens.join(" OR "));
}

/**
 * Search articles using BM25 with LLM-expanded keywords.
 * Runs two queries (original + expanded) and deduplicates, preserving best rank.
 */
export function bm25HybridSearch(
	db: Database,
	originalQuery: string,
	expandedKeywords: string[],
	topK: number = 50,
	normFilter?: string[],
): BM25ArticleResult[] {
	const results1 = bm25ArticleSearch(db, originalQuery, topK, normFilter);
	const expandedQuery = expandedKeywords.join(" ");
	const results2 = expandedQuery
		? bm25ArticleSearch(db, expandedQuery, topK, normFilter)
		: [];

	// Merge keeping best rank per article
	const seen = new Map<string, BM25ArticleResult>();
	for (const r of [...results1, ...results2]) {
		const key = `${r.normId}:${r.blockId}`;
		const existing = seen.get(key);
		if (!existing || r.rank < existing.rank) {
			seen.set(key, r);
		}
	}

	// Re-rank by original rank
	const merged = [...seen.values()];
	merged.sort((a, b) => a.rank - b.rank);
	return merged.slice(0, topK).map((r, i) => ({ ...r, rank: i + 1 }));
}
