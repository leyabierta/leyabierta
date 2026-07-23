/**
 * Freshness alert (issue #129).
 *
 * Today, a quiet night ("BOE consolidó 0 normas nuevas") and a silently
 * broken fetch both produce the exact same log line: `0 changed`. This
 * script gives us a second, independent signal: how many business days
 * have passed since the last reform actually landed in the `reforms`
 * table. If that exceeds a threshold, something is worth a human look —
 * either the source has gone unusually quiet, or the pipeline is broken.
 *
 * It does NOT distinguish those two causes (a genuinely quiet BOE and a
 * broken fetch look identical from inside our own DB), it only tells you
 * "this has gone on long enough that someone should check". That's
 * intentional — see open_issues in the PR description for what a fuller
 * fix would need (a heartbeat written by the cron script on every run,
 * including zero-change runs, which today only saves data/state.json when
 * there is something new to persist).
 *
 * Exit codes:
 *   0 — fresh (last reform within the threshold)
 *   1 — stale (threshold exceeded) — wire this into the daily cron so a
 *       non-zero exit fails the job / trips an alert
 *   2 — could not determine (no reforms in DB at all — different problem,
 *       still worth flagging)
 *
 * Usage:
 *   bun run packages/api/src/scripts/freshness-alert.ts
 *   bun run packages/api/src/scripts/freshness-alert.ts --max-business-days 5
 */

import {
	isPlausibleReformDate,
	MIN_PLAUSIBLE_REFORM_DATE,
} from "@leyabierta/pipeline";
import { getArg, setupDb } from "./shared.ts";

const DEFAULT_MAX_BUSINESS_DAYS = 5;

const maxBusinessDaysArg = getArg("max-business-days");
const maxBusinessDays = maxBusinessDaysArg
	? Number(maxBusinessDaysArg)
	: DEFAULT_MAX_BUSINESS_DAYS;

if (!Number.isFinite(maxBusinessDays) || maxBusinessDays <= 0) {
	console.error(
		`Invalid --max-business-days value: ${maxBusinessDaysArg}. Must be a positive number.`,
	);
	process.exit(2);
}

/**
 * Count business days (Mon-Fri) strictly between `from` and `to`
 * (exclusive of `from`, inclusive of `to`). No public-holiday calendar —
 * Spanish national/regional holidays are not accounted for, so this
 * slightly over-counts around holidays. Good enough for a "should someone
 * look at this" trigger; not intended as exact SLA accounting.
 */
function countBusinessDaysBetween(from: Date, to: Date): number {
	let count = 0;
	const cursor = new Date(
		Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
	);
	const end = new Date(
		Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()),
	);
	cursor.setUTCDate(cursor.getUTCDate() + 1);
	while (cursor.getTime() <= end.getTime()) {
		const day = cursor.getUTCDay(); // 0 = Sunday, 6 = Saturday
		if (day !== 0 && day !== 6) count++;
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return count;
}

const { db } = setupDb();

const nowIso = new Date().toISOString().slice(0, 10);

// Same plausibility guard as ingest — belt and suspenders against any
// corrupt rows already in the DB (see list-corrupt-reform-dates.ts) that
// haven't been cleaned up yet.
const row = db
	.query<{ date: string }, [string, string]>(
		"SELECT date FROM reforms WHERE date >= ? AND date <= ? ORDER BY date DESC LIMIT 1",
	)
	.get(MIN_PLAUSIBLE_REFORM_DATE, nowIso);

if (!row || !isPlausibleReformDate(row.date)) {
	console.error(
		"[freshness] No reforms with a plausible date found in the database at all. " +
			"This is a different (worse) problem than staleness — investigate the DB directly.",
	);
	process.exit(2);
}

const lastReformDate = new Date(`${row.date}T00:00:00Z`);
const now = new Date();
const businessDaysSince = countBusinessDaysBetween(lastReformDate, now);

console.log(
	`[freshness] Last reform ingested: ${row.date} (${businessDaysSince} business day(s) ago)`,
);
console.log(`[freshness] Threshold: ${maxBusinessDays} business day(s)`);

if (businessDaysSince > maxBusinessDays) {
	console.error(
		`[freshness] ALERT: ${businessDaysSince} business days since the last reform ` +
			`(threshold ${maxBusinessDays}). Either the BOE has genuinely gone quiet for an ` +
			`unusually long stretch, or the pipeline fetch is broken. Check the daily cron ` +
			`logs for "0 have changes" vs actual fetch errors.`,
	);
	process.exit(1);
}

console.log("[freshness] OK — within threshold.");
process.exit(0);
