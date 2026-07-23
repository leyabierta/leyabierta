/**
 * Precomputed "authority" signal for search ranking (issue #131).
 *
 * authority_score(X) = number of DISTINCT norms whose `referencias` row
 * names X as `target_id` — i.e. how many other legal texts cite, modify,
 * derogate, develop, or otherwise point to X. It's a simple in-degree count
 * over the citation graph BOE's own análisis data already gives us via the
 * `referencias` table (see packages/pipeline/src/db/schema.ts).
 *
 * Deliberately excluded: pure correction/erratum relations. These are BOE
 * publishing typo fixes, not substantive legal relationships, and would
 * otherwise inflate the score of norms that simply happen to have had a
 * lot of erratas printed about them.
 *
 * This is precomputed and stored on `norms.authority_score`, never
 * calculated at query time — see packages/api/src/services/ranking.ts for
 * how the API reads it, and packages/api/src/scripts/recalculate-authority-scores.ts
 * for the standalone backfill entry point.
 */

import type { Database } from "bun:sqlite";

/**
 * Relations that don't indicate substantive legal authority — typo/erratum
 * corrections published in the BOE. Excluded so they don't inflate the
 * score of frequently-corrected (not necessarily authoritative) norms.
 */
export const EXCLUDED_AUTHORITY_RELATIONS = [
	"CORRECCIÓN de errores",
	"CORRECCIÓN de erratas",
	"SE CORRIGEN errores",
	"SE CORRIGEN erratas",
] as const;

export interface AuthorityRecalcResult {
	/** Total norms scanned. */
	total: number;
	/** Norms whose authority_score actually changed. */
	changed: number;
	/** Highest authority_score computed this run (sanity-check signal). */
	max: number;
}

/**
 * Recompute `authority_score` for every norm from scratch, from the current
 * contents of `referencias`. Idempotent — safe to run repeatedly and safe to
 * run against a production DB with no other changes (referencias is
 * populated separately by `ingest-analisis`).
 *
 * @param dryRun - When true, computes and reports the diff without writing.
 */
export function recalculateAuthorityScores(
	db: Database,
	{ dryRun = false }: { dryRun?: boolean } = {},
): AuthorityRecalcResult {
	const excludedPlaceholders = EXCLUDED_AUTHORITY_RELATIONS.map(() => "?").join(
		",",
	);

	const computed = db
		.query<{ id: string; score: number }, string[]>(
			`SELECT n.id as id, (
				 SELECT COUNT(DISTINCT r.norm_id) FROM referencias r
				 WHERE r.target_id = n.id AND r.relation NOT IN (${excludedPlaceholders})
			 ) as score
			 FROM norms n`,
		)
		.all(...EXCLUDED_AUTHORITY_RELATIONS);

	let max = 0;
	for (const row of computed) {
		if (row.score > max) max = row.score;
	}

	let changed = 0;
	if (dryRun) {
		const current = db
			.query<{ id: string; authority_score: number }, []>(
				"SELECT id, authority_score FROM norms",
			)
			.all();
		const currentById = new Map(current.map((r) => [r.id, r.authority_score]));
		for (const row of computed) {
			if (currentById.get(row.id) !== row.score) changed++;
		}
	} else {
		const update = db.prepare(
			"UPDATE norms SET authority_score = ? WHERE id = ? AND authority_score != ?",
		);
		db.transaction(() => {
			for (const row of computed) {
				const info = update.run(row.score, row.id, row.score);
				changed += info.changes;
			}
		})();
	}

	return { total: computed.length, changed, max };
}
