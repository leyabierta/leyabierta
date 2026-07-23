/**
 * Shared date parsing utilities for BOE date formats.
 *
 * BOE uses YYYYMMDD format throughout its API. Sentinel value
 * 99999999 means "no expiry" or "no date". We normalize to
 * ISO 8601 (YYYY-MM-DD) at all boundaries.
 */

/**
 * Parse BOE date format (YYYYMMDD) to ISO date (YYYY-MM-DD).
 * Returns undefined for missing, sentinel (99999999), or invalid values.
 * Already-formatted ISO dates (containing "-") pass through unchanged.
 */
export function parseBoeDate(raw: string | undefined): string | undefined {
	if (!raw || raw === "99999999") return undefined;
	if (raw.includes("-")) return raw;
	if (raw.length >= 8) {
		const year = raw.slice(0, 4);
		const month = raw.slice(4, 6);
		const day = raw.slice(6, 8);
		if (
			Number(year) >= 1800 &&
			Number(month) >= 1 &&
			Number(month) <= 12 &&
			Number(day) >= 1 &&
			Number(day) <= 31
		) {
			return `${year}-${month}-${day}`;
		}
	}
	return undefined;
}

/** Earliest plausible date for a reform (nothing in force before this). */
export const MIN_PLAUSIBLE_REFORM_DATE = "1800-01-01";

/**
 * Latest plausible date for a reform: today + 5 years. Computed relative to
 * `now` (default: current time) so tests can pin it.
 */
export function maxPlausibleReformDate(now: Date = new Date()): string {
	const d = new Date(now.getTime());
	d.setUTCFullYear(d.getUTCFullYear() + 5);
	return d.toISOString().slice(0, 10);
}

/**
 * Validate that a reform date is both a real calendar date (rejects things
 * like Feb 30 via the ISO round-trip check) AND falls within a plausible
 * range: [1800-01-01, today + 5 years].
 *
 * Exists because the BOE feed has been observed to emit corrupt dates (a
 * production reform row was seen with `2929-11-19`) that pass basic ISO
 * format checks but are obvious nonsense. Rejecting them here — at ingest —
 * keeps `MAX(reforms.date)` and similar aggregates from being contaminated
 * at the source, instead of relying on every downstream query to filter
 * them out individually.
 */
export function isPlausibleReformDate(
	dateStr: string,
	now: Date = new Date(),
): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
	const d = new Date(`${dateStr}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return false;
	// Round-trip through ISO to reject calendar rollovers (e.g. 2024-02-30 ->
	// 2024-03-01 would not match the original string).
	if (d.toISOString().slice(0, 10) !== dateStr) return false;
	return (
		dateStr >= MIN_PLAUSIBLE_REFORM_DATE &&
		dateStr <= maxPlausibleReformDate(now)
	);
}
