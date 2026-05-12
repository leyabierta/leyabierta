/**
 * Legacy sitemap: /laws/ URLs (pre-migration canonical).
 *
 * Purpose: help Google re-crawl and 301-redirect all ~12K old /laws/ URLs
 * to the new /leyes/ canonical after the 2026-05-03 URL migration.
 *
 * Submit to Google Search Console once, then remove this file (and the
 * sitemap submission) after ~4 weeks once Google has processed the redirects.
 *
 * See: https://leyabierta.es/sitemap.xml for the live canonical sitemap.
 */

import { getCollection } from "astro:content";
import type { APIRoute } from "astro";

export const prerender = true;

const SITE_URL = "https://leyabierta.es";

export const GET: APIRoute = async () => {
	const laws = await getCollection("laws");

	const urls: string[] = [];

	for (const law of laws) {
		const d = law.data;
		urls.push(`  <url>
    <loc>${SITE_URL}/laws/${d.identificador}/</loc>
  </url>`);
	}

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- LEGACY SITEMAP: /laws/ → /leyes/ migration (2026-05-03) -->
<!-- Remove this file and its Search Console submission after 2026-07-01 -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;

	return new Response(xml, {
		headers: { "Content-Type": "application/xml; charset=utf-8" },
	});
};
