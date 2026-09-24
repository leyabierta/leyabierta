/**
 * The one place that decides a law's "última actualización".
 *
 * The frontmatter `ultima_actualizacion` is the date the pipeline last
 * rendered the file at, and it can lag behind the reforms list: when the BOE
 * adds an older reform after newer ones were already committed, the pipeline
 * used to re-render the file at that older date (Estatuto de los
 * Trabajadores said 2023-03-01 while listing a 2025-12-04 reform). It can
 * also be corrupt (BOE-A-1985-26400 says 2929-11-19, straight from the BOE).
 *
 * So the effective date is the latest *plausible* date among
 * `ultima_actualizacion` and every `reformas[].fecha`, never after today.
 * Everything that shows or advertises the date — the law page header, its
 * JSON-LD `dateModified`, the /temas hubs, sitemap-leyes lastmod, the RSS
 * feed, llms-full.txt — must go through this helper so they cannot disagree.
 */

import { isPlausibleReformDate } from "./sitemap-dates.ts";

/** The slice of a law's frontmatter this module needs. */
export interface LawDateFields {
	ultima_actualizacion?: string;
	reformas?: readonly { fecha: string }[];
}

/** Build-time "today" (UTC), the default upper bound for every date here. */
export function todayIso(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Latest plausible update date of a law, or undefined if it has none.
 * `today` is injectable for tests; pages use the build date.
 */
export function effectiveLastUpdated(
	law: LawDateFields,
	today: string = todayIso(),
): string | undefined {
	const maxYear = Number(today.slice(0, 4));
	let latest: string | undefined;
	const consider = (d: string | undefined) => {
		// `d > today` is what rejects a future date within the current year
		// (isPlausibleReformDate only bounds the year). Note this is the web's
		// isPlausibleReformDate (window: build year), not the pipeline's
		// (window: today + 5 years); the two are not interchangeable.
		if (!d || d > today || !isPlausibleReformDate(d, maxYear)) return;
		if (!latest || d > latest) latest = d;
	};
	consider(law.ultima_actualizacion);
	for (const r of law.reformas ?? []) consider(r.fecha);
	return latest;
}

/**
 * When the law PAGE last changed: the later of the law's legal update date and
 * the date our own content on it last changed (see page-lastmod.ts). This is
 * what sitemap `<lastmod>` and the WebPage `dateModified` advertise; the
 * visible "última actualización" and the Legislation JSON-LD keep the legal
 * date. A content date after `today` is ignored (a future lastmod is rejected
 * by Google).
 */
export function pageLastModified(
	law: LawDateFields,
	contentDate: string | undefined,
	today: string = todayIso(),
): string | undefined {
	const legal = effectiveLastUpdated(law, today);
	const content = contentDate && contentDate <= today ? contentDate : undefined;
	if (!content) return legal;
	return !legal || content > legal ? content : legal;
}
