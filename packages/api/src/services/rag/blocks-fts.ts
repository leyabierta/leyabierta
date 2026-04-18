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
  content,
  tokenize='unicode61 remove_diacritics 2'
)`;

const POPULATE = `
INSERT INTO blocks_fts (norm_id, block_id, title, content)
SELECT b.norm_id, b.block_id, b.title, b.current_text
FROM blocks b
WHERE b.block_type = 'precepto'
  AND b.current_text != ''`;

/**
 * Ensure blocks_fts exists and is populated. Idempotent — skips if already built.
 */
export function ensureBlocksFts(db: Database): void {
	// Check if the table already has data
	try {
		const count = db
			.query<{ cnt: number }, []>("SELECT count(*) as cnt FROM blocks_fts")
			.get();
		if (count && count.cnt > 0) return; // already populated
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
 * Search articles using BM25 via FTS5.
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
	// Sanitize query for FTS5: remove punctuation, wrap tokens in quotes
	const safeQuery = query
		.replace(/[¿?¡!"'()[\]{},.:;]/g, "")
		.split(/\s+/)
		.filter((t) => t.length > 2)
		.slice(0, 12)
		.map((t) => `"${t}"`)
		.join(" OR ");

	if (!safeQuery) return [];

	const normClause = normFilter?.length
		? `AND norm_id IN (${normFilter.map((id) => `'${id}'`).join(",")})`
		: "";

	try {
		const results = db
			.query<{ norm_id: string; block_id: string }, [string]>(
				`SELECT norm_id, block_id
         FROM blocks_fts
         WHERE blocks_fts MATCH ?
           ${normClause}
         ORDER BY bm25(blocks_fts, 0, 0, 5.0, 1.0)
         LIMIT ${topK}`,
			)
			.all(safeQuery);

		return results.map((r, i) => ({
			normId: r.norm_id,
			blockId: r.block_id,
			rank: i + 1,
		}));
	} catch {
		return [];
	}
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
