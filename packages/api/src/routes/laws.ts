/**
 * Law endpoints: search, detail, versions, diff, references, graph.
 */

import { timingSafeEqual } from "node:crypto";
import { type BoeAnalisis, BoeClient } from "@leyabierta/pipeline";
import { Elysia, t } from "elysia";
import { LruCache } from "../services/cache.ts";
import type { CitizenSummaryService } from "../services/citizen-summary.ts";
import type { DbService } from "../services/db.ts";
import type { GitService } from "../services/git.ts";

const boeClient = new BoeClient();

/** Validate that a string is a real YYYY-MM-DD date (not just the right shape). */
export function isValidISODate(s: string): boolean {
	if (s.length !== 10) return false;
	const d = new Date(`${s}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return false;
	return d.toISOString().startsWith(s);
}

// Map norm to its filepath in the git repo (ELI convention: jurisdiction/ID.md)
function normFilepath(id: string, sourceUrl: string, country: string): string {
	const match = sourceUrl.match(/\/eli\/(es(?:-[a-z]{2})?)\//);
	const jurisdiction = match ? match[1]! : country;
	return `${jurisdiction}/${id}.md`;
}

const analisisCache = new LruCache<BoeAnalisis>(2000);

export function lawRoutes(
	dbService: DbService,
	gitService: GitService,
	diffCache: LruCache<string>,
	citizenSummaryService: CitizenSummaryService,
) {
	return (
		new Elysia({ prefix: "/v1" })
			// 1. GET /v1/laws — search/list
			.get(
				"/laws",
				({ query }) => {
					const limit = Math.min(query.limit ?? 20, 100);
					const offset = query.offset ?? 0;
					const { laws, total, capped } = dbService.searchLaws(
						query.q,
						{
							country: query.country,
							rank: query.rank,
							status: query.status,
							materia: query.materia,
							citizen_tag: query.citizen_tag,
						},
						limit,
						offset,
						query.sort,
					);
					return {
						data: laws,
						total,
						limit,
						offset,
						...(capped ? { capped: true } : {}),
					};
				},
				{
					query: t.Object({
						q: t.Optional(t.String()),
						country: t.Optional(t.String()),
						rank: t.Optional(t.String()),
						status: t.Optional(t.String()),
						materia: t.Optional(t.String()),
						citizen_tag: t.Optional(t.String()),
						limit: t.Optional(t.Numeric()),
						offset: t.Optional(t.Numeric()),
						sort: t.Optional(t.String()),
					}),
					detail: {
						summary: "Search and list laws",
						description:
							"Full-text search and filtered listing of consolidated laws. Supports pagination, filtering by country, rank, status, materia, and citizen tag.",
						tags: ["Leyes"],
					},
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
					const reforms = dbService.getReformsWithBlocks(params.id);
					const blocks = dbService.getBlocks(params.id);
					const citizenTags = dbService.getCitizenTags(params.id);
					return {
						...law,
						citizen_tags: citizenTags,
						reforms,
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
					detail: {
						summary: "Get law detail",
						description:
							"Returns full law metadata, reforms, citizen tags, and structural blocks.",
						tags: ["Leyes"],
					},
				},
			)

			// 3. GET /v1/laws/:id/articles/:n — specific block by position
			.get(
				"/laws/:id/articles/:n",
				async ({ params, set }) => {
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

					// On-demand citizen summary (cached in DB after first generation)
					const citizen = await citizenSummaryService.getOrGenerate(
						params.id,
						block.block_id,
						law.title,
						block.title,
						block.current_text,
					);

					return {
						block_id: block.block_id,
						block_type: block.block_type,
						title: block.title,
						position: block.position,
						current_text: block.current_text,
						citizen_summary: citizen?.citizen_summary ?? "",
						citizen_tags: citizen?.citizen_tags ?? [],
						versions: versions.map((v) => ({
							date: v.date,
							source_id: v.source_id,
							text: v.text,
						})),
					};
				},
				{
					params: t.Object({ id: t.String(), n: t.String() }),
					detail: {
						summary: "Get article by position",
						description:
							"Returns a specific article (block) by its position within the law, including all historical versions.",
						tags: ["Leyes"],
					},
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
					const reforms = dbService.getReformsWithBlocks(params.id);
					const allBlocks = dbService.getBlocks(params.id);
					const blockTitleMap = new Map(
						allBlocks.map((b) => [b.block_id, b.title]),
					);

					return {
						id: params.id,
						title: law.title,
						total_reforms: reforms.length,
						reforms: reforms.map((r) => ({
							date: r.date,
							source_id: r.source_id,
							affected_blocks: r.affected_blocks.map((blockId) => ({
								block_id: blockId,
								title: blockTitleMap.get(blockId) ?? blockId,
							})),
						})),
					};
				},
				{
					params: t.Object({ id: t.String() }),
					detail: {
						summary: "Get reform history",
						description:
							"Returns the full reform timeline for a law, including which blocks were affected by each reform.",
						tags: ["Leyes"],
					},
				},
			)

			// 5. GET /v1/laws/:id/versions/:date — Markdown at date
			.get(
				"/laws/:id/versions/:date",
				async ({ params, set }) => {
					if (!isValidISODate(params.date)) {
						set.status = 400;
						return { error: "Invalid date format. Use YYYY-MM-DD" };
					}
					const law = dbService.getLaw(params.id);
					if (!law) {
						set.status = 404;
						return { error: "Law not found" };
					}
					const filePath = normFilepath(params.id, law.source_url, law.country);
					const content = await gitService.getFileAtDate(filePath, params.date);
					if (content === null) {
						set.status = 404;
						return { error: "Version not found at this date" };
					}
					return { id: params.id, date: params.date, content };
				},
				{
					params: t.Object({ id: t.String(), date: t.String() }),
					detail: {
						summary: "Get law version at date",
						description:
							"Returns the full Markdown content of a law as it was on a specific date.",
						tags: ["Leyes"],
					},
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

					if (!isValidISODate(query.from) || !isValidISODate(query.to)) {
						set.status = 400;
						return { error: "Invalid date format. Use YYYY-MM-DD" };
					}

					const cacheKey = `${params.id}:${query.from}:${query.to}`;
					let diff = diffCache.get(cacheKey);
					if (diff === undefined) {
						const filePath = normFilepath(
							params.id,
							law.source_url,
							law.country,
						);
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
					detail: {
						summary: "Diff between two dates",
						description:
							"Returns a unified diff of a law between two dates. Both 'from' and 'to' query params are required (YYYY-MM-DD).",
						tags: ["Leyes"],
					},
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
					detail: {
						summary: "Get law analysis",
						description:
							"Returns materias, notas, and cross-references for a law. Falls back to BOE API if not cached locally.",
						tags: ["Leyes"],
					},
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
					detail: {
						summary: "Get relationship graph",
						description:
							"Returns graph nodes and edges representing cross-references for a law.",
						tags: ["Leyes"],
					},
				},
			)

			// 9. GET /v1/ranks — rank types with counts
			.get(
				"/ranks",
				() => {
					return { data: dbService.getRanks() };
				},
				{
					detail: {
						summary: "List rank types",
						description: "Returns all legislative rank types with law counts.",
						tags: ["Leyes"],
					},
				},
			)

			// 10. GET /v1/materias — subject categories with counts
			.get(
				"/materias",
				() => {
					return { data: dbService.listMaterias() };
				},
				{
					detail: {
						summary: "List subject categories",
						description:
							"Returns all materia (subject) categories with law counts.",
						tags: ["Leyes"],
					},
				},
			)

			// 11. GET /v1/citizen-tags — citizen tag categories with counts
			.get(
				"/citizen-tags",
				({ query }) => {
					const limit = Math.min(query.limit ?? 100, 500);
					return { data: dbService.listCitizenTags(limit) };
				},
				{
					query: t.Object({
						limit: t.Optional(t.Numeric()),
					}),
					detail: {
						summary: "List citizen tags",
						description:
							"Returns citizen-friendly tag categories with law counts.",
						tags: ["Leyes"],
					},
				},
			)

			// 12. GET /v1/stats — global statistics
			.get(
				"/stats",
				() => {
					return dbService.getStats();
				},
				{
					detail: {
						summary: "Global statistics",
						description:
							"Returns aggregate statistics: total laws, reforms, jurisdictions, etc.",
						tags: ["Leyes"],
					},
				},
			)

			// 13. GET /v1/most-reformed — most reformed laws
			.get(
				"/most-reformed",
				() => {
					return { data: dbService.getMostReformed(10) };
				},
				{
					detail: {
						summary: "Most reformed laws",
						description: "Returns the top 10 most frequently reformed laws.",
						tags: ["Leyes"],
					},
				},
			)

			// 14. GET /v1/jurisdictions — jurisdiction counts
			.get(
				"/jurisdictions",
				() => {
					return { data: dbService.getJurisdictions() };
				},
				{
					detail: {
						summary: "List jurisdictions",
						description:
							"Returns all jurisdictions (state + autonomous communities) with law counts.",
						tags: ["Leyes"],
					},
				},
			)

			// 15. GET /v1/recent-reforms — recently updated laws
			.get(
				"/recent-reforms",
				() => {
					return { data: dbService.getRecentlyUpdated(10) };
				},
				{
					detail: {
						summary: "Recent reforms",
						description: "Returns the 10 most recently reformed laws.",
						tags: ["Leyes"],
					},
				},
			)

			// 16. GET /v1/build-manifest — bulk citizen data + omnibus topics for static build
			.get(
				"/build-manifest",
				({ set, request }) => {
					// Require API bypass key (internal endpoint for CI builds)
					const apiKey = request.headers.get("x-api-key") ?? "";
					const bypassKey = process.env.API_BYPASS_KEY ?? "";
					const hasValidKey =
						bypassKey &&
						apiKey.length === bypassKey.length &&
						timingSafeEqual(Buffer.from(apiKey), Buffer.from(bypassKey));
					if (!hasValidKey) {
						set.status = 403;
						return { error: "Forbidden" };
					}
					set.headers["Cache-Control"] = "private, max-age=300";
					try {
						return dbService.getBuildManifest();
					} catch (err) {
						set.status = 500;
						return {
							error: "Failed to generate build manifest",
							detail: err instanceof Error ? err.message : "Unknown error",
						};
					}
				},
				{
					detail: {
						summary: "Build manifest",
						description:
							"Internal endpoint for CI builds. Returns bulk citizen data and omnibus topics. Requires API bypass key.",
						tags: ["Sistema"],
					},
				},
			)

			// 18. GET /v1/feed.xml — RSS feed of recent reforms
			.get(
				"/feed.xml",
				({ set }) => {
					const reforms = dbService.getRecentReforms(50);
					const items = reforms
						.map((r) => {
							const rawTitle = r.headline || `${r.title} — ${r.date}`;
							const rawDesc =
								r.summary || `Reforma de ${r.title} (${r.source_id})`;
							return `  <item>
    <title>${escapeXml(rawTitle)}</title>
    <link>https://leyabierta.es/laws/${r.norm_id}</link>
    <guid>${r.norm_id}:${r.date}:${r.source_id}</guid>
    <pubDate>${new Date(r.date).toUTCString()}</pubDate>
    <description>${escapeXml(rawDesc)}</description>
  </item>`;
						})
						.join("\n");

					set.headers["content-type"] = "application/rss+xml; charset=utf-8";
					return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Ley Abierta — Reformas recientes</title>
  <link>https://leyabierta.es</link>
  <description>Cambios recientes en la legislación española consolidada</description>
  <language>es</language>
${items}
</channel>
</rss>`;
				},
				{
					detail: {
						summary: "RSS feed of recent reforms",
						description:
							"Returns an RSS 2.0 XML feed of the 50 most recent legislative reforms.",
						tags: ["Leyes"],
					},
				},
			)
	);
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
