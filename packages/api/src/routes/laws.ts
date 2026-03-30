/**
 * Law endpoints: search, detail, versions, diff, references, graph.
 */

import { type BoeAnalisis, BoeClient } from "@leylibre/pipeline";
import { Elysia, t } from "elysia";
import { LruCache } from "../services/cache.ts";
import type { DbService } from "../services/db.ts";
import type { GitService } from "../services/git.ts";

const boeClient = new BoeClient();

// Map norm id to its filepath in the git repo
function normFilepath(id: string, rank: string): string {
	const RANK_FOLDERS: Record<string, string> = {
		constitucion: "constituciones",
		ley_organica: "leyes-organicas",
		ley: "leyes",
		real_decreto_ley: "reales-decretos-ley",
		real_decreto_legislativo: "reales-decretos-legislativos",
		real_decreto: "reales-decretos",
		orden: "ordenes",
		resolucion: "resoluciones",
		acuerdo_internacional: "acuerdos-internacionales",
		circular: "circulares",
		instruccion: "instrucciones",
		decreto: "decretos",
		reglamento: "reglamentos",
	};
	const folder = RANK_FOLDERS[rank] ?? "otros";
	return `${folder}/${id}.md`;
}

const analisisCache = new LruCache<BoeAnalisis>(200);

export function lawRoutes(
	dbService: DbService,
	gitService: GitService,
	diffCache: LruCache<string>,
) {
	return (
		new Elysia({ prefix: "/v1" })
			// 1. GET /v1/laws — search/list
			.get(
				"/laws",
				({ query }) => {
					const limit = Math.min(query.limit ?? 20, 100);
					const offset = query.offset ?? 0;
					const { laws, total } = dbService.searchLaws(
						query.q,
						{
							country: query.country,
							rank: query.rank,
							status: query.status,
						},
						limit,
						offset,
					);
					return {
						data: laws,
						total,
						limit,
						offset,
					};
				},
				{
					query: t.Object({
						q: t.Optional(t.String()),
						country: t.Optional(t.String()),
						rank: t.Optional(t.String()),
						status: t.Optional(t.String()),
						limit: t.Optional(t.Numeric()),
						offset: t.Optional(t.Numeric()),
					}),
				},
			)

			// 2. GET /v1/laws/:id — law detail + reforms
			.get(
				"/laws/:id",
				({ params, set }) => {
					const law = dbService.getLaw(params.id);
					if (!law) {
						set.status = 404;
						return { error: "Law not found" };
					}
					const reforms = dbService.getReforms(params.id);
					const blocks = dbService.getBlocks(params.id);
					return {
						...law,
						reforms: reforms.map((r) => ({
							...r,
							affected_blocks: dbService.getReformBlocks(
								params.id,
								r.date,
								r.source_id,
							),
						})),
						blocks: blocks.map((b) => ({
							block_id: b.block_id,
							block_type: b.block_type,
							title: b.title,
							position: b.position,
							current_text: b.current_text,
						})),
					};
				},
				{
					params: t.Object({ id: t.String() }),
				},
			)

			// 3. GET /v1/laws/:id/articles/:n — specific block by position
			.get(
				"/laws/:id/articles/:n",
				({ params, set }) => {
					const law = dbService.getLaw(params.id);
					if (!law) {
						set.status = 404;
						return { error: "Law not found" };
					}
					const position = Number(params.n);
					const block = dbService.getBlockByPosition(params.id, position);
					if (!block) {
						set.status = 404;
						return { error: "Block not found at this position" };
					}
					const versions = dbService.getVersions(params.id, block.block_id);
					return {
						block_id: block.block_id,
						block_type: block.block_type,
						title: block.title,
						position: block.position,
						current_text: block.current_text,
						versions: versions.map((v) => ({
							date: v.date,
							source_id: v.source_id,
							text: v.text,
						})),
					};
				},
				{
					params: t.Object({ id: t.String(), n: t.String() }),
				},
			)

			// 4. GET /v1/laws/:id/history — reform timeline with affected block titles
			.get(
				"/laws/:id/history",
				({ params, set }) => {
					const law = dbService.getLaw(params.id);
					if (!law) {
						set.status = 404;
						return { error: "Law not found" };
					}
					const reforms = dbService.getReforms(params.id);
					const allBlocks = dbService.getBlocks(params.id);
					const blockTitleMap = new Map(
						allBlocks.map((b) => [b.block_id, b.title]),
					);

					return {
						id: params.id,
						title: law.title,
						total_reforms: reforms.length,
						reforms: reforms.map((r) => {
							const affectedBlockIds = dbService.getReformBlocks(
								params.id,
								r.date,
								r.source_id,
							);
							return {
								date: r.date,
								source_id: r.source_id,
								affected_blocks: affectedBlockIds.map((blockId) => ({
									block_id: blockId,
									title: blockTitleMap.get(blockId) ?? blockId,
								})),
							};
						}),
					};
				},
				{
					params: t.Object({ id: t.String() }),
				},
			)

			// 5. GET /v1/laws/:id/versions/:date — Markdown at date
			.get(
				"/laws/:id/versions/:date",
				async ({ params, set }) => {
					const law = dbService.getLaw(params.id);
					if (!law) {
						set.status = 404;
						return { error: "Law not found" };
					}
					const filePath = normFilepath(params.id, law.rank);
					const content = await gitService.getFileAtDate(filePath, params.date);
					if (content === null) {
						set.status = 404;
						return { error: "Version not found at this date" };
					}
					return { id: params.id, date: params.date, content };
				},
				{
					params: t.Object({ id: t.String(), date: t.String() }),
				},
			)

			// 6. GET /v1/laws/:id/diff — diff between two dates
			.get(
				"/laws/:id/diff",
				async ({ params, query, set }) => {
					const law = dbService.getLaw(params.id);
					if (!law) {
						set.status = 404;
						return { error: "Law not found" };
					}
					if (!query.from || !query.to) {
						set.status = 400;
						return { error: "Both 'from' and 'to' query params required" };
					}

					const cacheKey = `${params.id}:${query.from}:${query.to}`;
					let diff = diffCache.get(cacheKey);
					if (diff === undefined) {
						const filePath = normFilepath(params.id, law.rank);
						const result = await gitService.diff(
							filePath,
							query.from,
							query.to,
						);
						if (result === null) {
							set.status = 404;
							return { error: "Could not compute diff for these dates" };
						}
						diff = result;
						diffCache.set(cacheKey, diff);
					}

					return { id: params.id, from: query.from, to: query.to, diff };
				},
				{
					params: t.Object({ id: t.String() }),
					query: t.Object({
						from: t.Optional(t.String()),
						to: t.Optional(t.String()),
					}),
				},
			)

			// 7. GET /v1/laws/:id/analisis — DB local, fallback to BOE API
			.get(
				"/laws/:id/analisis",
				async ({ params, set }) => {
					const law = dbService.getLaw(params.id);
					if (!law) {
						set.status = 404;
						return { error: "Law not found" };
					}

					// Try local DB first
					if (dbService.hasAnalisis(params.id)) {
						const anteriores = dbService.getReferencias(params.id, "anterior");
						const posteriores = dbService.getReferencias(
							params.id,
							"posterior",
						);
						return {
							id: params.id,
							materias: dbService.getMaterias(params.id),
							notas: dbService.getNotas(params.id),
							referencias: {
								anteriores: anteriores.map((r) => ({
									relation: r.relation,
									normId: r.target_id,
									text: r.text,
								})),
								posteriores: posteriores.map((r) => ({
									relation: r.relation,
									normId: r.target_id,
									text: r.text,
								})),
							},
						};
					}

					// Fallback: proxy to BOE API (cached in memory)
					const cacheKey = `analisis:${params.id}`;
					let cached = analisisCache.get(cacheKey);
					if (!cached) {
						try {
							cached = await boeClient.getAnalisis(params.id);
							analisisCache.set(cacheKey, cached);
						} catch {
							return {
								id: params.id,
								materias: [],
								notas: [],
								referencias: { anteriores: [], posteriores: [] },
							};
						}
					}
					return { id: params.id, ...cached };
				},
				{
					params: t.Object({ id: t.String() }),
				},
			)

			// 8. GET /v1/laws/:id/graph — relationship graph data
			.get(
				"/laws/:id/graph",
				({ params, set }) => {
					const law = dbService.getLaw(params.id);
					if (!law) {
						set.status = 404;
						return { error: "Law not found" };
					}
					// Graph will be populated in Phase 2 with reference data
					return {
						nodes: [{ id: params.id, title: law.title, rank: law.rank }],
						edges: [],
					};
				},
				{
					params: t.Object({ id: t.String() }),
				},
			)

			// 9. GET /v1/materias — ranks/categories available
			.get("/materias", () => {
				return { data: dbService.getRanks() };
			})

			// 10. GET /v1/feed.xml — RSS feed of recent reforms
			.get("/feed.xml", ({ set }) => {
				const reforms = dbService.getRecentReforms(50);
				const items = reforms
					.map(
						(r) => `  <item>
    <title>${escapeXml(r.title)} — ${r.date}</title>
    <link>https://leylibre.es/laws/${r.norm_id}</link>
    <guid>${r.norm_id}:${r.date}:${r.source_id}</guid>
    <pubDate>${new Date(r.date).toUTCString()}</pubDate>
    <description>Reforma de ${escapeXml(r.title)} (${r.source_id})</description>
  </item>`,
					)
					.join("\n");

				set.headers["content-type"] = "application/rss+xml; charset=utf-8";
				return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Ley Libre — Reformas recientes</title>
  <link>https://leylibre.es</link>
  <description>Cambios recientes en la legislación española consolidada</description>
  <language>es</language>
${items}
</channel>
</rss>`;
			})
	);
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
