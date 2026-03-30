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
					.query<{ id: string }, [string]>(
						"SELECT id FROM norms WHERE id = ?",
					)
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
							"SELECT norm_id FROM norms_fts WHERE norms_fts MATCH ? ORDER BY rank",
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

			const laws = this.db
				.query<LawRow, unknown[]>(
					`SELECT * FROM norms WHERE ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`,
				)
				.all(...params, limit, offset);

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
		filters: { country?: string; rank?: string; status?: string; materia?: string },
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
			conditions.push(
				"id IN (SELECT norm_id FROM materias WHERE materia = ?)",
			);
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

	getRecentReforms(limit: number): Array<ReformRow & { title: string }> {
		return this.db
			.query<ReformRow & { title: string }, [number]>(
				`SELECT r.*, n.title FROM reforms r
				 JOIN norms n ON n.id = r.norm_id
				 ORDER BY r.date DESC LIMIT ?`,
			)
			.all(limit);
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
}
