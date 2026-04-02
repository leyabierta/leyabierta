/**
 * SQLite query service for the API.
 */

import type { Database } from "bun:sqlite";

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
		},
		limit: number,
		offset: number,
	): { laws: LawRow[]; total: number } {
		if (query) {
			// If the query looks like a norm ID (e.g. BOE-A-2018-6405), search by ID directly
			const isNormId = /^[A-Z]+-[A-Z]+-\d{4}-\d+$/i.test(query.trim());
			let ids: string[];

			if (isNormId) {
				const direct = this.db
					.query<{ id: string }, [string]>("SELECT id FROM norms WHERE id = ?")
					.all(query.trim().toUpperCase());
				ids = direct.map((r) => r.id);
			} else {
				// Escape FTS5 query: wrap each token in double quotes to avoid
				// hyphens and special chars being treated as operators
				const safeQuery = query
					.replace(/"/g, "")
					.split(/\s+/)
					.filter(Boolean)
					.map((token) => `"${token}"`)
					.join(" ");

				try {
					const matchIds = this.db
						.query<{ norm_id: string }, [string]>(
							"SELECT norm_id FROM norms_fts WHERE norms_fts MATCH ? ORDER BY bm25(norms_fts, 0, 10.0, 1.0)",
						)
						.all(safeQuery);
					ids = matchIds.map((r) => r.norm_id);
				} catch {
					// If FTS still fails, fallback to LIKE on title
					const likeIds = this.db
						.query<{ id: string }, [string]>(
							"SELECT id FROM norms WHERE title LIKE ?",
						)
						.all(`%${query}%`);
					ids = likeIds.map((r) => r.id);
				}
			}

			if (ids.length === 0) return { laws: [], total: 0 };

			const conditions: string[] = [`id IN (${ids.map(() => "?").join(",")})`];
			const params: unknown[] = [...ids];

			this.applyFilters(conditions, params, filters);

			const where = conditions.join(" AND ");

			const total = this.db
				.query<{ c: number }, unknown[]>(
					`SELECT count(*) as c FROM norms WHERE ${where}`,
				)
				.get(...params)!.c;

			// Preserve FTS5 relevance order using CASE on the id position
			const orderByRelevance = ids.map((_, i) => `WHEN ? THEN ${i}`).join(" ");
			const orderClause = `ORDER BY CASE id ${orderByRelevance} END`;

			const laws = this.db
				.query<LawRow, unknown[]>(
					`SELECT * FROM norms WHERE ${where} ${orderClause} LIMIT ? OFFSET ?`,
				)
				.all(...params, ...ids, limit, offset);

			return { laws, total };
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

		const laws = this.db
			.query<LawRow, unknown[]>(
				`SELECT * FROM norms ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`,
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

	private applyFilters(
		conditions: string[],
		params: unknown[],
		filters: {
			country?: string;
			rank?: string;
			status?: string;
			materia?: string;
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
	getRecentReforms(limit: number): Array<ReformRow & { title: string }> {
		const today = new Date().toISOString().slice(0, 10);
		return this.db
			.query<ReformRow & { title: string }, [string, number]>(
				`SELECT r.*, n.title FROM reforms r
				 JOIN norms n ON n.id = r.norm_id
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

	// ── Digests ──

	upsertDigest(
		profileId: string,
		week: string,
		jurisdiction: string,
		summary: string,
		generatedAt: string,
		data: string,
	): void {
		this.db
			.query(
				`INSERT INTO digests (profile_id, week, jurisdiction, summary, generated_at, data)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(profile_id, week, jurisdiction)
				 DO UPDATE SET summary = excluded.summary, generated_at = excluded.generated_at, data = excluded.data`,
			)
			.run(profileId, week, jurisdiction, summary, generatedAt, data);
	}

	getDigest(
		profileId: string,
		week: string,
		jurisdiction?: string,
	): {
		profile_id: string;
		week: string;
		jurisdiction: string;
		summary: string;
		generated_at: string;
		data: string;
	} | null {
		const jur = jurisdiction ?? "es";
		return (
			this.db
				.query<
					{
						profile_id: string;
						week: string;
						jurisdiction: string;
						summary: string;
						generated_at: string;
						data: string;
					},
					[string, string, string]
				>(
					"SELECT profile_id, week, jurisdiction, summary, generated_at, data FROM digests WHERE profile_id = ? AND week = ? AND jurisdiction = ?",
				)
				.get(profileId, week, jur) ?? null
		);
	}

	listDigestsForProfile(profileId: string): Array<{
		week: string;
		summary: string;
		generated_at: string;
		reform_count: number;
	}> {
		// We store reform count by parsing JSON length — but for listing, we can
		// compute it in JS from the data column to avoid JSON parsing in SQL.
		const rows = this.db
			.query<
				{ week: string; summary: string; generated_at: string; data: string },
				[string]
			>(
				"SELECT week, summary, generated_at, data FROM digests WHERE profile_id = ? ORDER BY week DESC",
			)
			.all(profileId);

		return rows.map((r) => {
			let reformCount = 0;
			try {
				const parsed = JSON.parse(r.data);
				reformCount = Array.isArray(parsed.reforms) ? parsed.reforms.length : 0;
			} catch {
				// malformed JSON
			}
			return {
				week: r.week,
				summary: r.summary,
				generated_at: r.generated_at,
				reform_count: reformCount,
			};
		});
	}

	listDigestProfiles(): Array<{
		profile_id: string;
		digest_count: number;
		latest_week: string;
	}> {
		return this.db
			.query<
				{ profile_id: string; digest_count: number; latest_week: string },
				[]
			>(
				"SELECT profile_id, COUNT(*) as digest_count, MAX(week) as latest_week FROM digests GROUP BY profile_id ORDER BY profile_id",
			)
			.all();
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
	}> {
		if (materias.length === 0) return [];

		const placeholders = materias.map(() => "?").join(",");

		// If jurisdiction is 'es' (national), include all national laws.
		// Otherwise filter by jurisdiction in the ELI source URL.
		const jurisdictionClause =
			jurisdiction === "es"
				? "(n.source_url LIKE '%/eli/es/%' AND n.source_url NOT LIKE '%/eli/es-__/%')"
				: `n.source_url LIKE '%/eli/${jurisdiction}/%'`;

		const sql = `
			SELECT DISTINCT n.id, n.title, n.rank, n.status, r.date, r.source_id
			FROM reforms r
			JOIN norms n ON n.id = r.norm_id
			JOIN materias m ON m.norm_id = r.norm_id
			WHERE r.date >= ?
			  AND m.materia IN (${placeholders})
			  AND ${jurisdictionClause}
			ORDER BY r.date DESC
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
				},
				unknown[]
			>(sql)
			.all(since, ...materias);
	}
}
