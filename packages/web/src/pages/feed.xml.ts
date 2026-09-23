/**
 * RSS feed generated from Content Collections at build time.
 */

import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { escapeHtml } from "../lib/escape.ts";
import { effectiveLastUpdated } from "../lib/law-dates.ts";

export const prerender = true;

const SITE_URL = "https://leyabierta.es";

export const GET: APIRoute = async () => {
	const laws = await getCollection("laws");

	// Sort by most recently updated. Effective date, not the raw frontmatter
	// field: a corrupt `2929-11-19` would otherwise top the feed forever.
	const sorted = laws
		.map((law) => ({ d: law.data, updated: effectiveLastUpdated(law.data) }))
		.filter((x): x is typeof x & { updated: string } => !!x.updated)
		.sort((a, b) => b.updated.localeCompare(a.updated))
		.slice(0, 50);

	const items = sorted.map(({ d, updated }) => {
		return `    <item>
      <title>${escapeHtml(d.titulo)}</title>
      <link>${SITE_URL}/leyes/${d.identificador}/</link>
      <guid>${SITE_URL}/leyes/${d.identificador}/</guid>
      <pubDate>${new Date(updated).toUTCString()}</pubDate>
      <description>${escapeHtml(d.rango)} · ${d.estado} · ${d.departamento}</description>
    </item>`;
	});

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Ley Abierta — Cambios legislativos</title>
    <link>${SITE_URL}</link>
    <description>Últimas actualizaciones en la legislación española consolidada.</description>
    <language>es</language>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
${items.join("\n")}
  </channel>
</rss>`;

	return new Response(xml, {
		headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
	});
};
