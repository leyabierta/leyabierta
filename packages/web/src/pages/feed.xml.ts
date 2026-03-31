/**
 * RSS feed generated from Content Collections at build time.
 */

import { getCollection } from "astro:content";
import type { APIRoute } from "astro";

export const prerender = true;

const SITE_URL = "https://leyabierta.es";

export const GET: APIRoute = async () => {
	const laws = await getCollection("laws");

	// Sort by most recently updated
	const sorted = laws
		.sort((a, b) =>
			b.data.ultima_actualizacion.localeCompare(a.data.ultima_actualizacion),
		)
		.slice(0, 50);

	const items = sorted.map((law) => {
		const d = law.data;
		return `    <item>
      <title>${escapeXml(d.titulo)}</title>
      <link>${SITE_URL}/laws/${d.identificador}</link>
      <guid>${SITE_URL}/laws/${d.identificador}</guid>
      <pubDate>${new Date(d.ultima_actualizacion).toUTCString()}</pubDate>
      <description>${escapeXml(d.rango)} · ${d.estado} · ${d.departamento}</description>
    </item>`;
	});

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Ley Abierta — Cambios legislativos</title>
    <link>${SITE_URL}</link>
    <description>Ultimas actualizaciones en la legislacion espanola consolidada.</description>
    <language>es</language>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
${items.join("\n")}
  </channel>
</rss>`;

	return new Response(xml, {
		headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
	});
};

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
