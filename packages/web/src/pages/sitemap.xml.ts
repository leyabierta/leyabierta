/**
 * Sitemap index. Splits into two child sitemaps so each stays comfortably
 * under the sitemap protocol's 50k-URL-per-file limit:
 *  - sitemap-leyes.xml    — core pages + ~12k law detail pages
 *  - sitemap-reformas.xml — ~34k individual reform pages (see that file's
 *    header comment for why these were missing from the sitemap before).
 *
 * Each child carries `<lastmod>` = the latest `<lastmod>` among its URLs,
 * computed from the same entries the child renders (lib/law-sitemap.ts,
 * lib/reform-sitemap.ts), so the index tells crawlers which child changed.
 */

import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { todayIso } from "../lib/law-dates.ts";
import { lawSitemapEntries, maxLastmod } from "../lib/law-sitemap.ts";
import { isIndexableLaw } from "../lib/manifest.ts";
import {
	lawContentDate,
	reformContentDate,
} from "../lib/page-lastmod-build.ts";
import { reformSitemapEntries } from "../lib/reform-sitemap.ts";

export const prerender = true;

const SITE_URL = "https://leyabierta.es";
const TODAY_ISO = todayIso();
const MAX_YEAR = new Date().getUTCFullYear() + 1;

export const GET: APIRoute = async () => {
	const laws = (await getCollection("laws")).map((l) => l.data);

	const children = [
		{
			loc: `${SITE_URL}/sitemap-leyes.xml`,
			lastmod: maxLastmod(
				lawSitemapEntries(laws, {
					siteUrl: SITE_URL,
					todayIso: TODAY_ISO,
					isIndexable: isIndexableLaw,
					contentDate: lawContentDate,
				}),
			),
		},
		{
			loc: `${SITE_URL}/sitemap-reformas.xml`,
			lastmod: maxLastmod(
				reformSitemapEntries(laws, {
					siteUrl: SITE_URL,
					todayIso: TODAY_ISO,
					maxYear: MAX_YEAR,
					contentDate: reformContentDate,
				}),
			),
		},
	];

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${children
	.map(
		({ loc, lastmod }) => `  <sitemap>
    <loc>${loc}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}
  </sitemap>`,
	)
	.join("\n")}
</sitemapindex>`;

	return new Response(xml, {
		headers: { "Content-Type": "application/xml; charset=utf-8" },
	});
};
