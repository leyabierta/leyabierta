/**
 * Reform endpoints: personal reforms by materia + public changelog.
 */
import { Elysia, t } from "elysia";
import type { DbService } from "../services/db.ts";

export function reformRoutes(dbService: DbService) {
	return new Elysia({ prefix: "/v1" })
		.get(
			"/reforms/personal",
			({ query, set }) => {
				const materiasCsv = query.materias;
				if (!materiasCsv || materiasCsv.trim() === "") {
					set.status = 400;
					return { error: "materias query parameter is required" };
				}

				const weeks = query.weeks ? Math.min(Number(query.weeks), 12) : 4;
				if (weeks <= 0 || Number.isNaN(weeks)) {
					set.status = 400;
					return { error: "weeks must be between 1 and 12" };
				}

				const jurisdiction = query.jurisdiccion || "es";

				const materias = materiasCsv
					.split(",")
					.map((m) => decodeURIComponent(m.trim()))
					.filter((m) => m.length > 0);

				if (materias.length === 0) {
					set.status = 400;
					return { error: "materias query parameter is required" };
				}

				// Compute since date
				const since = new Date();
				since.setDate(since.getDate() - weeks * 7);
				const sinceStr = since.toISOString().slice(0, 10);

				const reforms = dbService.getRecentReformsByMaterias(
					materias,
					jurisdiction,
					sinceStr,
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

				// Compute date range
				const today = new Date().toISOString().slice(0, 10);
				const dateRange = `${sinceStr} to ${today}`;

				return {
					reforms: enrichedReforms,
					materias,
					date_range: dateRange,
				};
			},
			{
				query: t.Object({
					materias: t.Optional(t.String()),
					jurisdiccion: t.Optional(t.String()),
					weeks: t.Optional(t.String()),
				}),
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
						rank: detail.law.rank,
						status: detail.law.status,
						source_url: detail.law.source_url,
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
			},
		);
}
