/**
 * SQLite query service for the API.
 */

import type { Database } from "bun:sqlite";
import { BASE_MATERIAS } from "../data/materia-mappings.ts";

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
	constructor(private db: Database) {}

	searchLaws(
		query: string | undefined,
		filters: {
			country?: string;
			rank?: string;
			status?: string;
			materia?: string;
			citizen_tag?: string;
		},
		limit: number,
		offset: number,
		sort?: string,
	): { laws: LawRow[]; total: number } {
		if (query) {
			// If the query looks like a norm ID (e.g. BOE-A-2018-6405), search by ID directly
			const isNormId = /^[A-Z]+-[A-Z]+-\d{4}-\d+$/i.test(query.trim());

			if (isNormId) {
				const law = this.db
					.query<LawRow, [string]>("SELECT * FROM norms WHERE id = ?")
					.get(query.trim().toUpperCase());
				return law ? { laws: [law], total: 1 } : { laws: [], total: 0 };
			}

			// Escape FTS5 query: wrap each token in double quotes to avoid
			// hyphens and special chars being treated as operators
			const safeQuery = query
				.replace(/"/g, "")
				.split(/\s+/)
				.filter(Boolean)
				.map((token) => `"${token}"`)
				.join(" ");

			// Build filter conditions for the JOIN
			const conditions: string[] = [];
			const filterParams: unknown[] = [];
			this.applyFilters(conditions, filterParams, filters);
			// For non-relevance sorts: use a single efficient JOIN query
			if (sort === "recent" || sort === "oldest" || sort === "title") {
				const orderMap = {
					recent: "ORDER BY published_at DESC",
					oldest: "ORDER BY published_at ASC",
					title: "ORDER BY title ASC",
				};
				try {
					// Two-pass FTS: title matches (fast) + content matches
					const titleMatchIds = this.db
						.query<{ norm_id: string }, [string]>(
							"SELECT DISTINCT norm_id FROM norms_fts WHERE title MATCH ? LIMIT 10000",
						)
						.all(safeQuery)
						.map((r) => r.norm_id);

					let ftsIds = titleMatchIds;
					if (titleMatchIds.length < 10000) {
						const seen = new Set(titleMatchIds);
						const contentIds = this.db
							.query<{ norm_id: string }, [string]>(
								"SELECT DISTINCT norm_id FROM norms_fts WHERE norms_fts MATCH ? LIMIT 10000",
							)
							.all(safeQuery)
							.map((r) => r.norm_id)
							.filter((id) => !seen.has(id));
						ftsIds = [...titleMatchIds, ...contentIds];
					}
					if (ftsIds.length === 0) return { laws: [], total: 0 };

					// For sorted search, use the relevance path to get filtered IDs,
					// then fetch sorted page from norms table
					const hasFilters2 =
						filters.country ||
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
						.query<LawRow, unknown[]>(
							`SELECT * FROM norms WHERE id IN (${placeholders})
							 ${orderMap[sort]} LIMIT ? OFFSET ?`,
						)
						.all(...pageIds, limit, offset);
					return { laws, total };
				} catch {
					return { laws: [], total: 0 };
				}
			}

			// Default: FTS relevance order — two-pass: title matches first (fast),
			// then content matches for additional results. Cap at 2000.
			const FTS_CAP = 2000;
			try {
				// Pass 1: title matches (very fast, most relevant)
				const titleIds = this.db
					.query<{ norm_id: string }, [string]>(
						`SELECT DISTINCT norm_id FROM norms_fts
						 WHERE title MATCH ?
						 ORDER BY bm25(norms_fts, 0, 10.0, 1.0, 15.0, 12.0)
						 LIMIT ${FTS_CAP}`,
					)
					.all(safeQuery)
					.map((r) => r.norm_id);

				let allIds = titleIds;

				// Pass 2: content matches if we need more results
				if (titleIds.length < FTS_CAP) {
					const titleSet = new Set(titleIds);
					const contentIds = this.db
						.query<{ norm_id: string }, [string]>(
							`SELECT DISTINCT norm_id FROM norms_fts
							 WHERE norms_fts MATCH ? LIMIT ${FTS_CAP * 3}`,
						)
						.all(safeQuery)
						.map((r) => r.norm_id)
						.filter((id) => !titleSet.has(id));
					allIds = [...titleIds, ...contentIds].slice(0, FTS_CAP);
				}

				// Apply filters in the norms table
				const hasFilters =
					filters.country ||
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
					.query<LawRow, unknown[]>(
						`SELECT * FROM norms WHERE id IN (${placeholders})`,
					)
					.all(...pageIds);

				// Re-sort in JS to match FTS relevance order
				const rowMap = new Map(rows.map((r) => [r.id, r]));
				const laws = pageIds
					.map((id) => rowMap.get(id))
					.filter((r): r is LawRow => r != null);

				return { laws, total };
			} catch {
				// FTS failed, fallback to LIKE on title
				const conditions2: string[] = ["title LIKE ?"];
				const params2: unknown[] = [`%${query}%`];
				this.applyFilters(conditions2, params2, filters);
				const where = conditions2.join(" AND ");

				const total = this.db
					.query<{ c: number }, unknown[]>(
						`SELECT count(*) as c FROM norms WHERE ${where}`,
					)
					.get(...params2)!.c;

				const laws = this.db
					.query<LawRow, unknown[]>(
						`SELECT * FROM norms WHERE ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`,
					)
					.all(...params2, limit, offset);
				return { laws, total };
			}
		}

		// No query — filter + paginate
		const conditions: string[] = [];
		const params: unknown[] = [];

		this.applyFilters(conditions, params, filters);

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

		const total = this.db
			.query<{ c: number }, unknown[]>(
				`SELECT count(*) as c FROM norms ${where}`,
			)
			.get(...params)!.c;

		let noQueryOrder = "ORDER BY published_at DESC";
		if (sort === "oldest") noQueryOrder = "ORDER BY published_at ASC";
		else if (sort === "title") noQueryOrder = "ORDER BY title ASC";

		const laws = this.db
			.query<LawRow, unknown[]>(
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
			const params: unknown[] = [...chunk];
			this.applyFilters(conds, params, filters);
			const filtered = this.db
				.query<{ id: string }, unknown[]>(
					`SELECT id FROM norms WHERE ${conds.join(" AND ")}`,
				)
				.all(...params);
			result.push(...filtered.map((r) => r.id));
		}
		return result;
	}

	private applyFilters(
		conditions: string[],
		params: unknown[],
		filters: {
			country?: string;
			rank?: string;
			status?: string;
			materia?: string;
			citizen_tag?: string;
		},
	): void {
		if (filters.country) {
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
				"SELECT * FROM blocks WHERE norm_id = ? ORDER BY position",
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
	getRecentlyUpdated(
		limit: number,
	): Array<{ id: string; title: string; last_reform: string }> {
		const today = new Date().toISOString().slice(0, 10);
		return this.db
			.query<
				{ id: string; title: string; last_reform: string },
				[string, number]
			>(
				`SELECT n.id, n.title, MAX(r.date) AS last_reform
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
	getMostReformed(
		limit: number,
	): Array<{ id: string; title: string; rank: string; reform_count: number }> {
		return this.db
			.query<
				{ id: string; title: string; rank: string; reform_count: number },
				[number]
			>(
				`SELECT n.id, n.title, n.rank, count(*) as reform_count
				 FROM reforms r JOIN norms n ON n.id = r.norm_id
				 GROUP BY r.norm_id ORDER BY reform_count DESC LIMIT ?`,
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

	private anomalyCache: ReturnType<DbService["getAnomaliesUncached"]> | null =
		null;

	/** Detect data anomalies in BOE source data (cached after first call). */
	getAnomalies() {
		if (!this.anomalyCache) {
			this.anomalyCache = this.getAnomaliesUncached();
		}
		return this.anomalyCache;
	}

	private getAnomaliesUncached(): {
		futureDates: Array<{
			type: string;
			norm_id: string;
			title: string;
			date: string;
			source_id?: string;
		}>;
		emptyBlocks: Array<{
			norm_id: string;
			title: string;
			block_id: string;
			block_type: string;
		}>;
		unresolvedMaterias: Array<{
			norm_id: string;
			title: string;
			materia: string;
		}>;
		missingEli: Array<{ id: string; title: string; source_url: string }>;
	} {
		const futureDates = [
			// Reforms with impossible future dates (>2100)
			...this.db
				.query<
					{ norm_id: string; title: string; date: string; source_id: string },
					[]
				>(
					`SELECT r.norm_id, n.title, r.date, r.source_id
					 FROM reforms r JOIN norms n ON n.id = r.norm_id
					 WHERE r.date > '2100-01-01' ORDER BY r.date DESC`,
				)
				.all()
				.map((r) => ({ type: "reform_future_date" as const, ...r })),
			// Norms published before 1800 (suspicious)
			...this.db
				.query<{ norm_id: string; title: string; date: string }, []>(
					`SELECT id as norm_id, title, published_at as date
					 FROM norms WHERE published_at < '1800-01-01' ORDER BY published_at`,
				)
				.all()
				.map((r) => ({ type: "norm_ancient_date" as const, ...r })),
		];

		// Two-step: fast partial-index scan, then enrich with norm title and filter
		const METADATA_IDS = new Set([
			"ir",
			"informacionrelacionada",
			"documentosrelacionados",
		]);
		const rawEmpty = this.db
			.query<
				{
					norm_id: string;
					block_id: string;
					block_type: string;
					block_title: string;
				},
				[]
			>(
				`SELECT norm_id, block_id, block_type, title as block_title
				 FROM blocks
				 WHERE block_type = 'precepto'
				 AND (current_text = '' OR current_text IS NULL)`,
			)
			.all()
			.filter(
				(b) =>
					!METADATA_IDS.has(b.block_id) &&
					!b.block_title.toLowerCase().includes("relacionad"),
			);

		const emptyBlocks = rawEmpty.map((b) => {
			const norm = this.getLaw(b.norm_id);
			return { ...b, title: norm?.title ?? "" };
		});

		const unresolvedMaterias = this.db
			.query<{ norm_id: string; title: string; materia: string }, []>(
				`SELECT m.norm_id, n.title, m.materia
				 FROM materias m JOIN norms n ON n.id = m.norm_id
				 WHERE m.materia LIKE '[código%'
				 ORDER BY m.materia`,
			)
			.all();

		const missingEli = this.db
			.query<{ id: string; title: string; source_url: string }, []>(
				`SELECT id, title, source_url FROM norms
				 WHERE source_url NOT LIKE '%/eli/%'
				 ORDER BY id`,
			)
			.all();

		return { futureDates, emptyBlocks, unresolvedMaterias, missingEli };
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
		const jurisdictionClause =
			jurisdiction === "es"
				? "(n.source_url LIKE '%/eli/es/%' AND n.source_url NOT LIKE '%/eli/es-__/%')"
				: `(n.source_url LIKE '%/eli/${jurisdiction}/%' OR (n.source_url LIKE '%/eli/es/%' AND n.source_url NOT LIKE '%/eli/es-__/%'))`;

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
				unknown[]
			>(sql)
			.all(...effectiveMaterias, since);
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

		const jurisdictionClause = jurisdiction
			? jurisdiction === "es"
				? "AND (n.source_url LIKE '%/eli/es/%' AND n.source_url NOT LIKE '%/eli/es-__/%')"
				: `AND (n.source_url LIKE '%/eli/${jurisdiction}/%' OR (n.source_url LIKE '%/eli/es/%' AND n.source_url NOT LIKE '%/eli/es-__/%'))`
			: "";

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
				[string, number]
			>(sql)
			.all(since, limit);
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
		const params: unknown[] = since ? [since, limit] : [limit];

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
				unknown[]
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
			model: string;
		},
	): void {
		this.db
			.query(
				`INSERT OR REPLACE INTO omnibus_topics
				 (norm_id, topic_index, topic_label, headline, summary, article_count, is_sneaked, related_materias, generated_at, model)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
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
				},
				[string]
			>(
				`SELECT topic_index, topic_label, headline, summary, article_count, is_sneaked, related_materias
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
		const params: unknown[] = since ? [since, limit] : [limit];

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
				unknown[]
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
			.query<{ norm_id: string; topic_label: string }, unknown[]>(
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
