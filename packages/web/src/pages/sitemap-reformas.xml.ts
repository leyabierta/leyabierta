/**
 * Sitemap: reform detail pages (/cambios/reforma/?id=&date=), one <loc> per
 * reform enumerated from each law's `reformas[]` (excluding the original
 * version — that's the law page itself, already in sitemap-leyes.xml).
 *
 * This is the SEO recovery for the ~44k reform pages that were noindex'd on
 * 2026-05-04 when the reform page was collapsed into a single client-side
 * route (see the reform-SSR plan). Restoring a canonical, crawlable URL per
 * reform plus this sitemap entry is what lets Google re-discover them.
 *
 * One of two child sitemaps referenced by the /sitemap.xml index.
 *
 * Which URLs qualify lives in lib/reform-sitemap.ts so the rules are testable
 * without a build; this file only renders them.
 *
 * TODO: reformas count (~34.5k) fits under the 50k-URL sitemap protocol limit
 * today, but doesn't have much headroom. If it grows past ~48k, split this
 * file by year (sitemap-reformas-2024.xml, sitemap-reformas-2025.xml, ...)
 * and update the index in sitemap.xml.ts accordingly.
 */

import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { todayIso } from "../lib/law-dates.ts";
import { reformContentDate } from "../lib/page-lastmod-build.ts";
import { reformSitemapEntries } from "../lib/reform-sitemap.ts";

export const prerender = true;

const SITE_URL = "https://leyabierta.es";
const TODAY_ISO = todayIso();
const MAX_YEAR = new Date().getUTCFullYear() + 1;

export const GET: APIRoute = async () => {
	const laws = await getCollection("laws");

	const entries = reformSitemapEntries(
		laws.map((l) => l.data),
		{
			siteUrl: SITE_URL,
			todayIso: TODAY_ISO,
			maxYear: MAX_YEAR,
			contentDate: reformContentDate,
		},
	);

	// <lastmod> is the later of the reform date and the date its "qué cambió"
	// text last changed (page-lastmod.ts). It is optional, and omitted when it
	// would be a pre-1970 date: Google rejects those as "Invalid date" and the
	// URL is what we want crawled.
	const urls = entries.map(
		({ loc, lastmod }) => `  <url>
    <loc>${loc}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}
    <changefreq>never</changefreq>
    <priority>0.5</priority>
  </url>`,
	);

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;

	return new Response(xml, {
		headers: { "Content-Type": "application/xml; charset=utf-8" },
	});
};
