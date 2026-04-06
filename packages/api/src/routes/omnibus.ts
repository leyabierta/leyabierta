/**
 * Omnibus law endpoints: list, detail, and RSS feed.
 */
import { Elysia, t } from "elysia";
import type { DbService } from "../services/db.ts";

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function omnibusRoutes(dbService: DbService) {
	return new Elysia({ prefix: "/v1" })
		.get(
			"/omnibus",
			({ query }) => {
				const rawLimit = Number(query.limit);
				const limit =
					Number.isFinite(rawLimit) && rawLimit > 0
						? Math.min(rawLimit, 50)
						: 20;
				const since =
					query.since && /^\d{4}-\d{2}-\d{2}$/.test(query.since)
						? query.since
						: undefined;

				const omnibus = dbService.listRecentOmnibus(limit, since);

				return { data: omnibus };
			},
			{
				query: t.Object({
					limit: t.Optional(t.String()),
					since: t.Optional(t.String()),
				}),
			},
		)
		.get(
			"/omnibus/:normId",
			({ params, set }) => {
				const detail = dbService.getOmnibusDetail(params.normId);
				if (!detail) {
					set.status = 404;
					return { error: "Norm not found" };
				}

				return {
					...detail,
					sneaked_count: detail.topics.filter((t) => t.is_sneaked).length,
				};
			},
			{
				params: t.Object({
					normId: t.String(),
				}),
			},
		)
		.get("/feed-omnibus.xml", ({ set }) => {
			const omnibus = dbService.listRecentOmnibus(20);

			const items = omnibus
				.map((o) => {
					const topics = dbService.getOmnibusTopics(o.id);
					const topicLabels = topics.map((t) => t.topic_label).join(", ");
					const title = `Ley ómnibus: ${o.title} (${o.topic_count} temas)`;
					const description = topicLabels || `${o.materia_count} materias`;

					return `    <item>
      <title>${escapeXml(title)}</title>
      <link>https://leyabierta.es/omnibus/detalle?id=${escapeXml(o.id)}</link>
      <description>${escapeXml(description)}</description>
      <pubDate>${new Date(o.latest_reform_date).toUTCString()}</pubDate>
      <guid>https://leyabierta.es/omnibus/detalle?id=${escapeXml(o.id)}</guid>
    </item>`;
				})
				.join("\n");

			const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Leyes ómnibus — Ley Abierta</title>
    <link>https://leyabierta.es/omnibus</link>
    <description>Leyes que agrupan múltiples temas no relacionados en una sola norma</description>
    <language>es</language>
${items}
  </channel>
</rss>`;

			set.headers["Content-Type"] = "application/rss+xml; charset=utf-8";
			return xml;
		});
}
