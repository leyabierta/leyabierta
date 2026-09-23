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

/**
 * Google's sitemap parser rejects `<lastmod>` values before the Unix epoch as
 * "Invalid date", however well-formed they are.
 *
 * Measured, not guessed (2026-09-16): Search Console reported exactly 158
 * "Invalid date" instances on sitemap-reformas.xml, and the served XML carries
 * exactly 158 `<lastmod>` values with a year below 1970. The three example
 * lines GSC cites — 90089, 90095, 90155 — are the first three of them
 * (1940-12-22, 1946-12-19, 1927-09-08). Everything from 1970 on passes.
 */
export const MIN_LASTMOD_ISO = "1970-01-01";

/**
 * Whether a date can be emitted as `<lastmod>` at all: a real calendar date
 * in `[MIN_LASTMOD_ISO, todayIso]`.
 *
 * A pre-1970 reform date is perfectly good data — the Ley Hipotecaria really
 * was amended in 1927 — so the URL stays in the sitemap. Only the `<lastmod>`
 * is dropped, because `<lastmod>` is optional in the protocol and a date we
 * invent to satisfy the parser would be a lie about when the page changed.
 *
 * The upper bound exists because the BOE itself ships corrupt dates:
 * BOE-A-1985-26400 carries `fecha_publicacion="29291119"` on the version its
 * derogation note was added in (the same `<version>` says `fpub="20210224"`),
 * so its frontmatter says `ultima_actualizacion: 2929-11-19` and
 * sitemap-leyes.xml advertised a lastmod nine centuries in the future.
 */
export function isEmittableLastmod(fecha: string, todayIso: string): boolean {
	return (
		isPlausibleReformDate(fecha, Number(todayIso.slice(0, 4))) &&
		fecha >= MIN_LASTMOD_ISO &&
		fecha <= todayIso
	);
}
