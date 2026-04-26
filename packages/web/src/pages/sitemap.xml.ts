/**
 * Sitemap generated from Content Collections at build time.
 */

import { getCollection } from "astro:content";
import type { APIRoute } from "astro";

export const prerender = true;

const SITE_URL = "https://leyabierta.es";

export const GET: APIRoute = async () => {
	const laws = await getCollection("laws");

	const secondaryPages = [
		{ path: "/cambios/", changefreq: "daily", priority: "0.6" },
		{ path: "/sobre-leyabierta/", changefreq: "monthly", priority: "0.4" },
		{ path: "/datos/", changefreq: "weekly", priority: "0.5" },
		{ path: "/alertas/", changefreq: "monthly", priority: "0.5" },
		{ path: "/mi-situacion/", changefreq: "monthly", priority: "0.5" },
		{ path: "/privacidad/", changefreq: "yearly", priority: "0.2" },
		{ path: "/cookies/", changefreq: "yearly", priority: "0.2" },
		{ path: "/aviso-legal/", changefreq: "yearly", priority: "0.2" },
	];

	const urls = [
		`  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`,
		...secondaryPages.map(
			(p) => `  <url>
    <loc>${SITE_URL}${p.path}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`,
		),
	];

	for (const law of laws) {
		const d = law.data;
		// Only include lastmod for dates from 1970 onward (Google rejects earlier dates)
		const lastmod =
			d.ultima_actualizacion &&
			/^\d{4}-\d{2}-\d{2}$/.test(d.ultima_actualizacion) &&
			d.ultima_actualizacion >= "1970-01-01"
				? `\n    <lastmod>${d.ultima_actualizacion}</lastmod>`
				: "";
		urls.push(`  <url>
    <loc>${SITE_URL}/laws/${d.identificador}/</loc>${lastmod}
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
