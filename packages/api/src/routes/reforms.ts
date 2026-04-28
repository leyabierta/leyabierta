/**
 * Reform endpoints: personal reforms by materia + public changelog.
 */
import { Elysia, t } from "elysia";
import { computeMaterias } from "../data/materia-mappings.ts";
import type { DbService } from "../services/db.ts";

const JURISDICTION_RE = /^es(-[a-z]{2})?$/;

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

				const jurisdiction = query.j || query.jurisdiccion || "es";
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
			({ query }) => {
				const weeks = query.weeks ? Math.min(Number(query.weeks), 12) : 4;
				const jurisdiction = query.jurisdiccion || undefined;
				const limit = query.limit ? Math.min(Number(query.limit), 100) : 50;

				const since = new Date();
				since.setDate(since.getDate() - weeks * 7);
				const sinceStr = since.toISOString().slice(0, 10);

				const reforms = dbService.getChangelog(sinceStr, jurisdiction, limit);

				const today = new Date().toISOString().slice(0, 10);

				return {
					reforms,
					date_range: `${sinceStr} to ${today}`,
				};
			},
			{
				query: t.Object({
					weeks: t.Optional(t.String()),
					jurisdiccion: t.Optional(t.String()),
					limit: t.Optional(t.String()),
				}),
				detail: {
					summary: "Public changelog",
					description:
						"Returns recent reforms with AI summaries. Filterable by jurisdiction and time window (weeks).",
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
						last_reform_date: detail.next_reform_date === null ? detail.reform.date : null,
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
