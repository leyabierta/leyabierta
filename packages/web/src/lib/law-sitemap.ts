/**
 * Which law URLs go in sitemap-leyes.xml, and with which `<lastmod>`.
 *
 * Extracted from the route so the sitemap index can compute its own
 * `<lastmod>` (the max of its children's) from the same entries, and so the
 * rules are testable without a build.
 */

import { type LawDateFields, pageLastModified } from "./law-dates.ts";
import { isEmittableLastmod } from "./sitemap-dates.ts";

export interface LawSitemapEntry {
	loc: string;
	lastmod?: string;
}

export interface LawSitemapLaw extends LawDateFields {
	identificador: string;
}

export function lawSitemapEntries(
	laws: readonly LawSitemapLaw[],
	opts: {
		siteUrl: string;
		todayIso: string;
		/** Thin pages are `noindex`: listing them would contradict that. */
		isIndexable: (id: string) => boolean;
		/** When the page's own content last changed (page-lastmod.ts). */
		contentDate: (id: string) => string | undefined;
	},
): LawSitemapEntry[] {
	const entries: LawSitemapEntry[] = [];
	for (const law of laws) {
		const id = law.identificador;
		if (!opts.isIndexable(id)) continue;
		const updated = pageLastModified(law, opts.contentDate(id), opts.todayIso);
		// Only emit lastmod for dates Google accepts — see isEmittableLastmod.
		entries.push(
			updated && isEmittableLastmod(updated, opts.todayIso)
				? { loc: `${opts.siteUrl}/leyes/${id}/`, lastmod: updated }
				: { loc: `${opts.siteUrl}/leyes/${id}/` },
		);
	}
	return entries;
}

/** Latest `<lastmod>` among some entries (for the sitemap index). */
export function maxLastmod(
	entries: readonly { lastmod?: string }[],
): string | undefined {
	let best: string | undefined;
	for (const e of entries)
		if (e.lastmod && (!best || e.lastmod > best)) best = e.lastmod;
	return best;
}
