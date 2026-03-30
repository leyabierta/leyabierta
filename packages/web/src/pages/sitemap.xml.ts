import type { APIRoute } from "astro";
import type { Law } from "../lib/api";
import { searchLaws } from "../lib/api";

const SITE_URL = "https://leyabierta.es";
const PAGE_LIMIT = 100;

async function fetchAllLaws(): Promise<Law[]> {
	const allLaws: Law[] = [];
	let offset = 0;

	while (true) {
		const result = await searchLaws({
			limit: String(PAGE_LIMIT),
			offset: String(offset),
		});
		allLaws.push(...result.data);
		if (offset + PAGE_LIMIT >= result.total) break;
		offset += PAGE_LIMIT;
	}

	return allLaws;
}

function buildSitemap(laws: Law[]): string {
	const urls = [
		`  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`,
	];

	for (const law of laws) {
		const lastmod = law.updated_at ?? law.published_at;
		urls.push(`  <url>
    <loc>${SITE_URL}/laws/${law.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`);
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;
}

export const GET: APIRoute = async () => {
	const laws = await fetchAllLaws();
	const body = buildSitemap(laws);

	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
		},
	});
};
