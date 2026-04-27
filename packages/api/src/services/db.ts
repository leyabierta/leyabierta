/**
 * SQLite query service for the API.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { BASE_MATERIAS } from "../data/materia-mappings.ts";
import type { HybridSearcher } from "./hybrid-search.ts";
import {
	adaptiveSearch,
	ensureNormsFtsVocab,
	tokenizeQuery,
} from "./norms-fts-search.ts";

type SqlParams = SQLQueryBindings[];

export type SearchMode = "bm25" | "hybrid";

export interface SearchFilters {
	country?: string;
	jurisdiction?: string;
	rank?: string;
	status?: string;
	materia?: string;
	citizen_tag?: string;
}

export interface LawRow {
	id: string;
	title: string;
	short_title: string;
	country: string;
	rank: string;
	published_at: string;
	updated_at: string | null;
	status: string;
	department: string;
	source_url: string;
	citizen_summary: string;
}

export interface BlockRow {
	norm_id: string;
	block_id: string;
	block_type: string;
	title: string;
	position: number;
	current_text: string;
	citizen_summary: string | null;
}

export interface ReformRow {
	norm_id: string;
	date: string;
	source_id: string;
}

export interface ReformBlockRow {
	block_id: string;
}

export interface VersionRow {
	norm_id: string;
	block_id: string;
	date: string;
	source_id: string;
	text: string;
}

export class DbService {
	constructor(private db: Database) {
		ensureNormsFtsVocab(db);
	}

	searchLaws(
		query: string | undefined,
		filters: {
			country?: string;
			jurisdiction?: string;
			rank?: string;
			status?: string;
			materia?: string;
			citizen_tag?: string;
		},
		limit: number,
		offset: number,
		sort?: string,
	): { laws: LawRow[]; total: number; capped?: boolean } {
		if (query) {
			// If the query looks like a norm ID (e.g. BOE-A-2018-6405), search by ID directly
			const isNormId = /^[A-Z]+-[A-Z]+-\d{4}-\d+$/i.test(query.trim());

			if (isNormId) {
				const law = this.db
					.query<LawRow, [string]>("SELECT * FROM norms WHERE id = ?")
					.get(query.trim().toUpperCase());
				return law ? { laws: [law], total: 1 } : { laws: [], total: 0 };
			}

			// Tokenize once for adaptive AND→OR. tokens are pre-quoted so hyphens
			// and special chars don't trip the FTS5 parser. Tokens of length ≤2
			// are dropped (Spanish particles like "de", "la", "el" — they're noise
			// for relevance and explode posting-list cost when AND-joined).
			const tokens = tokenizeQuery(query);

			// Build filter conditions for the JOIN
			const conditions: string[] = [];
			const filterParams: SqlParams = [];
			this.applyFilters(conditions, filterParams, filters);
			// For non-relevance sorts: use a single efficient JOIN query
			if (sort === "recent" || sort === "oldest" || sort === "title") {
				const orderMap = {
					recent: "ORDER BY published_at DESC",
					oldest: "ORDER BY published_at ASC",
					title: "ORDER BY title ASC",
				};
				try {
					// Cap each FTS pass at 5000 ids — paginated UI never needs more
					// and ORDER BY bm25 LIMIT k lets FTS5 short-circuit on top-k.
					const FTS_PAGE_CAP = 5000;
					// One row per norm_id in norms_fts (norm_id is UNINDEXED and
					// each document is inserted exactly once at ingest), so DISTINCT
					// is a no-op that prevents FTS5's top-k early termination.
					// Removing it lets the planner stop scanning postings once it
					// has the LIMIT-ranked rows.
					const runTitleMatch = (matchExpr: string): string[] =>
						this.db
							.query<{ norm_id: string }, [string]>(
								`SELECT norm_id FROM norms_fts
								 WHERE norms_fts MATCH ?
								 ORDER BY bm25(norms_fts, 0, 10.0, 1.0, 15.0, 12.0)
								 LIMIT ${FTS_PAGE_CAP}`,
							)
							.all(matchExpr)
							.map((r) => r.norm_id);

					const titleMatchIds = adaptiveSearch(this.db, {
						tokens,
						matchExprBuilder: (toks, joiner) =>
							`title:(${toks.join(` ${joiner} `)})`,
						runMatch: runTitleMatch,
					});

					let ftsIds = titleMatchIds;
					if (titleMatchIds.length < FTS_PAGE_CAP) {
						const seen = new Set(titleMatchIds);
						const runContentMatch = (matchExpr: string): string[] =>
							this.db
								.query<{ norm_id: string }, [string]>(
									`SELECT norm_id FROM norms_fts
									 WHERE norms_fts MATCH ?
									 ORDER BY bm25(norms_fts)
									 LIMIT ${FTS_PAGE_CAP}`,
								)
								.all(matchExpr)
								.map((r) => r.norm_id)
								.filter((id) => !seen.has(id));
						const contentIds = adaptiveSearch(this.db, {
							tokens,
							matchExprBuilder: (toks, joiner) => toks.join(` ${joiner} `),
							runMatch: runContentMatch,
						});
						ftsIds = [...titleMatchIds, ...contentIds];
					}
					if (ftsIds.length === 0) return { laws: [], total: 0 };

					// For sorted search, use the relevance path to get filtered IDs,
					// then fetch sorted page from norms table
					const hasFilters2 =
						filters.country ||
						filters.jurisdiction ||
						filters.rank ||
						filters.status ||
						filters.materia ||
						filters.citizen_tag;

					let sortedIds = ftsIds;
					if (hasFilters2) {
						// Chunk large ID sets to avoid SQLite variable limit
						sortedIds = this.filterIdsByChunks(ftsIds, filters);
					}

					const total = sortedIds.length;
					if (total === 0) return { laws: [], total: 0 };

					// For the final page, use a reasonable chunk
					const pageIds = sortedIds.slice(0, Math.min(sortedIds.length, 5000));
					const placeholders = pageIds.map(() => "?").join(",");
					const laws = this.db
						.query<LawRow, SqlParams>(
							`SELECT * FROM norms WHERE id IN (${placeholders})
							 ${orderMap[sort]} LIMIT ? OFFSET ?`,
						)
						.all(...pageIds, limit, offset);
					return { laws, total };
				} catch {
					return { laws: [], total: 0 };
				}
			}

			// Default: FTS relevance order — three-pass:
			//   Pass 0  exact/prefix title LIKE  (always wins)
			//   Pass 1  FTS title MATCH with BM25 (adaptive AND→OR)
			//   Pass 2  FTS content MATCH with BM25 (adaptive AND→OR)
			// Cap at 500 — paginated UI never reaches the cap and ORDER BY bm25
			// LIMIT k lets FTS5 short-circuit on top-k instead of scanning the
			// full intersection.
			const FTS_CAP = 500;
			try {
				// Pass 0: exact/prefix title matches (highest relevance)
				// These go first regardless of BM25 score
				const exactIds = this.db
					.query<{ id: string }, [string, string]>(
						`SELECT id FROM norms
						 WHERE title LIKE ? OR title LIKE ?
						 ORDER BY length(title) ASC
						 LIMIT 20`,
					)
					.all(`${query}%`, `% ${query}%`)
					.map((r) => r.id);

				// Pass 1: FTS title matches (fast, most relevant). Adaptive
				// AND→OR — multi-token queries first try AND, fall back to OR
				// (with high-DF tokens pruned via fts5vocab) if AND yields too
				// few results. No hardcoded stop-word list.
				const exactSet = new Set(exactIds);
				// DISTINCT removed — norm_id is unique per row in norms_fts, so it
				// was a no-op blocking FTS5 top-k early termination.
				const runTitleMatch = (matchExpr: string): string[] =>
					this.db
						.query<{ norm_id: string }, [string]>(
							`SELECT norm_id FROM norms_fts
							 WHERE norms_fts MATCH ?
							 ORDER BY bm25(norms_fts, 0, 10.0, 1.0, 15.0, 12.0)
							 LIMIT ${FTS_CAP}`,
						)
						.all(matchExpr)
						.map((r) => r.norm_id)
						.filter((id) => !exactSet.has(id));
				const titleIds = adaptiveSearch(this.db, {
					tokens,
					matchExprBuilder: (toks, joiner) =>
						`title:(${toks.join(` ${joiner} `)})`,
					runMatch: runTitleMatch,
				});

				let allIds = [...exactIds, ...titleIds];

				// Pass 2: content matches if we need more results.
				if (allIds.length < FTS_CAP) {
					const seen = new Set(allIds);
					const runContentMatch = (matchExpr: string): string[] =>
						this.db
							.query<{ norm_id: string }, [string]>(
								`SELECT norm_id FROM norms_fts
								 WHERE norms_fts MATCH ?
								 ORDER BY bm25(norms_fts)
								 LIMIT ${FTS_CAP}`,
							)
							.all(matchExpr)
							.map((r) => r.norm_id)
							.filter((id) => !seen.has(id));
					const contentIds = adaptiveSearch(this.db, {
						tokens,
						matchExprBuilder: (toks, joiner) => toks.join(` ${joiner} `),
						runMatch: runContentMatch,
					});
					allIds = [...allIds, ...contentIds].slice(0, FTS_CAP);
				}

				// Apply filters in the norms table
				const hasFilters =
					filters.country ||
					filters.jurisdiction ||
					filters.rank ||
					filters.status ||
					filters.materia ||
					filters.citizen_tag;
				let filteredIds = allIds;
				if (hasFilters && allIds.length > 0) {
					const filteredSet = new Set(this.filterIdsByChunks(allIds, filters));
					filteredIds = allIds.filter((id) => filteredSet.has(id));
				}

				const matchIds = filteredIds.map((id) => ({ norm_id: id }));

				const ids = matchIds.map((r) => r.norm_id);
				const total = ids.length;
				const pageIds = ids.slice(offset, offset + limit);
				if (pageIds.length === 0) return { laws: [], total };

				// Fetch only the page-worth of rows
				const placeholders = pageIds.map(() => "?").join(",");
				const rows = this.db
					.query<LawRow, SqlParams>(
						`SELECT * FROM norms WHERE id IN (${placeholders})`,
					)
					.all(...pageIds);

				// Re-sort in JS to match FTS relevance order
				const rowMap = new Map(rows.map((r) => [r.id, r]));
				const laws = pageIds
					.map((id) => rowMap.get(id))
					.filter((r): r is LawRow => r != null);

				const capped = allIds.length >= FTS_CAP;
				return { laws, total, capped };
			} catch {
				// FTS failed, fallback to LIKE on title
				const conditions2: string[] = ["title LIKE ?"];
				const params2: SqlParams = [`%${query}%`];
				this.applyFilters(conditions2, params2, filters);
				const where = conditions2.join(" AND ");

				const total = this.db
					.query<{ c: number }, SqlParams>(
						`SELECT count(*) as c FROM norms WHERE ${where}`,
					)
					.get(...params2)!.c;

				const laws = this.db
					.query<LawRow, SqlParams>(
						`SELECT * FROM norms WHERE ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`,
					)
					.all(...params2, limit, offset);
				return { laws, total };
			}
		}

		// No query — filter + paginate
		const conditions: string[] = [];
		const params: SqlParams = [];

		this.applyFilters(conditions, params, filters);

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

		const total = this.db
			.query<{ c: number }, SqlParams>(
				`SELECT count(*) as c FROM norms ${where}`,
			)
			.get(...params)!.c;

		let noQueryOrder = "ORDER BY published_at DESC";
		if (sort === "oldest") noQueryOrder = "ORDER BY published_at ASC";
		else if (sort === "title") noQueryOrder = "ORDER BY title ASC";

		const laws = this.db
			.query<LawRow, SqlParams>(
				`SELECT * FROM norms ${where} ${noQueryOrder} LIMIT ? OFFSET ?`,
			)
			.all(...params, limit, offset);

		return { laws, total };
	}

	getLaw(id: string): LawRow | null {
		return this.db
			.query<LawRow, [string]>("SELECT * FROM norms WHERE id = ?")
			.get(id);
	}

	/** List distinct materias with norm count, for the filter dropdown. */
	listMaterias(): Array<{ materia: string; count: number }> {
		return this.db
			.query<{ materia: string; count: number }, []>(
				"SELECT materia, count(*) as count FROM materias GROUP BY materia ORDER BY count DESC",
			)
			.all();
	}

	/**
	 * Hybrid search — BM25 + vector KNN fused via RRF (Issue #40).
	 *
	 * Default retrieval path for relevance-ranked free-text queries on
	 * /v1/laws. Steps:
	 *   1. Compute BM25 ranked norm IDs (top-K, unfiltered).
	 *   2. Embed the query (cached LRU) and KNN over `vectors.bin`.
	 *   3. Aggregate article scores → norm scores (max-pool + sum-pool).
	 *   4. RRF fuse BM25 + vector_max + vector_sum lists.
	 *   5. Apply filters in chunks, paginate, hydrate LawRow.
	 *
	 * Latency budget per query: ~80ms (Cloudflare edge cache hit) / ~800ms
	 * (LRU cache hit, KNN only) / ~3000ms (cold: embed API + KNN).
	 *
	 * Embedding-API failures propagate — there is no silent fallback to
	 * BM25. Wrong answers are worse than 503s; operators must see config
	 * problems.
	 */
	async searchLawsHybrid(
		query: string,
		filters: SearchFilters,
		limit: number,
		offset: number,
		hybridSearcher: HybridSearcher,
	): Promise<{ laws: LawRow[]; total: number; capped?: boolean }> {
		const trimmed = query.trim();
		if (!trimmed) {
			return this.searchLaws(undefined, filters, limit, offset);
		}

		// Norm-ID short-circuit: same behavior as BM25 path.
		const isNormId = /^[A-Z]+-[A-Z]+-\d{4}-\d+$/i.test(trimmed);
		if (isNormId) {
			const law = this.db
				.query<LawRow, [string]>("SELECT * FROM norms WHERE id = ?")
				.get(trimmed.toUpperCase());
			return law ? { laws: [law], total: 1 } : { laws: [], total: 0 };
		}

		// 1. BM25 ranked norm IDs (unfiltered, larger cap so the fusion has
		//    enough candidates to pick from).
		const bm25Ids = this.bm25RankedNormIds(trimmed, 500);

		// 2. Hybrid fusion (BM25 ranks + vector ranks).
		const { fused } = await hybridSearcher.rankNorms(trimmed, bm25Ids, {
			articleTopK: 200,
			normTopK: 500,
		});

		if (fused.length === 0) return { laws: [], total: 0 };

		// 3. Apply filters across the fused IDs.
		const hasFilters =
			!!filters.country ||
			!!filters.jurisdiction ||
			!!filters.rank ||
			!!filters.status ||
			!!filters.materia ||
			!!filters.citizen_tag;
		let filteredIds = fused;
		if (hasFilters) {
			const filteredSet = new Set(this.filterIdsByChunks(fused, filters));
			filteredIds = fused.filter((id) => filteredSet.has(id));
		}

		const total = filteredIds.length;
		const pageIds = filteredIds.slice(offset, offset + limit);
		if (pageIds.length === 0) return { laws: [], total };

		const placeholders = pageIds.map(() => "?").join(",");
		const rows = this.db
			.query<LawRow, SqlParams>(
				`SELECT * FROM norms WHERE id IN (${placeholders})`,
			)
			.all(...pageIds);
		const rowMap = new Map(rows.map((r) => [r.id, r]));
		const laws = pageIds
			.map((id) => rowMap.get(id))
			.filter((r): r is LawRow => r != null);

		return { laws, total };
	}

	/**
	 * Run the same three-pass BM25 the default `searchLaws` path runs, but
	 * return only the ranked norm IDs (no filters, no pagination). Used by
	 * `searchLawsHybrid` to feed RRF.
	 */
	private bm25RankedNormIds(query: string, cap: number): string[] {
		const tokens = tokenizeQuery(query);
		try {
			// Pass 0: exact/prefix title.
			const exactIds = this.db
				.query<{ id: string }, [string, string]>(
					`SELECT id FROM norms
					 WHERE title LIKE ? OR title LIKE ?
					 ORDER BY length(title) ASC
					 LIMIT 20`,
				)
				.all(`${query}%`, `% ${query}%`)
				.map((r) => r.id);

			const exactSet = new Set(exactIds);

			// Pass 1: FTS title MATCH.
			const runTitleMatch = (matchExpr: string): string[] =>
				this.db
					.query<{ norm_id: string }, [string]>(
						`SELECT norm_id FROM norms_fts
						 WHERE norms_fts MATCH ?
						 ORDER BY bm25(norms_fts, 0, 10.0, 1.0, 15.0, 12.0)
						 LIMIT ${cap}`,
					)
					.all(matchExpr)
					.map((r) => r.norm_id)
					.filter((id) => !exactSet.has(id));
			const titleIds = adaptiveSearch(this.db, {
				tokens,
				matchExprBuilder: (toks, joiner) =>
					`title:(${toks.join(` ${joiner} `)})`,
				runMatch: runTitleMatch,
			});

			let allIds = [...exactIds, ...titleIds];

			// Pass 2: FTS content MATCH.
			if (allIds.length < cap) {
				const seen = new Set(allIds);
				const runContentMatch = (matchExpr: string): string[] =>
					this.db
						.query<{ norm_id: string }, [string]>(
							`SELECT norm_id FROM norms_fts
							 WHERE norms_fts MATCH ?
							 ORDER BY bm25(norms_fts)
							 LIMIT ${cap}`,
						)
						.all(matchExpr)
						.map((r) => r.norm_id)
						.filter((id) => !seen.has(id));
				const contentIds = adaptiveSearch(this.db, {
					tokens,
					matchExprBuilder: (toks, joiner) => toks.join(` ${joiner} `),
					runMatch: runContentMatch,
				});
				allIds = [...allIds, ...contentIds].slice(0, cap);
			}
			return allIds;
		} catch {
			return [];
		}
	}

	/** Filter a large ID array through norms table in chunks to avoid SQLite variable limits. */
	private filterIdsByChunks(
		ids: string[],
		filters: {
			country?: string;
			rank?: string;
			status?: string;
			materia?: string;
			citizen_tag?: string;
		},
	): string[] {
		const CHUNK = 500;
		const result: string[] = [];
		for (let i = 0; i < ids.length; i += CHUNK) {
			const chunk = ids.slice(i, i + CHUNK);
			const conds: string[] = [`id IN (${chunk.map(() => "?").join(",")})`];
			const params: SqlParams = [...chunk];
			this.applyFilters(conds, params, filters);
			const filtered = this.db
				.query<{ id: string }, SqlParams>(
					`SELECT id FROM norms WHERE ${conds.join(" AND ")}`,
				)
				.all(...params);
			result.push(...filtered.map((r) => r.id));
		}
		return result;
	}

	private applyFilters(
		conditions: string[],
		params: SqlParams,
		filters: {
			country?: string;
			jurisdiction?: string;
			rank?: string;
			status?: string;
			materia?: string;
			citizen_tag?: string;
		},
	): void {
		if (filters.jurisdiction) {
			conditions.push("jurisdiction = ?");
			params.push(filters.jurisdiction);
		} else if (filters.country) {
			conditions.push("country = ?");
			params.push(filters.country);
		}
		if (filters.rank) {
			conditions.push("rank = ?");
			params.push(filters.rank);
		}
		if (filters.status) {
			conditions.push("status = ?");
			params.push(filters.status);
		}
		if (filters.materia) {
			conditions.push("id IN (SELECT norm_id FROM materias WHERE materia = ?)");
			params.push(filters.materia);
		}
		if (filters.citizen_tag) {
			conditions.push("id IN (SELECT norm_id FROM citizen_tags WHERE tag = ?)");
			params.push(filters.citizen_tag);
		}
	}

	getBlocks(normId: string): BlockRow[] {
		return this.db
			.query<BlockRow, [string]>(
				`SELECT b.*, cas.summary as citizen_summary
				 FROM blocks b
				 LEFT JOIN citizen_article_summaries cas
				   ON cas.norm_id = b.norm_id AND cas.block_id = b.block_id
				 WHERE b.norm_id = ? ORDER BY b.position`,
			)
			.all(normId);
	}

	getBlockByPosition(normId: string, position: number): BlockRow | null {
		return this.db
			.query<BlockRow, [string, number]>(
				"SELECT * FROM blocks WHERE norm_id = ? AND position = ?",
			)
			.get(normId, position);
	}

	getReforms(normId: string): ReformRow[] {
		return this.db
			.query<ReformRow, [string]>(
				"SELECT * FROM reforms WHERE norm_id = ? ORDER BY date",
			)
			.all(normId);
	}

	getReformBlocks(normId: string, date: string, sourceId: string): string[] {
		return this.db
			.query<ReformBlockRow, [string, string, string]>(
				"SELECT block_id FROM reform_blocks WHERE norm_id = ? AND reform_date = ? AND reform_source_id = ?",
			)
			.all(normId, date, sourceId)
			.map((r) => r.block_id);
	}

	/** Single query: get all reforms with their affected blocks via JOIN + GROUP_CONCAT. */
	getReformsWithBlocks(
		normId: string,
	): Array<ReformRow & { affected_blocks: string[] }> {
		return this.db
			.query<ReformRow & { block_list: string | null }, [string]>(
				`SELECT r.norm_id, r.date, r.source_id, GROUP_CONCAT(rb.block_id) as block_list
				 FROM reforms r
				 LEFT JOIN reform_blocks rb
				   ON rb.norm_id = r.norm_id AND rb.reform_date = r.date AND rb.reform_source_id = r.source_id
				 WHERE r.norm_id = ?
				 GROUP BY r.norm_id, r.date, r.source_id
				 ORDER BY r.date`,
			)
			.all(normId)
			.map((r) => ({
				norm_id: r.norm_id,
				date: r.date,
				source_id: r.source_id,
				affected_blocks: r.block_list ? r.block_list.split(",") : [],
			}));
	}

	getVersions(normId: string, blockId: string): VersionRow[] {
		return this.db
			.query<VersionRow, [string, string]>(
				"SELECT * FROM versions WHERE norm_id = ? AND block_id = ? ORDER BY date",
			)
			.all(normId, blockId);
	}

	getRanks(): Array<{ rank: string; count: number }> {
		return this.db
			.query<{ rank: string; count: number }, []>(
				"SELECT rank, count(*) as count FROM norms GROUP BY rank ORDER BY count DESC",
			)
			.all();
	}

	/** Recently changed laws (by latest reform date, excluding future anomalies). */
	getRecentlyUpdated(limit: number): Array<{
		id: string;
		title: string;
		last_reform: string;
		citizen_summary: string | null;
	}> {
		const today = new Date().toISOString().slice(0, 10);
		return this.db
			.query<
				{
					id: string;
					title: string;
					last_reform: string;
					citizen_summary: string | null;
				},
				[string, number]
			>(
				`SELECT n.id, n.title, n.citizen_summary, MAX(r.date) AS last_reform
				 FROM norms n
				 JOIN reforms r ON r.norm_id = n.id
				 WHERE r.date <= ?
				 GROUP BY n.id
				 ORDER BY last_reform DESC LIMIT ?`,
			)
			.all(today, limit);
	}

	/** Recent individual reforms for RSS feed (excluding future anomalies). */
	getRecentReforms(limit: number): Array<
		ReformRow & {
			title: string;
			headline: string | null;
			summary: string | null;
			reform_type: string | null;
			importance: string | null;
		}
	> {
		const today = new Date().toISOString().slice(0, 10);
		return this.db
			.query<
				ReformRow & {
					title: string;
					headline: string | null;
					summary: string | null;
					reform_type: string | null;
					importance: string | null;
				},
				[string, number]
			>(
				`SELECT r.*, n.title,
					rs.headline, rs.summary, rs.reform_type, rs.importance
				 FROM reforms r
				 JOIN norms n ON n.id = r.norm_id
				 LEFT JOIN reform_summaries rs
					ON rs.norm_id = r.norm_id AND rs.source_id = r.source_id AND rs.reform_date = r.date
				 WHERE r.date <= ?
				 ORDER BY r.date DESC LIMIT ?`,
			)
			.all(today, limit);
	}

	/** Global stats for the home page. */
	getStats(): {
		norms: number;
		articles: number;
		versions: number;
		reforms: number;
		categories: number;
		oldest: string;
		newest: string;
	} {
		const norms = this.db
			.query<{ c: number }, []>("SELECT count(*) as c FROM norms")
			.get()!.c;
		const articles = this.db
			.query<{ c: number }, []>(
				"SELECT count(*) as c FROM blocks WHERE block_type = 'precepto'",
			)
			.get()!.c;
		const versions = this.db
			.query<{ c: number }, []>(
				"SELECT count(*) as c FROM versions v JOIN blocks b ON b.norm_id = v.norm_id AND b.block_id = v.block_id WHERE b.block_type = 'precepto'",
			)
			.get()!.c;
		const reforms = this.db
			.query<{ c: number }, []>("SELECT count(*) as c FROM reforms")
			.get()!.c;
		const categories = this.db
			.query<{ c: number }, []>(
				"SELECT count(DISTINCT materia) as c FROM materias",
			)
			.get()!.c;
		const oldest = this.db
			.query<{ d: string }, []>("SELECT min(published_at) as d FROM norms")
			.get()!.d;
		const newest = this.db
			.query<{ d: string }, []>("SELECT max(published_at) as d FROM norms")
			.get()!.d;
		return { norms, articles, versions, reforms, categories, oldest, newest };
	}

	/** Most reformed laws, for the home page. */
	getMostReformed(limit: number): Array<{
		id: string;
		title: string;
		rank: string;
		reform_count: number;
		published_at: string;
	}> {
		return this.db
			.query<
				{
					id: string;
					title: string;
					rank: string;
					reform_count: number;
					published_at: string;
				},
				[number]
			>(
				`SELECT n.id, n.title, n.rank, n.published_at, count(*) as reform_count
				 FROM reforms r JOIN norms n ON n.id = r.norm_id
				 GROUP BY n.id ORDER BY reform_count DESC LIMIT ?`,
			)
			.all(limit);
	}

	/** Jurisdiction counts for the home page. */
	getJurisdictions(): Array<{ jurisdiction: string; count: number }> {
		return this.db
			.query<{ jurisdiction: string; count: number }, []>(
				`SELECT
					CASE
						WHEN source_url LIKE '%/eli/es/%' AND source_url NOT LIKE '%/eli/es-__/%' THEN 'es'
						WHEN source_url LIKE '%/eli/es-an/%' THEN 'es-an'
						WHEN source_url LIKE '%/eli/es-ar/%' THEN 'es-ar'
						WHEN source_url LIKE '%/eli/es-as/%' THEN 'es-as'
						WHEN source_url LIKE '%/eli/es-cb/%' THEN 'es-cb'
						WHEN source_url LIKE '%/eli/es-cl/%' THEN 'es-cl'
						WHEN source_url LIKE '%/eli/es-cm/%' THEN 'es-cm'
						WHEN source_url LIKE '%/eli/es-cn/%' THEN 'es-cn'
						WHEN source_url LIKE '%/eli/es-ct/%' THEN 'es-ct'
						WHEN source_url LIKE '%/eli/es-ex/%' THEN 'es-ex'
						WHEN source_url LIKE '%/eli/es-ga/%' THEN 'es-ga'
						WHEN source_url LIKE '%/eli/es-ib/%' THEN 'es-ib'
						WHEN source_url LIKE '%/eli/es-mc/%' THEN 'es-mc'
						WHEN source_url LIKE '%/eli/es-md/%' THEN 'es-md'
						WHEN source_url LIKE '%/eli/es-nc/%' THEN 'es-nc'
						WHEN source_url LIKE '%/eli/es-pv/%' THEN 'es-pv'
						WHEN source_url LIKE '%/eli/es-ri/%' THEN 'es-ri'
						WHEN source_url LIKE '%/eli/es-vc/%' THEN 'es-vc'
						ELSE 'es'
					END as jurisdiction,
					count(*) as count
				 FROM norms GROUP BY jurisdiction ORDER BY count DESC`,
			)
			.all();
	}

	getMaterias(normId: string): string[] {
		return this.db
			.query<{ materia: string }, [string]>(
				"SELECT materia FROM materias WHERE norm_id = ? ORDER BY materia",
			)
			.all(normId)
			.map((r) => r.materia);
	}

	getCitizenTags(normId: string): string[] {
		return this.db
			.query<{ tag: string }, [string]>(
				"SELECT DISTINCT tag FROM citizen_tags WHERE norm_id = ? AND block_id = '' ORDER BY tag",
			)
			.all(normId)
			.map((r) => r.tag);
	}

	listCitizenTags(limit = 100): Array<{ tag: string; count: number }> {
		return this.db
			.query<{ tag: string; count: number }, [number]>(
				"SELECT tag, COUNT(DISTINCT norm_id) as count FROM citizen_tags GROUP BY tag ORDER BY count DESC LIMIT ?",
			)
			.all(limit);
	}

	getNotas(normId: string): string[] {
		return this.db
			.query<{ nota: string }, [string]>(
				"SELECT nota FROM notas WHERE norm_id = ? ORDER BY position",
			)
			.all(normId)
			.map((r) => r.nota);
	}

	getReferencias(
		normId: string,
		direction: "anterior" | "posterior",
	): Array<{ relation: string; target_id: string; text: string }> {
		return this.db
			.query<
				{ relation: string; target_id: string; text: string },
				[string, string]
			>(
				"SELECT relation, target_id, text FROM referencias WHERE norm_id = ? AND direction = ? ORDER BY relation, target_id",
			)
			.all(normId, direction);
	}

	hasAnalisis(normId: string): boolean {
		const r = this.db
			.query<{ c: number }, [string]>(
				"SELECT count(*) as c FROM materias WHERE norm_id = ?",
			)
			.get(normId);
		const r2 = this.db
			.query<{ c: number }, [string]>(
				"SELECT count(*) as c FROM referencias WHERE norm_id = ?",
			)
			.get(normId);
		return (r?.c ?? 0) + (r2?.c ?? 0) > 0;
	}

	// ── Norm follows ──

	upsertNormFollow(email: string, normId: string, token: string): void {
		this.db
			.query(
				`INSERT INTO norm_follows (email, norm_id, confirmed, token)
				 VALUES (?, ?, 0, ?)
				 ON CONFLICT(email, norm_id)
				 DO UPDATE SET token = excluded.token, confirmed = 0, created_at = datetime('now')`,
			)
			.run(email, normId, token);
	}

	deleteNormFollowsByEmail(email: string): void {
		this.db.query("DELETE FROM norm_follows WHERE email = ?").run(email);
	}

	confirmNormFollow(token: string): boolean {
		const result = this.db
			.query(
				"UPDATE norm_follows SET confirmed = 1 WHERE token = ? AND confirmed = 0",
			)
			.run(token);
		return result.changes > 0;
	}

	getRecentReformsByMaterias(
		materias: string[],
		jurisdiction: string,
		since: string,
		limit = 20,
		offset = 0,
	): Array<{
		id: string;
		title: string;
		rank: string;
		status: string;
		date: string;
		source_id: string;
		headline: string | null;
		summary: string | null;
		reform_type: string | null;
		importance: string | null;
		materia_count: number;
		match_ratio: number;
		omnibus_topic_count: number;
	}> {
		if (materias.length === 0) return [];

		// Validate jurisdiction to prevent SQL injection
		if (!/^es(-[a-z]{2})?$/.test(jurisdiction)) {
			return [];
		}

		// Match on non-base materias only (specific to user's situation).
		// Base materias (IRPF, SS, Consumidores, Derechos) are too generic and match
		// almost every law. If user has NO non-base materias, fall back to all.
		const matchMaterias = materias.filter((m) => !BASE_MATERIAS.includes(m));
		const effectiveMaterias =
			matchMaterias.length > 0 ? matchMaterias : materias;
		const placeholders = effectiveMaterias.map(() => "?").join(",");

		// If jurisdiction is 'es' (national), include only national laws.
		// Otherwise include BOTH regional AND national laws (national laws apply everywhere).
		let jurisdictionClause: string;
		const jurisdictionParams: string[] = [];

		if (jurisdiction === "es") {
			jurisdictionClause = "(n.source_url LIKE ? AND n.source_url NOT LIKE ?)";
			jurisdictionParams.push("%/eli/es/%", "%/eli/es-__/%");
		} else {
			jurisdictionClause =
				"(n.source_url LIKE ? OR (n.source_url LIKE ? AND n.source_url NOT LIKE ?))";
			jurisdictionParams.push(
				`%/eli/${jurisdiction}/%`,
				"%/eli/es/%",
				"%/eli/es-__/%",
			);
		}

		const sql = `
			WITH materia_weights AS (
				SELECT m.norm_id,
					COUNT(CASE WHEN m.materia IN (${placeholders}) THEN 1 END) as matched,
					COUNT(*) as total
				FROM materias m
				GROUP BY m.norm_id
			)
			SELECT DISTINCT n.id, n.title, n.rank, n.status, r.date, r.source_id,
				rs.headline, rs.summary, rs.reform_type, rs.importance,
				mw.total as materia_count,
				CAST(mw.matched AS REAL) / NULLIF(mw.total, 0) as match_ratio,
				(SELECT COUNT(*) FROM omnibus_topics WHERE norm_id = r.norm_id) as omnibus_topic_count
			FROM reforms r
			JOIN norms n ON n.id = r.norm_id
			JOIN materia_weights mw ON mw.norm_id = r.norm_id AND mw.matched > 0
			LEFT JOIN reform_summaries rs
				ON rs.norm_id = r.norm_id AND rs.source_id = r.source_id AND rs.reform_date = r.date
			WHERE r.date >= ?
			  AND ${jurisdictionClause}
			  AND (rs.importance IS NULL OR rs.importance NOT IN ('skip'))
			ORDER BY match_ratio DESC, r.date DESC
			LIMIT ? OFFSET ?
		`;

		return this.db
			.query<
				{
					id: string;
					title: string;
					rank: string;
					status: string;
					date: string;
					source_id: string;
					headline: string | null;
					summary: string | null;
					reform_type: string | null;
					importance: string | null;
					materia_count: number;
					match_ratio: number;
					omnibus_topic_count: number;
				},
				SqlParams
			>(sql)
			.all(...effectiveMaterias, since, ...jurisdictionParams, limit, offset);
	}

	getChangelog(
		since: string,
		jurisdiction?: string,
		limit = 50,
	): Array<{
		id: string;
		title: string;
		rank: string;
		status: string;
		date: string;
		source_id: string;
		headline: string | null;
		summary: string | null;
		reform_type: string | null;
		importance: string | null;
		materia_count: number;
		omnibus_topic_count: number;
	}> {
		if (jurisdiction && !/^es(-[a-z]{2})?$/.test(jurisdiction)) {
			return [];
		}

		let jurisdictionClause = "";
		const jurisdictionParams: string[] = [];

		if (jurisdiction) {
			if (jurisdiction === "es") {
				jurisdictionClause =
					"AND (n.source_url LIKE ? AND n.source_url NOT LIKE ?)";
				jurisdictionParams.push("%/eli/es/%", "%/eli/es-__/%");
			} else {
				jurisdictionClause =
					"AND (n.source_url LIKE ? OR (n.source_url LIKE ? AND n.source_url NOT LIKE ?))";
				jurisdictionParams.push(
					`%/eli/${jurisdiction}/%`,
					"%/eli/es/%",
					"%/eli/es-__/%",
				);
			}
		}

		const sql = `
			SELECT DISTINCT n.id, n.title, n.rank, n.status, r.date, r.source_id,
				rs.headline, rs.summary, rs.reform_type, rs.importance,
				(SELECT COUNT(*) FROM materias WHERE norm_id = r.norm_id) as materia_count,
				(SELECT COUNT(*) FROM omnibus_topics WHERE norm_id = r.norm_id) as omnibus_topic_count
			FROM reforms r
			JOIN norms n ON n.id = r.norm_id
			LEFT JOIN reform_summaries rs
				ON rs.norm_id = r.norm_id AND rs.source_id = r.source_id AND rs.reform_date = r.date
			WHERE r.date >= ?
			  AND (rs.importance IS NULL OR rs.importance NOT IN ('skip'))
			  ${jurisdictionClause}
			ORDER BY r.date DESC
			LIMIT ?
		`;

		return this.db
			.query<
				{
					id: string;
					title: string;
					rank: string;
					status: string;
					date: string;
					source_id: string;
					headline: string | null;
					summary: string | null;
					reform_type: string | null;
					importance: string | null;
					materia_count: number;
					omnibus_topic_count: number;
				},
				SqlParams
			>(sql)
			.all(since, ...jurisdictionParams, limit);
	}

	upsertReformSummary(
		normId: string,
		sourceId: string,
		reformDate: string,
		data: {
			reformType: string;
			headline: string;
			summary: string;
			importance: string;
			model: string;
		},
	): void {
		this.db
			.query(
				`INSERT INTO reform_summaries (norm_id, source_id, reform_date, reform_type, headline, summary, importance, generated_at, model)
			 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
			 ON CONFLICT (norm_id, source_id, reform_date)
			 DO UPDATE SET reform_type = excluded.reform_type, headline = excluded.headline,
				summary = excluded.summary, importance = excluded.importance,
				generated_at = excluded.generated_at, model = excluded.model`,
			)
			.run(
				normId,
				sourceId,
				reformDate,
				data.reformType,
				data.headline,
				data.summary,
				data.importance,
				data.model,
			);
	}

	getReformsWithoutSummary(
		since?: string,
		limit = 100,
	): Array<{
		norm_id: string;
		title: string;
		rank: string;
		date: string;
		source_id: string;
	}> {
		const whereClause = since ? "AND r.date >= ?" : "";
		const params: SqlParams = since ? [since, limit] : [limit];

		const sql = `
			SELECT r.norm_id, n.title, n.rank, r.date, r.source_id
			FROM reforms r
			JOIN norms n ON n.id = r.norm_id
			LEFT JOIN reform_summaries rs
				ON rs.norm_id = r.norm_id AND rs.source_id = r.source_id AND rs.reform_date = r.date
			WHERE rs.norm_id IS NULL
			  ${whereClause}
			ORDER BY r.date DESC
			LIMIT ?
		`;

		return this.db
			.query<
				{
					norm_id: string;
					title: string;
					rank: string;
					date: string;
					source_id: string;
				},
				SqlParams
			>(sql)
			.all(...params);
	}

	// ── Notifications ──

	getUnnotifiedReforms(): Array<{
		norm_id: string;
		source_id: string;
		reform_date: string;
		headline: string;
		summary: string;
		reform_type: string;
		importance: string;
	}> {
		return this.db
			.query<
				{
					norm_id: string;
					source_id: string;
					reform_date: string;
					headline: string;
					summary: string;
					reform_type: string;
					importance: string;
				},
				[]
			>(
				`SELECT rs.norm_id, rs.source_id, rs.reform_date,
						rs.headline, rs.summary, rs.reform_type, rs.importance
				 FROM reform_summaries rs
				 LEFT JOIN notified_reforms nr
					ON nr.norm_id = rs.norm_id
					AND nr.source_id = rs.source_id
					AND nr.reform_date = rs.reform_date
				 WHERE nr.norm_id IS NULL
				   AND rs.headline != ''
				   AND rs.importance NOT IN ('skip', '')
				 ORDER BY rs.reform_date DESC`,
			)
			.all();
	}

	markReformsNotified(
		reforms: Array<{ norm_id: string; source_id: string; reform_date: string }>,
	): void {
		const stmt = this.db.query(
			`INSERT OR IGNORE INTO notified_reforms (norm_id, source_id, reform_date, notified_at)
			 VALUES (?, ?, ?, datetime('now'))`,
		);
		for (const r of reforms) {
			stmt.run(r.norm_id, r.source_id, r.reform_date);
		}
	}

	markAllReformSummariesNotified(): number {
		const result = this.db.run(
			`INSERT OR IGNORE INTO notified_reforms (norm_id, source_id, reform_date, notified_at)
			 SELECT norm_id, source_id, reform_date, datetime('now')
			 FROM reform_summaries
			 WHERE headline != '' AND importance NOT IN ('skip', '')`,
		);
		return result.changes;
	}

	getMateriasByNormIds(normIds: string[]): Map<string, string[]> {
		if (normIds.length === 0) return new Map();

		const placeholders = normIds.map(() => "?").join(",");
		const rows = this.db
			.query<{ norm_id: string; materia: string }, string[]>(
				`SELECT norm_id, materia FROM materias WHERE norm_id IN (${placeholders})`,
			)
			.all(...normIds);

		const map = new Map<string, string[]>();
		for (const row of rows) {
			const existing = map.get(row.norm_id);
			if (existing) existing.push(row.materia);
			else map.set(row.norm_id, [row.materia]);
		}
		return map;
	}

	getReformDetail(
		normId: string,
		date: string,
	): {
		law: LawRow;
		reform: ReformRow & {
			headline: string | null;
			summary: string | null;
			reform_type: string | null;
			importance: string | null;
		};
		affected_blocks: Array<{
			block_id: string;
			title: string;
			before_text: string;
			after_text: string;
		}>;
		prev_reform_date: string | null;
		next_reform_date: string | null;
	} | null {
		const law = this.getLaw(normId);
		if (!law) return null;

		// Find the reform at this date
		const reform = this.db
			.query<ReformRow, [string, string]>(
				"SELECT * FROM reforms WHERE norm_id = ? AND date = ? LIMIT 1",
			)
			.get(normId, date);
		if (!reform) return null;

		// Get reform summary
		const summary = this.db
			.query<
				{
					headline: string;
					summary: string;
					reform_type: string;
					importance: string;
				},
				[string, string, string]
			>(
				"SELECT headline, summary, reform_type, importance FROM reform_summaries WHERE norm_id = ? AND source_id = ? AND reform_date = ?",
			)
			.get(normId, reform.source_id, date);

		// Get affected blocks with before/after text
		const blocks = this.db
			.query<
				{
					block_id: string;
					title: string;
					after_text: string | null;
					before_text: string | null;
				},
				[string, string, string, string, string]
			>(
				`SELECT
					rb.block_id,
					b.title,
					v_after.text AS after_text,
					(SELECT v2.text FROM versions v2
					 WHERE v2.norm_id = rb.norm_id AND v2.block_id = rb.block_id
					   AND v2.date < ?
					 ORDER BY v2.date DESC LIMIT 1) AS before_text
				FROM reform_blocks rb
				JOIN blocks b ON b.norm_id = rb.norm_id AND b.block_id = rb.block_id
				LEFT JOIN versions v_after
					ON v_after.norm_id = rb.norm_id AND v_after.block_id = rb.block_id AND v_after.date = ?
				WHERE rb.norm_id = ? AND rb.reform_date = ? AND rb.reform_source_id = ?
				ORDER BY b.position`,
			)
			.all(date, date, normId, date, reform.source_id);

		// Get prev/next reform dates
		const allReforms = this.db
			.query<{ date: string }, [string]>(
				"SELECT DISTINCT date FROM reforms WHERE norm_id = ? ORDER BY date",
			)
			.all(normId);
		const idx = allReforms.findIndex((r) => r.date === date);
		const prevDate = idx > 0 ? allReforms[idx - 1]!.date : null;
		const nextDate =
			idx >= 0 && idx < allReforms.length - 1
				? allReforms[idx + 1]!.date
				: null;

		return {
			law,
			reform: {
				...reform,
				headline: summary?.headline ?? null,
				summary: summary?.summary ?? null,
				reform_type: summary?.reform_type ?? null,
				importance: summary?.importance ?? null,
			},
			affected_blocks: blocks.map((b) => ({
				block_id: b.block_id,
				title: b.title,
				before_text: b.before_text ?? "",
				after_text: b.after_text ?? "",
			})),
			prev_reform_date: prevDate,
			next_reform_date: nextDate,
		};
	}

	// ── Omnibus ──

	upsertOmnibusTopic(
		normId: string,
		topicIndex: number,
		data: {
			topicLabel: string;
			headline: string;
			summary: string;
			articleCount: number;
			isSneaked: boolean;
			relatedMaterias: string;
			blockIds: string;
			model: string;
		},
	): void {
		this.db
			.query(
				`INSERT OR REPLACE INTO omnibus_topics
				 (norm_id, topic_index, topic_label, headline, summary, article_count, is_sneaked, related_materias, block_ids, generated_at, model)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
			)
			.run(
				normId,
				topicIndex,
				data.topicLabel,
				data.headline,
				data.summary,
				data.articleCount,
				data.isSneaked ? 1 : 0,
				data.relatedMaterias,
				data.blockIds,
				data.model,
			);
	}

	getOmnibusTopics(normId: string): Array<{
		topic_index: number;
		topic_label: string;
		headline: string;
		summary: string;
		article_count: number;
		is_sneaked: number;
		related_materias: string;
		block_ids: string;
	}> {
		return this.db
			.query<
				{
					topic_index: number;
					topic_label: string;
					headline: string;
					summary: string;
					article_count: number;
					is_sneaked: number;
					related_materias: string;
					block_ids: string;
				},
				[string]
			>(
				`SELECT topic_index, topic_label, headline, summary, article_count, is_sneaked, related_materias, block_ids
				 FROM omnibus_topics WHERE norm_id = ? ORDER BY topic_index`,
			)
			.all(normId);
	}

	listRecentOmnibus(
		limit = 20,
		since?: string,
	): Array<{
		id: string;
		title: string;
		rank: string;
		materia_count: number;
		topic_count: number;
		sneaked_count: number;
		latest_reform_date: string;
	}> {
		const sinceClause = since ? "AND r.date >= ?" : "";
		const params: SqlParams = since ? [since, limit] : [limit];

		return this.db
			.query<
				{
					id: string;
					title: string;
					rank: string;
					materia_count: number;
					topic_count: number;
					sneaked_count: number;
					latest_reform_date: string;
				},
				SqlParams
			>(
				`SELECT n.id, n.title, n.rank,
					(SELECT COUNT(*) FROM materias WHERE norm_id = n.id) as materia_count,
					(SELECT COUNT(*) FROM omnibus_topics WHERE norm_id = n.id) as topic_count,
					(SELECT COUNT(*) FROM omnibus_topics WHERE norm_id = n.id AND is_sneaked = 1) as sneaked_count,
					MAX(r.date) as latest_reform_date
				FROM norms n
				JOIN reforms r ON r.norm_id = n.id
				WHERE n.id IN (SELECT DISTINCT norm_id FROM omnibus_topics)
				  ${sinceClause}
				GROUP BY n.id
				HAVING (SELECT COUNT(*) FROM materias WHERE norm_id = n.id) >= 15
				ORDER BY latest_reform_date DESC
				LIMIT ?`,
			)
			.all(...params);
	}

	getOmnibusDetail(normId: string): {
		id: string;
		title: string;
		rank: string;
		status: string;
		materia_count: number;
		latest_reform_date: string | null;
		topics: Array<{
			topic_index: number;
			topic_label: string;
			headline: string;
			summary: string;
			article_count: number;
			is_sneaked: number;
			related_materias: string;
			block_ids: string;
		}>;
	} | null {
		const norm = this.db
			.query<
				{
					id: string;
					title: string;
					rank: string;
					status: string;
					materia_count: number;
					latest_reform_date: string | null;
				},
				[string]
			>(
				`SELECT n.id, n.title, n.rank, n.status,
					(SELECT COUNT(*) FROM materias WHERE norm_id = n.id) as materia_count,
					(SELECT MAX(r.date) FROM reforms r WHERE r.norm_id = n.id) as latest_reform_date
				FROM norms n WHERE n.id = ?`,
			)
			.get(normId);

		if (!norm) return null;

		const topics = this.getOmnibusTopics(normId);

		return { ...norm, topics };
	}

	/**
	 * Build manifest: returns all citizen data + omnibus topics in one shot.
	 * Used by the web build to avoid 12K individual API calls.
	 */
	getBuildManifest(): {
		citizens: Record<string, { summary: string; tags: string[] }>;
		omnibus: Record<
			string,
			Array<{
				topic_label: string;
				article_count: number;
				headline: string;
				summary: string;
				is_sneaked: number;
				block_ids: string[];
			}>
		>;
	} {
		// 1. All norms with citizen_summary
		const summaryRows = this.db
			.query<{ id: string; citizen_summary: string }, []>(
				"SELECT id, citizen_summary FROM norms WHERE citizen_summary != ''",
			)
			.all();

		// 2. All law-level citizen_tags
		const tagRows = this.db
			.query<{ norm_id: string; tag: string }, []>(
				"SELECT norm_id, tag FROM citizen_tags WHERE block_id = '' ORDER BY norm_id, tag",
			)
			.all();

		// 3. All omnibus topics
		const topicRows = this.db
			.query<
				{
					norm_id: string;
					topic_label: string;
					article_count: number;
					headline: string;
					summary: string;
					is_sneaked: number;
					block_ids: string;
				},
				[]
			>(
				`SELECT norm_id, topic_label, article_count, headline, summary, is_sneaked, block_ids
				 FROM omnibus_topics ORDER BY norm_id, topic_index`,
			)
			.all();

		// Assemble citizens map
		const citizens: Record<string, { summary: string; tags: string[] }> = {};
		for (const row of summaryRows) {
			citizens[row.id] = { summary: row.citizen_summary, tags: [] };
		}
		for (const row of tagRows) {
			if (!citizens[row.norm_id]) {
				citizens[row.norm_id] = { summary: "", tags: [] };
			}
			citizens[row.norm_id]!.tags.push(row.tag);
		}

		// Assemble omnibus map
		const omnibus: Record<
			string,
			Array<{
				topic_label: string;
				article_count: number;
				headline: string;
				summary: string;
				is_sneaked: number;
				block_ids: string[];
			}>
		> = {};
		for (const row of topicRows) {
			if (!omnibus[row.norm_id]) {
				omnibus[row.norm_id] = [];
			}
			let blockIds: string[] = [];
			try {
				if (row.block_ids) blockIds = JSON.parse(row.block_ids);
			} catch {}
			omnibus[row.norm_id]!.push({
				topic_label: row.topic_label,
				article_count: row.article_count,
				headline: row.headline,
				summary: row.summary,
				is_sneaked: row.is_sneaked,
				block_ids: blockIds,
			});
		}

		return { citizens, omnibus };
	}

	/**
	 * Batch query: for a set of omnibus norm IDs, find which topic labels
	 * match the user's materias via the related_materias JSON field.
	 */
	getMatchedTopics(
		normIds: string[],
		userMaterias: string[],
	): Map<string, string[]> {
		if (normIds.length === 0 || userMaterias.length === 0) return new Map();

		const normPlaceholders = normIds.map(() => "?").join(",");
		const materiaPlaceholders = userMaterias.map(() => "?").join(",");

		const rows = this.db
			.query<{ norm_id: string; topic_label: string }, SqlParams>(
				`SELECT ot.norm_id, ot.topic_label
				 FROM omnibus_topics ot
				 WHERE ot.norm_id IN (${normPlaceholders})
				   AND json_valid(ot.related_materias)
				   AND EXISTS (
				       SELECT 1 FROM json_each(ot.related_materias) je
				       WHERE je.value IN (${materiaPlaceholders})
				   )
				 ORDER BY ot.topic_index`,
			)
			.all(...normIds, ...userMaterias);

		const result = new Map<string, string[]>();
		for (const row of rows) {
			const existing = result.get(row.norm_id) || [];
			existing.push(row.topic_label);
			result.set(row.norm_id, existing);
		}
		return result;
	}
}
