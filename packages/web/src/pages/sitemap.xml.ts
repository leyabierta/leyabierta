/**
 * Sitemap index. Splits into two child sitemaps so each stays comfortably
 * under the sitemap protocol's 50k-URL-per-file limit:
 *  - sitemap-leyes.xml    — core pages + ~12k law detail pages
 *  - sitemap-reformas.xml — ~44k individual reform pages (see that file's
 *    header comment for why these were missing from the sitemap before).
 */

import type { APIRoute } from "astro";

export const prerender = true;

const SITE_URL = "https://leyabierta.es";

export const GET: APIRoute = async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${SITE_URL}/sitemap-leyes.xml</loc>
  </sitemap>
  <sitemap>
    <loc>${SITE_URL}/sitemap-reformas.xml</loc>
  </sitemap>
</sitemapindex>`;

	return new Response(xml, {
		headers: { "Content-Type": "application/xml; charset=utf-8" },
	});
};
