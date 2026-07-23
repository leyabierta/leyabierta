/**
 * List reforms with implausible dates already sitting in the `reforms`
 * table (production incident behind issue #129: a row with date
 * `2929-11-19` sourced verbatim from the BOE feed). Ingest now rejects
 * these going forward (see packages/pipeline/src/db/ingest.ts), but this
 * script finds — and optionally cleans up — rows that got in before that
 * fix landed.
 *
 * By default this ONLY LISTS the corrupt rows. It never deletes data
 * unless you pass --fix explicitly.
 *
 * Usage:
 *   bun run packages/api/src/scripts/list-corrupt-reform-dates.ts
 *   bun run packages/api/src/scripts/list-corrupt-reform-dates.ts --fix
 */

import { isPlausibleReformDate } from "@leyabierta/pipeline";
import { hasFlag, setupDb } from "./shared.ts";

const { db } = setupDb();
const fix = hasFlag("fix");

interface ReformDateRow {
	norm_id: string;
	date: string;
	source_id: string;
}

const rows = db
	.query<ReformDateRow, []>(
		"SELECT norm_id, date, source_id FROM reforms ORDER BY date DESC",
	)
	.all();

const corrupt = rows.filter((r) => !isPlausibleReformDate(r.date));

console.log(`Scanned ${rows.length} reforms.`);

if (corrupt.length === 0) {
	console.log("No corrupt reform dates found.");
	process.exit(0);
}

console.log(`Found ${corrupt.length} reform(s) with an implausible date:\n`);
for (const r of corrupt) {
	console.log(`  norm_id=${r.norm_id} date=${r.date} source_id=${r.source_id}`);
}

if (!fix) {
	console.log(
		"\nDry run (default): no rows deleted. Re-run with --fix to delete these rows.",
	);
	process.exit(0);
}

console.log("\n--fix passed — deleting the rows above...");
const deleteReform = db.prepare(
	"DELETE FROM reforms WHERE norm_id = $normId AND date = $date AND source_id = $sourceId",
);
const deleteReformBlocks = db.prepare(
	"DELETE FROM reform_blocks WHERE norm_id = $normId AND reform_date = $date AND reform_source_id = $sourceId",
);
const deleteReformSummary = db.prepare(
	"DELETE FROM reform_summaries WHERE norm_id = $normId AND reform_date = $date AND source_id = $sourceId",
);

const deleteAll = db.transaction(() => {
	for (const r of corrupt) {
		deleteReformBlocks.run({
			$normId: r.norm_id,
			$date: r.date,
			$sourceId: r.source_id,
		});
		deleteReformSummary.run({
			$normId: r.norm_id,
			$date: r.date,
			$sourceId: r.source_id,
		});
		deleteReform.run({
			$normId: r.norm_id,
			$date: r.date,
			$sourceId: r.source_id,
		});
	}
});
deleteAll();

console.log(`Deleted ${corrupt.length} corrupt reform row(s).`);
