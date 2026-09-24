/**
 * Sitemap: core pages + the indexable law summary pages, generated from Content
 * Collections at build time. One of two child sitemaps referenced by the
 * /sitemap.xml index (see sitemap.xml.ts and sitemap-reformas.xml.ts).
 *
 * `<lastmod>` is when the page last changed: the later of the law's legal
 * update date and the date its own content last changed (page-lastmod.ts).
 * Which laws qualify, and how the date is picked, lives in lib/law-sitemap.ts.
 */

import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { todayIso } from "../lib/law-dates.ts";
import { lawSitemapEntries } from "../lib/law-sitemap.ts";
import { isIndexableLaw } from "../lib/manifest.ts";
import { lawContentDate } from "../lib/page-lastmod-build.ts";
import { SECONDARY_PAGES } from "../lib/site-pages.ts";

export const prerender = true;

const SITE_URL = "https://leyabierta.es";
const TODAY_ISO = todayIso();

export const GET: APIRoute = async () => {
	const laws = await getCollection("laws");

	const urls = [
		`  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`,
		...SECONDARY_PAGES.map(
			(p) => `  <url>
    <loc>${SITE_URL}${p.path}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`,
		),
	];

	// The full-text pages (/leyes/<id>/texto/, only built with
	// BUILD_TEXT_PAGES) are noindex and never listed.
	const entries = lawSitemapEntries(
		laws.map((l) => l.data),
		{
			siteUrl: SITE_URL,
			todayIso: TODAY_ISO,
			isIndexable: isIndexableLaw,
			contentDate: lawContentDate,
		},
	);
	for (const { loc, lastmod } of entries) {
		urls.push(`  <url>
    <loc>${loc}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`);
	}

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;

	return new Response(xml, {
		headers: { "Content-Type": "application/xml; charset=utf-8" },
	});
};
