/**
 * Bill Impact Preview endpoints — "Radar Legislativo".
 *
 * Serves parsed BOCG bill data with modification analysis,
 * LLM impact reports, and blast radius.
 */

import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";

// ── Types ──

interface BillRow {
	bocg_id: string;
	title: string;
	legislature: number;
	series: string;
	publication_date: string;
	pdf_url: string;
	bill_type: string;
	alert_level: string;
	total_modifications: number;
	laws_modified: number;
	critical_alerts: number;
	high_alerts: number;
	has_penalty_changes: number;
	has_type_eliminations: number;
	transitional_check_json: string;
	analyzed_at: string;
	model: string;
}

interface ModRow {
	id: number;
	bocg_id: string;
	group_index: number;
	group_title: string;
	target_law: string;
	norm_id: string;
	ordinal: string;
	change_type: string;
	target_provision: string;
	new_text: string;
	source_text: string;
	penalty_risk: string;
	penalty_json: string;
}

interface ImpactRow {
	id: number;
	bocg_id: string;
	norm_id: string;
	target_law: string;
	impact_json: string;
	blast_radius_json: string;
	generated_at: string;
	model: string;
}

interface DerogationRow {
	id: number;
	bocg_id: string;
	target_law: string;
	norm_id: string;
	scope: string;
	target_provisions: string;
	source_text: string;
}

interface EntityRow {
	id: number;
	bocg_id: string;
	name: string;
	entity_type: string;
	article: string;
	description: string;
}

// ── Route factory ──

export function billRoutes(db: Database) {
	return new Elysia({ prefix: "/v1" })
		// 1. GET /v1/bills — list with filters
		.get(
			"/bills",
			({ query }) => {
				const limit = Math.min(query.limit ?? 20, 100);
				const offset = query.offset ?? 0;

				const conditions: string[] = [];
				const params: (string | number)[] = [];

				if (query.legislature) {
					conditions.push("legislature = ?");
					params.push(Number(query.legislature));
				}
				if (query.alert_level) {
					conditions.push("alert_level = ?");
					params.push(query.alert_level);
				}
				if (query.series) {
					conditions.push("series = ?");
					params.push(query.series);
				}

				const where =
					conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

				const countStmt = db.prepare<{ count: number }, (string | number)[]>(
					`SELECT COUNT(*) as count FROM bills ${where}`,
				);
				const total = countStmt.get(...params)?.count ?? 0;

				const listStmt = db.prepare<BillRow, (string | number)[]>(
					`SELECT * FROM bills ${where}
					 ORDER BY publication_date DESC
					 LIMIT ? OFFSET ?`,
				);
				const rows = listStmt.all(...params, limit, offset);

				return {
					data: rows.map((r) => ({
						bocg_id: r.bocg_id,
						title: r.title,
						legislature: r.legislature,
						series: r.series,
						publication_date: r.publication_date,
						pdf_url: r.pdf_url,
						bill_type: r.bill_type ?? "amendment",
						alert_level: r.alert_level,
						total_modifications: r.total_modifications,
						laws_modified: r.laws_modified,
						critical_alerts: r.critical_alerts,
						high_alerts: r.high_alerts,
						has_penalty_changes: !!r.has_penalty_changes,
						has_type_eliminations: !!r.has_type_eliminations,
						analyzed_at: r.analyzed_at,
					})),
					total,
					limit,
					offset,
				};
			},
			{
				query: t.Object({
					legislature: t.Optional(t.Numeric()),
					alert_level: t.Optional(t.String()),
					series: t.Optional(t.String()),
					limit: t.Optional(t.Numeric()),
					offset: t.Optional(t.Numeric()),
				}),
				detail: {
					summary: "List analyzed bills",
					description:
						"Returns a paginated list of analyzed BOCG bills with alert levels and modification counts. Filterable by legislature, alert level, and series.",
					tags: ["Propuestas"],
				},
			},
		)

		// 2. GET /v1/bills/:bocgId — full detail
		.get(
			"/bills/:bocgId",
			({ params, set }) => {
				const bill = db
					.query<BillRow, string>("SELECT * FROM bills WHERE bocg_id = ?")
					.get(params.bocgId);

				if (!bill) {
					set.status = 404;
					return { error: "Bill not found" };
				}

				// Fetch modifications grouped
				const mods = db
					.query<ModRow, string>(
						`SELECT * FROM bill_modifications
						 WHERE bocg_id = ?
						 ORDER BY group_index, id`,
					)
					.all(params.bocgId);

				// Group modifications by group_index
				const groups = new Map<
					number,
					{
						title: string;
						target_law: string;
						norm_id: string;
						modifications: Array<{
							ordinal: string;
							change_type: string;
							target_provision: string;
							new_text: string;
							penalty_risk: string;
							penalty_detail: unknown;
						}>;
					}
				>();

				for (const mod of mods) {
					if (!groups.has(mod.group_index)) {
						groups.set(mod.group_index, {
							title: mod.group_title,
							target_law: mod.target_law,
							norm_id: mod.norm_id,
							modifications: [],
						});
					}
					groups.get(mod.group_index)!.modifications.push({
						ordinal: mod.ordinal,
						change_type: mod.change_type,
						target_provision: mod.target_provision,
						new_text: mod.new_text,
						penalty_risk: mod.penalty_risk,
						penalty_detail:
							mod.penalty_risk !== "none"
								? safeJsonParse(mod.penalty_json)
								: undefined,
					});
				}

				// Fetch impacts
				const impacts = db
					.query<ImpactRow, string>(
						"SELECT * FROM bill_impacts WHERE bocg_id = ?",
					)
					.all(params.bocgId);

				// Fetch derogations
				const derogations = db
					.query<DerogationRow, string>(
						"SELECT * FROM bill_derogations WHERE bocg_id = ?",
					)
					.all(params.bocgId);

				// Fetch new entities
				const entities = db
					.query<EntityRow, string>(
						"SELECT * FROM bill_entities WHERE bocg_id = ?",
					)
					.all(params.bocgId);

				return {
					bocg_id: bill.bocg_id,
					title: bill.title,
					legislature: bill.legislature,
					series: bill.series,
					publication_date: bill.publication_date,
					pdf_url: bill.pdf_url,
					bill_type: bill.bill_type ?? "amendment",
					alert_level: bill.alert_level,
					summary: {
						total_modifications: bill.total_modifications,
						laws_modified: bill.laws_modified,
						critical_alerts: bill.critical_alerts,
						high_alerts: bill.high_alerts,
						has_penalty_changes: !!bill.has_penalty_changes,
						has_type_eliminations: !!bill.has_type_eliminations,
					},
					transitional_check: safeJsonParse(bill.transitional_check_json),
					modification_groups: [...groups.values()],
					impacts: impacts.map((imp) => ({
						norm_id: imp.norm_id,
						target_law: imp.target_law,
						analysis: safeJsonParse(imp.impact_json),
						blast_radius: safeJsonParse(imp.blast_radius_json),
						generated_at: imp.generated_at,
						model: imp.model,
					})),
					derogations: derogations.map((d) => ({
						target_law: d.target_law,
						norm_id: d.norm_id,
						scope: d.scope,
						target_provisions: safeJsonParse(d.target_provisions),
						source_text: d.source_text,
					})),
					new_entities: entities.map((e) => ({
						name: e.name,
						entity_type: e.entity_type,
						article: e.article,
						description: e.description,
					})),
					analyzed_at: bill.analyzed_at,
					model: bill.model,
				};
			},
			{
				params: t.Object({ bocgId: t.String() }),
				detail: {
					summary: "Get bill impact detail",
					description:
						"Returns full bill analysis including modification groups, penalty comparisons, LLM impact analysis, blast radius, and transitional provision checks. All data needed for frontend rendering.",
					tags: ["Propuestas"],
				},
			},
		);
}

function safeJsonParse(str: string): unknown {
	try {
		return JSON.parse(str);
	} catch {
		return {};
	}
}
