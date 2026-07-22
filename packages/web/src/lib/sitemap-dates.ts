/**
 * Date sanitation for the reformas sitemap.
 *
 * Reform dates come from the pipeline and can be corrupt (e.g. `2929-11-19`,
 * a date-parse bug). A plain `/^\d{4}-\d{2}-\d{2}$/` shape check lets those
 * through, and Google then rejects the entire reformas sitemap with "Invalid
 * date" errors — which kept ~35k reform URLs out of the index. These helpers
 * drop the corrupt entries and keep every `<lastmod>` non-future.
 */

// The Spanish consolidated corpus starts ~1835; anything before 1800 is a bug.
export const MIN_REFORM_YEAR = 1800;

/** A reform date must be a REAL calendar date within [MIN_REFORM_YEAR, maxYear].
 *  Rejects shape mismatches, non-dates, silent rollovers (2024-02-30), and
 *  implausible years. `maxYear` is passed in (build year + 1) for testability. */
export function isPlausibleReformDate(s: string, maxYear: number): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const d = new Date(`${s}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return false;
	if (!d.toISOString().startsWith(s)) return false;
	const year = d.getUTCFullYear();
	return year >= MIN_REFORM_YEAR && year <= maxYear;
}

/** Clamp a lastmod to today: Google flags future lastmod values as invalid. */
export function clampLastmod(fecha: string, todayIso: string): string {
	return fecha > todayIso ? todayIso : fecha;
}
