/**
 * Path-form reform URLs — a scoped crawlability experiment.
 *
 * Background: as of 2026-07-28 Google had never crawled a single one of the
 * ~35k `/cambios/reforma/?id=&date=` URLs. A URL Inspection sweep of 600 found
 * 339 "Discovered - currently not indexed", 261 unknown to Google, and zero
 * with a `lastCrawlTime`. Meanwhile law pages under `/leyes/<id>/` — same site,
 * same shell, real paths — are crawled routinely (median 74 days) even though
 * most aren't indexed. The difference between the two cohorts is the URL shape.
 *
 * Hypothesis: 35k URLs differing only in query string read as faceted
 * navigation, and Google won't spend crawl budget on that for a domain with
 * our authority. Path URLs should get crawled.
 *
 * Rather than migrate all 35k at once on an untested hypothesis, only reforms
 * from `EXPERIMENT_YEAR` (688 URLs) switch to the path form. They are the
 * treatment group; the other ~34.3k keep the query form and act as control.
 * If Googlebot starts crawling the treatment group and not the control, the
 * hypothesis holds and the rest can follow.
 *
 * Both URL forms are always *served* — this only decides which one is canonical
 * and which one goes in the sitemap. Nothing breaks for existing links.
 */

/** Reforms dated in this year use path-form URLs. */
export const EXPERIMENT_YEAR = "2026";

/** True when a reform's date puts it in the path-form treatment group. */
export function isPathFormReform(date: string): boolean {
	return date.startsWith(`${EXPERIMENT_YEAR}-`);
}

/** Base path for reform detail pages, both URL forms. */
export const REFORM_PATH_PREFIX = "/cambios/reforma/";

/**
 * Canonical URL for a reform. Reforms in the path-form experiment canonicalise
 * to the path; every other reform keeps the query form. Serving one canonical
 * per reform matters more than which form wins — two indexable URLs for the
 * same content is the failure mode to avoid while both are live.
 */
export function reformCanonicalPath(normId: string, date: string): string {
	return isPathFormReform(date)
		? `${REFORM_PATH_PREFIX}${encodeURIComponent(normId)}/${date}/`
		: `${REFORM_PATH_PREFIX}?id=${encodeURIComponent(normId)}&date=${encodeURIComponent(date)}`;
}
