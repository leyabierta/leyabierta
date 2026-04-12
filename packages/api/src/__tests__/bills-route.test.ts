/**
 * Integration tests for the /v1/bills routes.
 *
 * Uses an in-memory SQLite DB with the full schema,
 * seeds test data, and tests endpoints via Elysia's handle().
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import { Elysia } from "elysia";
import { billRoutes } from "../routes/bills.ts";

let db: Database;
// biome-ignore lint: test file uses loose typing for Elysia app
let app: any;

beforeEach(() => {
	db = new Database(":memory:");
	createSchema(db);
	app = new Elysia().use(billRoutes(db));
});

afterEach(() => {
	db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertBill(overrides: Partial<Record<string, string | number>> = {}) {
	const defaults = {
		bocg_id: "BOCG-15-A-1-1",
		title: "Proyecto de Ley de vivienda",
		legislature: 15,
		series: "A",
		publication_date: "2026-01-15",
		pdf_url: "https://bocg.example/pdf/1.pdf",
		bill_type: "amendment",
		alert_level: "high",
		total_modifications: 5,
		laws_modified: 2,
		critical_alerts: 1,
		high_alerts: 3,
		has_penalty_changes: 0,
		has_type_eliminations: 0,
		transitional_check_json: "{}",
		analyzed_at: "2026-01-16T10:00:00Z",
		model: "gemini-2.5-flash",
		warnings_json: "[]",
	};
	const d = { ...defaults, ...overrides };
	db.run(
		`INSERT INTO bills (bocg_id, title, legislature, series, publication_date,
       pdf_url, bill_type, alert_level, total_modifications, laws_modified,
       critical_alerts, high_alerts, has_penalty_changes, has_type_eliminations,
       transitional_check_json, analyzed_at, model, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			d.bocg_id,
			d.title,
			d.legislature,
			d.series,
			d.publication_date,
			d.pdf_url,
			d.bill_type,
			d.alert_level,
			d.total_modifications,
			d.laws_modified,
			d.critical_alerts,
			d.high_alerts,
			d.has_penalty_changes,
			d.has_type_eliminations,
			d.transitional_check_json,
			d.analyzed_at,
			d.model,
			d.warnings_json,
		],
	);
}

function insertModification(
	overrides: Partial<Record<string, string | number>> = {},
) {
	const defaults = {
		bocg_id: "BOCG-15-A-1-1",
		group_index: 0,
		group_title: "Ley de Arrendamientos Urbanos",
		target_law: "LAU",
		norm_id: "BOE-A-1994-26003",
		ordinal: "primero",
		change_type: "modify",
		target_provision: "art. 17",
		new_text: "Se modifica el articulo 17...",
		source_text: "Articulo primero.",
		penalty_risk: "none",
		penalty_json: "{}",
	};
	const d = { ...defaults, ...overrides };
	db.run(
		`INSERT INTO bill_modifications (bocg_id, group_index, group_title, target_law,
       norm_id, ordinal, change_type, target_provision, new_text, source_text,
       penalty_risk, penalty_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			d.bocg_id,
			d.group_index,
			d.group_title,
			d.target_law,
			d.norm_id,
			d.ordinal,
			d.change_type,
			d.target_provision,
			d.new_text,
			d.source_text,
			d.penalty_risk,
			d.penalty_json,
		],
	);
}

function insertImpact(
	overrides: Partial<Record<string, string | number>> = {},
) {
	const defaults = {
		bocg_id: "BOCG-15-A-1-1",
		norm_id: "BOE-A-1994-26003",
		target_law: "LAU",
		impact_json: '{"severity":"high","summary":"Major rental changes"}',
		blast_radius_json: '["BOE-A-2013-10074"]',
		generated_at: "2026-01-16T10:00:00Z",
		model: "gemini-2.5-flash",
	};
	const d = { ...defaults, ...overrides };
	db.run(
		`INSERT INTO bill_impacts (bocg_id, norm_id, target_law, impact_json,
       blast_radius_json, generated_at, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			d.bocg_id,
			d.norm_id,
			d.target_law,
			d.impact_json,
			d.blast_radius_json,
			d.generated_at,
			d.model,
		],
	);
}

function insertDerogation(
	overrides: Partial<Record<string, string | number>> = {},
) {
	const defaults = {
		bocg_id: "BOCG-15-A-1-1",
		target_law: "Ley 29/1994",
		norm_id: "BOE-A-1994-26003",
		scope: "partial",
		target_provisions: '["art. 9","art. 10"]',
		source_text: "Disposicion derogatoria unica.",
	};
	const d = { ...defaults, ...overrides };
	db.run(
		`INSERT INTO bill_derogations (bocg_id, target_law, norm_id, scope,
       target_provisions, source_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
		[
			d.bocg_id,
			d.target_law,
			d.norm_id,
			d.scope,
			d.target_provisions,
			d.source_text,
		],
	);
}

function insertEntity(
	overrides: Partial<Record<string, string | number>> = {},
) {
	const defaults = {
		bocg_id: "BOCG-15-A-1-1",
		name: "Registro Nacional de Vivienda",
		entity_type: "registry",
		article: "art. 12",
		description: "Registro publico de viviendas.",
	};
	const d = { ...defaults, ...overrides };
	db.run(
		`INSERT INTO bill_entities (bocg_id, name, entity_type, article, description)
     VALUES (?, ?, ?, ?, ?)`,
		[d.bocg_id, d.name, d.entity_type, d.article, d.description],
	);
}

async function req(path: string): Promise<Response> {
	return app.handle(new Request(`http://localhost${path}`));
}

async function json(path: string) {
	const res = await req(path);
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

// ---------------------------------------------------------------------------
// GET /v1/bills (list endpoint)
// ---------------------------------------------------------------------------

describe("GET /v1/bills", () => {
	it("returns empty list when no bills exist", async () => {
		const { status, body } = await json("/v1/bills");
		expect(status).toBe(200);
		expect(body.data).toEqual([]);
		expect(body.total).toBe(0);
	});

	it("returns paginated list with correct structure", async () => {
		insertBill();
		insertBill({ bocg_id: "BOCG-15-A-2-1", title: "Otra ley" });

		const { status, body } = await json("/v1/bills");
		expect(status).toBe(200);
		expect(body.total).toBe(2);
		const data = body.data as Array<Record<string, unknown>>;
		expect(data).toHaveLength(2);
		expect(body.limit).toBe(20);
		expect(body.offset).toBe(0);

		// Verify each item has expected fields
		const item = data[0]!;
		expect(item.bocg_id).toBeDefined();
		expect(item.title).toBeDefined();
		expect(item.legislature).toBeDefined();
		expect(item.alert_level).toBeDefined();
		expect(item.total_modifications).toBeDefined();
		expect(item.has_penalty_changes).toBeDefined();
	});

	it("filters by legislature parameter", async () => {
		insertBill({ bocg_id: "B1", legislature: 15 });
		insertBill({ bocg_id: "B2", legislature: 14 });

		const { body } = await json("/v1/bills?legislature=15");
		expect(body.total).toBe(1);
		const data = body.data as Array<Record<string, unknown>>;
		expect(data[0]!.bocg_id).toBe("B1");
	});

	it("filters by alert_level parameter", async () => {
		insertBill({ bocg_id: "B1", alert_level: "critical" });
		insertBill({ bocg_id: "B2", alert_level: "ok" });
		insertBill({ bocg_id: "B3", alert_level: "critical" });

		const { body } = await json("/v1/bills?alert_level=critical");
		expect(body.total).toBe(2);
	});

	it("filters by series parameter", async () => {
		insertBill({ bocg_id: "B1", series: "A" });
		insertBill({ bocg_id: "B2", series: "B" });

		const { body } = await json("/v1/bills?series=B");
		expect(body.total).toBe(1);
		const data = body.data as Array<Record<string, unknown>>;
		expect(data[0]!.bocg_id).toBe("B2");
	});

	it("respects limit and offset", async () => {
		for (let i = 1; i <= 5; i++) {
			insertBill({
				bocg_id: `B${i}`,
				publication_date: `2026-0${i}-01`,
			});
		}

		const page1 = (await json("/v1/bills?limit=2&offset=0")).body;
		const data1 = page1.data as Array<Record<string, unknown>>;
		expect(data1).toHaveLength(2);
		expect(page1.total).toBe(5);
		expect(page1.limit).toBe(2);
		expect(page1.offset).toBe(0);

		const page2 = (await json("/v1/bills?limit=2&offset=2")).body;
		const data2 = page2.data as Array<Record<string, unknown>>;
		expect(data2).toHaveLength(2);
		expect(data1[0]!.bocg_id).not.toBe(data2[0]!.bocg_id);
	});

	it("caps limit at 100", async () => {
		const { body } = await json("/v1/bills?limit=500");
		expect(body.limit).toBe(100);
	});

	it("returns empty array when no bills match filter", async () => {
		insertBill({ bocg_id: "B1", legislature: 15 });

		const { body } = await json("/v1/bills?legislature=99");
		expect(body.total).toBe(0);
		expect(body.data).toEqual([]);
	});

	it("converts has_penalty_changes and has_type_eliminations to booleans", async () => {
		insertBill({
			bocg_id: "B1",
			has_penalty_changes: 1,
			has_type_eliminations: 0,
		});

		const { body } = await json("/v1/bills");
		const data = body.data as Array<Record<string, unknown>>;
		expect(data[0]!.has_penalty_changes).toBe(true);
		expect(data[0]!.has_type_eliminations).toBe(false);
	});

	it("defaults bill_type to amendment when using schema default", async () => {
		// The schema defaults bill_type to 'amendment'. The route also has
		// a ?? fallback for older DBs where the column might be null.
		// Insert without specifying bill_type to let the schema default apply.
		db.run(
			`INSERT INTO bills (bocg_id, title, legislature, series, publication_date,
         pdf_url, alert_level, total_modifications, laws_modified,
         critical_alerts, high_alerts, has_penalty_changes, has_type_eliminations,
         transitional_check_json, analyzed_at, model, warnings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"BDEFAULT",
				"Test",
				15,
				"A",
				"2026-01-01",
				"",
				"ok",
				0,
				0,
				0,
				0,
				0,
				0,
				"{}",
				"",
				"",
				"[]",
			],
		);

		const { body } = await json("/v1/bills");
		const data = body.data as Array<Record<string, unknown>>;
		const bill = data.find((b) => b.bocg_id === "BDEFAULT");
		expect(bill!.bill_type).toBe("amendment");
	});
});

// ---------------------------------------------------------------------------
// GET /v1/bills/:bocgId (detail endpoint)
// ---------------------------------------------------------------------------

describe("GET /v1/bills/:bocgId", () => {
	it("returns 400 for malformed bocgId", async () => {
		const { status, body } = await json("/v1/bills/NONEXISTENT");
		expect(status).toBe(400);
		expect(body.error).toBe("Invalid BOCG ID format");
	});

	it("returns 404 for unknown bocgId", async () => {
		const { status, body } = await json("/v1/bills/BOCG-99-Z-999-999");
		expect(status).toBe(404);
		expect(body.error).toBe("Bill not found");
	});

	it("returns full bill detail with all related data", async () => {
		insertBill();
		insertModification();
		insertModification({
			group_index: 0,
			ordinal: "segundo",
			change_type: "add",
			target_provision: "art. 17 bis",
		});
		insertModification({
			group_index: 1,
			group_title: "Codigo Civil",
			target_law: "CC",
			norm_id: "BOE-A-1889-4763",
			ordinal: "unico",
			change_type: "modify",
			target_provision: "art. 1964",
		});
		insertImpact();
		insertDerogation();
		insertEntity();

		const { status, body } = await json("/v1/bills/BOCG-15-A-1-1");
		expect(status).toBe(200);

		// Top-level fields
		expect(body.bocg_id).toBe("BOCG-15-A-1-1");
		expect(body.title).toBe("Proyecto de Ley de vivienda");
		expect(body.legislature).toBe(15);
		expect(body.series).toBe("A");
		expect(body.bill_type).toBe("amendment");
		expect(body.alert_level).toBe("high");

		// Summary
		const summary = body.summary as Record<string, unknown>;
		expect(summary.total_modifications).toBe(5);
		expect(summary.laws_modified).toBe(2);
		expect(summary.critical_alerts).toBe(1);
		expect(summary.has_penalty_changes).toBe(false);

		// Modification groups
		const groups = body.modification_groups as Array<Record<string, unknown>>;
		expect(groups).toHaveLength(2);
		expect(groups[0]!.title).toBe("Ley de Arrendamientos Urbanos");
		const mods = groups[0]!.modifications as Array<Record<string, unknown>>;
		expect(mods).toHaveLength(2);
		expect(mods[0]!.ordinal).toBe("primero");
		expect(mods[1]!.ordinal).toBe("segundo");

		expect(groups[1]!.title).toBe("Codigo Civil");
		const mods2 = groups[1]!.modifications as Array<Record<string, unknown>>;
		expect(mods2).toHaveLength(1);

		// Impacts
		const impacts = body.impacts as Array<Record<string, unknown>>;
		expect(impacts).toHaveLength(1);
		expect(impacts[0]!.norm_id).toBe("BOE-A-1994-26003");
		const analysis = impacts[0]!.analysis as Record<string, unknown>;
		expect(analysis.severity).toBe("high");
		const blastRadius = impacts[0]!.blast_radius as string[];
		expect(blastRadius).toContain("BOE-A-2013-10074");

		// Derogations
		const derogations = body.derogations as Array<Record<string, unknown>>;
		expect(derogations).toHaveLength(1);
		expect(derogations[0]!.scope).toBe("partial");
		const provisions = derogations[0]!.target_provisions as string[];
		expect(provisions).toContain("art. 9");

		// New entities
		const entities = body.new_entities as Array<Record<string, unknown>>;
		expect(entities).toHaveLength(1);
		expect(entities[0]!.name).toBe("Registro Nacional de Vivienda");
		expect(entities[0]!.entity_type).toBe("registry");
	});

	it("returns warnings field (even if empty array)", async () => {
		insertBill({ warnings_json: "[]" });

		const { body } = await json("/v1/bills/BOCG-15-A-1-1");
		expect(body.warnings).toEqual([]);
	});

	it("returns warnings when populated", async () => {
		insertBill({
			warnings_json: '["Missing article references","Ambiguous scope"]',
		});

		const { body } = await json("/v1/bills/BOCG-15-A-1-1");
		const warnings = body.warnings as string[];
		expect(warnings).toHaveLength(2);
		expect(warnings).toContain("Missing article references");
	});

	it("defaults bill_type to amendment in detail when using schema default", async () => {
		db.run(
			`INSERT INTO bills (bocg_id, title, legislature, series, publication_date,
         pdf_url, alert_level, total_modifications, laws_modified,
         critical_alerts, high_alerts, has_penalty_changes, has_type_eliminations,
         transitional_check_json, analyzed_at, model, warnings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"BOCG-15-A-99-1",
				"Test",
				15,
				"A",
				"2026-01-01",
				"",
				"ok",
				0,
				0,
				0,
				0,
				0,
				0,
				"{}",
				"",
				"",
				"[]",
			],
		);

		const { body } = await json("/v1/bills/BOCG-15-A-99-1");
		expect(body.bill_type).toBe("amendment");
	});

	it("safeJsonParse handles malformed JSON gracefully", async () => {
		insertBill({ transitional_check_json: "NOT VALID JSON" });

		const { status, body } = await json("/v1/bills/BOCG-15-A-1-1");
		expect(status).toBe(200);
		// safeJsonParse returns {} for invalid JSON
		expect(body.transitional_check).toEqual({});
	});

	it("returns empty arrays when bill has no related data", async () => {
		insertBill();

		const { status, body } = await json("/v1/bills/BOCG-15-A-1-1");
		expect(status).toBe(200);
		expect(body.modification_groups).toEqual([]);
		expect(body.impacts).toEqual([]);
		expect(body.derogations).toEqual([]);
		expect(body.new_entities).toEqual([]);
	});

	it("includes penalty_detail when penalty_risk is not none", async () => {
		insertBill();
		insertModification({
			penalty_risk: "high",
			penalty_json:
				'{"before":"2 years","after":"5 years","change":"increased"}',
		});

		const { body } = await json("/v1/bills/BOCG-15-A-1-1");
		const groups = body.modification_groups as Array<Record<string, unknown>>;
		const mods = groups[0]!.modifications as Array<Record<string, unknown>>;
		const detail = mods[0]!.penalty_detail as Record<string, unknown>;
		expect(detail.before).toBe("2 years");
		expect(detail.after).toBe("5 years");
	});

	it("omits penalty_detail when penalty_risk is none", async () => {
		insertBill();
		insertModification({ penalty_risk: "none" });

		const { body } = await json("/v1/bills/BOCG-15-A-1-1");
		const groups = body.modification_groups as Array<Record<string, unknown>>;
		const mods = groups[0]!.modifications as Array<Record<string, unknown>>;
		expect(mods[0]!.penalty_detail).toBeUndefined();
	});
});
