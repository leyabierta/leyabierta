// Ad-hoc, one-shot cleanup of corrupt reform dates in PRODUCTION (issue #129).
// Self-contained on purpose: the deployed container predates
// isPlausibleReformDate, so packages/api/src/scripts/list-corrupt-reform-dates.ts
// cannot run there yet. Same criteria, same delete order, plus a JSON backup of
// every row it removes — leyabierta.db has no automated backup.
const { Database } = require("bun:sqlite");
const fs = require("node:fs");

const MIN = "1800-01-01";
const max = (() => {
	const d = new Date();
	d.setUTCFullYear(d.getUTCFullYear() + 5);
	return d.toISOString().slice(0, 10);
})();
const plausible = (s) => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const d = new Date(`${s}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return false;
	if (d.toISOString().slice(0, 10) !== s) return false;
	return s >= MIN && s <= max;
};

const APPLY = process.argv.includes("--fix");
const db = APPLY
	? new Database("/app/data/leyabierta.db")
	: new Database("/app/data/leyabierta.db", { readonly: true });
const all = db.query("SELECT norm_id, date, source_id FROM reforms").all();
const corrupt = all.filter((r) => !plausible(r.date));

console.log(
	`Scanned ${all.length} reforms — ${corrupt.length} implausible (range [${MIN}, ${max}])`,
);
if (corrupt.length === 0) process.exit(0);

const backup = corrupt.map((r) => ({
	reform: r,
	blocks: db
		.query(
			"SELECT * FROM reform_blocks WHERE norm_id=? AND reform_date=? AND reform_source_id=?",
		)
		.all(r.norm_id, r.date, r.source_id),
	summaries: db
		.query(
			"SELECT * FROM reform_summaries WHERE norm_id=? AND reform_date=? AND source_id=?",
		)
		.all(r.norm_id, r.date, r.source_id),
}));
for (const b of backup) {
	console.log(
		`  ${b.reform.norm_id} | ${b.reform.date} | src=${b.reform.source_id} | blocks=${b.blocks.length} summaries=${b.summaries.length}`,
	);
}

if (!APPLY) {
	console.log("\nDRY RUN — nothing deleted. Re-run with --fix.");
	process.exit(0);
}

const path = `/opt/leyabierta/backups/corrupt-reforms-backup-${new Date().toISOString().slice(0, 10)}.json`;
fs.writeFileSync(
	"/tmp/corrupt-reforms-backup.json",
	JSON.stringify(backup, null, 2),
);
console.log(
	`\nBackup written inside container: /tmp/corrupt-reforms-backup.json (copy out to ${path})`,
);

const delB = db.prepare(
	"DELETE FROM reform_blocks WHERE norm_id=? AND reform_date=? AND reform_source_id=?",
);
const delS = db.prepare(
	"DELETE FROM reform_summaries WHERE norm_id=? AND reform_date=? AND source_id=?",
);
const delR = db.prepare(
	"DELETE FROM reforms WHERE norm_id=? AND date=? AND source_id=?",
);
db.transaction(() => {
	for (const r of corrupt) {
		delB.run(r.norm_id, r.date, r.source_id);
		delS.run(r.norm_id, r.date, r.source_id);
		delR.run(r.norm_id, r.date, r.source_id);
	}
})();
console.log(`Deleted ${corrupt.length} corrupt reform row(s).`);
const left = db.query("SELECT COUNT(*) c FROM reforms WHERE date > ?").all(max);
console.log("Remaining implausible-future rows:", JSON.stringify(left));

// ---------------------------------------------------------------------------
// RUN LOG — executed against production on 2026-07-23.
//
//   Scanned 44271 reforms — 2 implausible (range [1800-01-01, 2031-07-23])
//     BOE-A-1985-26400 | 2929-11-19 | src=BOE-A-2021-2849 | blocks=1 summaries=1
//     BOE-A-2010-8228  | 2012-06-31 | src=BOE-A-2012-8745 | blocks=1 summaries=0
//   Deleted 2 corrupt reform row(s).
//
// The 2929-11-19 row was the FIRST entry citizens saw under "Cambios
// recientes"; 2012-06-31 is a 31st of June, a date that does not exist — it
// passed a naive range check and was only caught by the ISO round-trip.
//
// Deleted rows backed up to, on the server:
//   /opt/leyabierta/backups/corrupt-reforms-backup-20260723.json
// (leyabierta.db itself has NO automated backup — see the PR description.)
//
// Going forward this should not recur: ingest rejects implausible dates and
// getChangelog is upper-bounded. The maintained equivalent of this script is
// packages/api/src/scripts/list-corrupt-reform-dates.ts — this ad-hoc copy
// exists only because the deployed container predated isPlausibleReformDate.
// ---------------------------------------------------------------------------
