/**
 * Which reform URLs belong in sitemap-reformas.xml.
 *
 * Extracted from the route so the selection rules — skip the original version,
 * drop corrupt dates, clamp future lastmods, and emit each URL once — can be
 * tested without an Astro build. The route only turns these into XML.
 */

import { reformCanonicalPath } from "./reform-experiment.ts";
import { clampLastmod, isPlausibleReformDate } from "./sitemap-dates.ts";

export interface ReformSitemapEntry {
	loc: string;
	lastmod: string;
}

/** The slice of a law's frontmatter this module needs. */
export interface ReformSitemapLaw {
	identificador: string;
	fecha_publicacion: string;
	reformas: { fecha: string }[];
}

export function reformSitemapEntries(
	laws: ReformSitemapLaw[],
	opts: { siteUrl: string; todayIso: string; maxYear: number },
): ReformSitemapEntry[] {
	const entries: ReformSitemapEntry[] = [];
	// A law can be amended by two different norms on the same day, so `reformas[]`
	// holds several entries sharing one date. The URL carries only id + date, so
	// those collapse to the same <loc> — 558 redundant entries as of 2026-08-21,
	// across 380 laws. Duplicates buy nothing and eat headroom against the
	// 50k-URL sitemap limit.
	const seen = new Set<string>();

	for (const law of laws) {
		for (const reforma of law.reformas) {
			// The original version's "reforma" entry shares the law's publication
			// date — it's not a change, it's the law coming into existence. Skip it;
			// that content lives at /leyes/<id>/, not /cambios/reforma/.
			if (reforma.fecha === law.fecha_publicacion) continue;
			// Drop corrupt pipeline dates (e.g. year 2929) — Google rejected the
			// whole sitemap over 160 such "Invalid date" lastmods, keeping ~35k
			// reform URLs out of the index.
			if (!isPlausibleReformDate(reforma.fecha, opts.maxYear)) continue;

			// Path form for the experiment cohort, query form for the rest. The
			// sitemap must advertise exactly the URL the worker calls canonical,
			// or we'd be asking Google to index a URL that points elsewhere.
			const loc =
				`${opts.siteUrl}${reformCanonicalPath(law.identificador, reforma.fecha)}`.replace(
					/&(?!amp;)/g,
					"&amp;",
				);
			if (seen.has(loc)) continue;
			seen.add(loc);
			// lastmod must never be in the future (Google flags it as invalid).
			entries.push({
				loc,
				lastmod: clampLastmod(reforma.fecha, opts.todayIso),
			});
		}
	}

	return entries;
}
