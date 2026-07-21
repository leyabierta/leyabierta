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
 * TODO: reformas count (~44k) fits under the 50k-URL sitemap protocol limit
 * today, but doesn't have much headroom. If it grows past ~48k, split this
 * file by year (sitemap-reformas-2024.xml, sitemap-reformas-2025.xml, ...)
 * and update the index in sitemap.xml.ts accordingly.
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
		for (const reforma of d.reformas) {
			// The original version's "reforma" entry shares the law's publication
			// date — it's not a change, it's the law coming into existence. Skip it;
			// that content lives at /leyes/<id>/, not /cambios/reforma/.
			if (reforma.fecha === d.fecha_publicacion) continue;
			if (!/^\d{4}-\d{2}-\d{2}$/.test(reforma.fecha)) continue;

			const loc = `${SITE_URL}/cambios/reforma/?id=${encodeURIComponent(d.identificador)}&amp;date=${encodeURIComponent(reforma.fecha)}`;
			urls.push(`  <url>
    <loc>${loc}</loc>
    <lastmod>${reforma.fecha}</lastmod>
    <changefreq>never</changefreq>
    <priority>0.5</priority>
  </url>`);
		}
	}

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;

	return new Response(xml, {
		headers: { "Content-Type": "application/xml; charset=utf-8" },
	});
};
