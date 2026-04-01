/**
 * Sitemap generated from Content Collections at build time.
 */

import { getCollection } from "astro:content";
import type { APIRoute } from "astro";

export const prerender = true;

const SITE_URL = "https://leyabierta.es";

export const GET: APIRoute = async () => {
	const laws = await getCollection("laws");

	const urls = [
		`  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`,
	];

	for (const law of laws) {
		const d = law.data;
		// Only include lastmod if it's a valid YYYY-MM-DD date
		const lastmod =
			d.ultima_actualizacion && /^\d{4}-\d{2}-\d{2}$/.test(d.ultima_actualizacion)
				? `\n    <lastmod>${d.ultima_actualizacion}</lastmod>`
				: "";
		urls.push(`  <url>
    <loc>${SITE_URL}/laws/${d.identificador}</loc>${lastmod}
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
