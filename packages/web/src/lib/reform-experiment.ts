/**
 * Path-form reform URLs — a scoped crawlability experiment.
 *
 * Background: as of 2026-07-28 Google had never crawled a single one of the
 * ~35k `/cambios/reforma/?id=&date=` URLs. A URL Inspection sweep of 600 found
 * 339 "Discovered - currently not indexed", 261 unknown to Google, and zero
 * with a `lastCrawlTime`. Meanwhile law pages under `/leyes/<id>/` — same site,
 * same shell, real paths — are crawled routinely (99.1%) even though most
 * aren't indexed. The difference between the two cohorts is the URL shape.
 *
 * Hypothesis: 35k URLs differing only in query string read as faceted
 * navigation, and Google won't spend crawl budget on that for a domain with
 * our authority. Path URLs should get crawled.
 *
 * ## Why the split is random within one year, not "2026 vs older"
 *
 * The obvious design — migrate 2026, keep the rest as control — confounds URL
 * shape with recency. Google prefers fresh content and recently-changed laws
 * carry more internal links, so 2026 URLs could start getting crawled for
 * reasons that have nothing to do with their shape. That result would look like
 * success and would justify migrating the other 34k on a false premise.
 *
 * So the split is *within* 2026: each reform is assigned to path or query form
 * by a hash of its identity, giving two arms of ~340 that are identical in
 * freshness, link structure and law mix. The only systematic difference left is
 * the URL shape, which is the thing under test. Pre-2026 reforms stay on the
 * query form and are reported separately as historical background, never as the
 * control the verdict rests on.
 *
 * Assignment must be deterministic: the worker, the sitemap and the law page
 * each compute it independently, and a random assignment would put them in
 * disagreement — advertising one URL while canonicalising another.
 *
 * Both URL forms are always *served*. This only decides which one is canonical
 * and which one goes in the sitemap. Nothing breaks for existing links.
 */

/** Reforms dated in this year take part in the experiment. */
export const EXPERIMENT_YEAR = "2026";

/** Base path for reform detail pages, both URL forms. */
export const REFORM_PATH_PREFIX = "/cambios/reforma/";

/** True when a reform's date falls in the experiment year (either arm). */
export function isExperimentReform(date: string): boolean {
	return date.startsWith(`${EXPERIMENT_YEAR}-`);
}

/**
 * FNV-1a over `<normId>|<date>`. Any stable hash would do; what matters is that
 * it depends only on the reform's identity, so every caller agrees without
 * sharing state.
 */
function hash(normId: string, date: string): number {
	let h = 0x811c9dc5;
	const key = `${normId}|${date}`;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/** True when this reform is in the path-form (treatment) arm. */
export function isPathFormReform(normId: string, date: string): boolean {
	return isExperimentReform(date) && hash(normId, date) % 2 === 0;
}

/**
 * Canonical URL for a reform: path form for the treatment arm, query form for
 * everything else. Serving one canonical per reform matters more than which
 * form wins — two indexable URLs for the same content is the failure mode to
 * avoid while both are live.
 */
export function reformCanonicalPath(normId: string, date: string): string {
	return isPathFormReform(normId, date)
		? `${REFORM_PATH_PREFIX}${encodeURIComponent(normId)}/${date}/`
		: `${REFORM_PATH_PREFIX}?id=${encodeURIComponent(normId)}&date=${encodeURIComponent(date)}`;
}
