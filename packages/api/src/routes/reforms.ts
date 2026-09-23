/**
 * Reform endpoints: personal reforms by materia + public changelog.
 */
import { Elysia, t } from "elysia";
import { computeMaterias } from "../data/materia-mappings.ts";
import type { DbService } from "../services/db.ts";

const JURISDICTION_RE = /^es(-[a-z]{2})?$/;

const DEFAULT_CHANGELOG_WEEKS = 4;
const MAX_CHANGELOG_WEEKS = 12;
const DEFAULT_CHANGELOG_LIMIT = 50;
const MAX_CHANGELOG_LIMIT = 100;
const MAX_CHANGELOG_OFFSET = 10_000;

/**
 * Parse an optional integer query param. Returns the fallback when absent
 * or empty (`?weeks=` always meant "default" and must keep working), and
 * null when present but not a plain integer (e.g. "abc", "1.5").
 */
function parseIntParam(
	raw: string | undefined,
	fallback: number,
): number | null {
	const value = raw?.trim();
	if (!value) return fallback;
	if (!/^-?\d+$/.test(value)) return null;
	return Number(value);
}

export function reformRoutes(dbService: DbService) {
	return new Elysia({ prefix: "/v1" })
		.get(
			"/reforms/personal",
			({ query, set }) => {
				const limit = query.limit
					? Math.max(1, Math.min(Number(query.limit), 100))
					: 20;
				const offset = query.offset ? Math.max(0, Number(query.offset)) : 0;
				if (Number.isNaN(limit) || Number.isNaN(offset)) {
					set.status = 400;
					return { error: "limit and offset must be numbers" };
				}

				// `jurisdiction` is accepted as an alias (llms-full.txt documented it);
				// `jurisdiccion` wins if both are set, same as /v1/changelog.
				const jurisdiction =
					query.j || query.jurisdiccion || query.jurisdiction || "es";
				if (!JURISDICTION_RE.test(jurisdiction)) {
					set.status = 400;
					return { error: "invalid jurisdiction format" };
				}

				// Resolve materias: prefer answer params (compact), fall back to raw materias (legacy)
				let materias: string[];

				if (query.w) {
					// New: server-side materia resolution from wizard answers
					materias = computeMaterias({
						workStatus: query.w,
						sector: query.s || null,
						housing: query.h || "familiares",
						family: query.f ? query.f.split(",").filter(Boolean) : [],
						extras: query.x ? query.x.split(",").filter(Boolean) : [],
					});
				} else if (query.materias && query.materias.trim() !== "") {
					// Legacy: raw materias CSV (backward compat)
					materias = query.materias
						.split(",")
						.map((m) => decodeURIComponent(m.trim()))
						.filter((m) => m.length > 0);
				} else {
					set.status = 400;
					return { error: "w (work status) or materias parameter is required" };
				}

				if (materias.length === 0) {
					set.status = 400;
					return { error: "no materias resolved from the provided answers" };
				}

				const reforms = dbService.getRecentReformsByMaterias(
					materias,
					jurisdiction,
					"1900-01-01",
					limit,
					offset,
				);

				// Batch query: find which omnibus topics match the user's materias
				const omnibusNormIds = reforms
					.filter((r) => r.omnibus_topic_count > 0)
					.map((r) => r.id);
				const matchedTopicsMap = dbService.getMatchedTopics(
					omnibusNormIds,
					materias,
				);

				// Enrich reforms with matched_topics
				const enrichedReforms = reforms.map((r) => ({
					...r,
					matched_topics: matchedTopicsMap.get(r.id) || [],
				}));

				return {
					reforms: enrichedReforms,
					materias,
					limit,
					offset,
				};
			},
			{
				query: t.Object({
					// New: wizard answer params (compact, server resolves materias)
					w: t.Optional(t.String()), // workStatus
					s: t.Optional(t.String()), // sector
					h: t.Optional(t.String()), // housing
					j: t.Optional(t.String()), // jurisdiction (short)
					f: t.Optional(t.String()), // family (comma-separated)
					x: t.Optional(t.String()), // extras (comma-separated)
					// Legacy: raw materias CSV (backward compat)
					materias: t.Optional(t.String()),
					jurisdiccion: t.Optional(t.String()),
					jurisdiction: t.Optional(
						t.String({ description: "Alias of jurisdiccion" }),
					),
					limit: t.Optional(t.String()),
					offset: t.Optional(t.String()),
				}),
				detail: {
					summary: "Personal reforms feed",
					description:
						"Returns recent reforms filtered by the user's materias and jurisdiction. Accepts wizard answer params or raw materias CSV.",
					tags: ["Reformas"],
				},
			},
		)
		.get(
			"/changelog",
			({ query, set }) => {
				// `since` was advertised by old docs but never implemented. Reject
				// it loudly instead of silently applying a different window.
				if (query.since?.trim()) {
					set.status = 400;
					return {
						error: `since is not supported; use weeks (1-${MAX_CHANGELOG_WEEKS}) and offset`,
					};
				}
				const weeks = parseIntParam(query.weeks, DEFAULT_CHANGELOG_WEEKS);
				const limit = parseIntParam(query.limit, DEFAULT_CHANGELOG_LIMIT);
				const offset = parseIntParam(query.offset, 0);
				if (weeks === null || weeks < 1) {
					set.status = 400;
					return { error: "weeks must be a positive integer" };
				}
				if (limit === null || limit < 1) {
					set.status = 400;
					return { error: "limit must be a positive integer" };
				}
				if (offset === null || offset < 0 || offset > MAX_CHANGELOG_OFFSET) {
					set.status = 400;
					return {
						error: `offset must be an integer between 0 and ${MAX_CHANGELOG_OFFSET}`,
					};
				}

				// `jurisdiction` is accepted as an alias because the public docs
				// advertised it for a long time; `jurisdiccion` wins if both are set.
				const jurisdiction =
					query.jurisdiccion || query.jurisdiction || undefined;
				if (jurisdiction && !JURISDICTION_RE.test(jurisdiction)) {
					set.status = 400;
					return { error: "invalid jurisdiction format" };
				}

				// Clamp instead of rejecting (backwards compatible), but report
				// the window actually applied so callers are never misled.
				const effectiveWeeks = Math.min(weeks, MAX_CHANGELOG_WEEKS);
				const effectiveLimit = Math.min(limit, MAX_CHANGELOG_LIMIT);

				const since = new Date();
				since.setDate(since.getDate() - effectiveWeeks * 7);
				const sinceStr = since.toISOString().slice(0, 10);

				// Fetch one extra row to know whether another page exists
				// without a separate COUNT query.
				const rows = dbService.getChangelog(
					sinceStr,
					jurisdiction,
					effectiveLimit + 1,
					offset,
				);
				const hasMore = rows.length > effectiveLimit;
				const reforms = hasMore ? rows.slice(0, effectiveLimit) : rows;

				const today = new Date().toISOString().slice(0, 10);

				return {
					reforms,
					date_range: `${sinceStr} to ${today}`,
					weeks: effectiveWeeks,
					weeks_requested: weeks,
					weeks_clamped: weeks > effectiveWeeks,
					limit: effectiveLimit,
					offset,
					has_more: hasMore,
				};
			},
			{
				query: t.Object({
					weeks: t.Optional(
						t.String({
							description: `Time window in weeks (default ${DEFAULT_CHANGELOG_WEEKS}, max ${MAX_CHANGELOG_WEEKS}; larger values are clamped and reported via weeks_clamped)`,
						}),
					),
					jurisdiccion: t.Optional(
						t.String({ description: "Jurisdiction code, e.g. es or es-ct" }),
					),
					jurisdiction: t.Optional(
						t.String({ description: "Alias of jurisdiccion" }),
					),
					limit: t.Optional(
						t.String({
							description: `Page size (default ${DEFAULT_CHANGELOG_LIMIT}, max ${MAX_CHANGELOG_LIMIT})`,
						}),
					),
					offset: t.Optional(
						t.String({
							description: `Rows to skip for pagination (default 0, max ${MAX_CHANGELOG_OFFSET}). Use has_more to know if another page exists.`,
						}),
					),
					since: t.Optional(
						t.String({
							description:
								"Not supported: returns 400. Use weeks to set the time window.",
						}),
					),
				}),
				detail: {
					summary: "Public changelog",
					description:
						"Returns recent reforms with AI summaries, newest first. Filterable by jurisdiction and time window (weeks), paginated with limit/offset. The response echoes the parameters actually applied (weeks, weeks_requested, weeks_clamped, limit, offset) and has_more.",
					tags: ["Reformas"],
				},
			},
		)
		.get(
			"/reforms/:normId/:date",
			({ params, set }) => {
				const detail = dbService.getReformDetail(params.normId, params.date);
				if (!detail) {
					set.status = 404;
					return { error: "Reform not found" };
				}

				const sourceId = detail.reform.source_id;
				return {
					law: {
						id: detail.law.id,
						title: detail.law.title,
						short_title: detail.law.short_title,
						rank: detail.law.rank,
						status: detail.law.status,
						source_url: detail.law.source_url,
						last_reform_date:
							detail.next_reform_date === null ? detail.reform.date : null,
					},
					reform: detail.reform,
					affected_blocks: detail.affected_blocks,
					prev_reform_date: detail.prev_reform_date,
					next_reform_date: detail.next_reform_date,
					source_url: `https://www.boe.es/diario_boe/txt.php?id=${sourceId}`,
				};
			},
			{
				params: t.Object({
					normId: t.String(),
					date: t.String(),
				}),
				detail: {
					summary: "Reform detail",
					description:
						"Returns full detail for a specific reform of a law, including affected blocks and navigation to adjacent reforms.",
					tags: ["Reformas"],
				},
			},
		);
}
