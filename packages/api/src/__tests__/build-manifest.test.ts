/**
 * Tests for getBuildManifest() and GET /v1/build-manifest endpoint.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import { DbService } from "../services/db.ts";

let db: Database;
let svc: DbService;

beforeEach(() => {
	db = new Database(":memory:");
	createSchema(db);
	svc = new DbService(db);
});

afterEach(() => {
	db.close();
});

function insertNorm(id: string, citizenSummary = "", title = "Test Law") {
	db.run(
		`INSERT INTO norms (id, title, short_title, country, rank, published_at, updated_at, status, department, source_url, citizen_summary)
     VALUES (?, ?, ?, 'es', 'ley', '2024-01-01', NULL, 'vigente', 'Test', 'https://boe.es', ?)`,
		[id, title, id, citizenSummary],
	);
}

function insertCitizenTag(normId: string, tag: string, blockId = "") {
	db.run("INSERT INTO citizen_tags (norm_id, block_id, tag) VALUES (?, ?, ?)", [
		normId,
		blockId,
		tag,
	]);
}

function insertMateria(normId: string, materia: string) {
	db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
		normId,
		materia,
	]);
}

function insertBlock(
	normId: string,
	blockId: string,
	title: string,
	position: number,
	currentText = "texto del articulo",
) {
	db.run(
		`INSERT INTO blocks (norm_id, block_id, block_type, title, position, current_text)
     VALUES (?, ?, 'articulo', ?, ?, ?)`,
		[normId, blockId, title, position, currentText],
	);
}

function insertArticleSummary(
	normId: string,
	blockId: string,
	summary: string,
) {
	db.run(
		"INSERT INTO citizen_article_summaries (norm_id, block_id, summary) VALUES (?, ?, ?)",
		[normId, blockId, summary],
	);
}

function insertOmnibusTopic(normId: string, index: number, label: string) {
	db.run(
		`INSERT INTO omnibus_topics (norm_id, topic_index, topic_label, headline, summary, article_count, is_sneaked, related_materias, block_ids, model)
     VALUES (?, ?, ?, 'Test headline', 'Test summary', 5, 0, '[]', '["art1","art2"]', 'test-model')`,
		[normId, index, label],
	);
}

describe("getBuildManifest()", () => {
	it("returns empty objects when DB has no citizen data", () => {
		const result = svc.getBuildManifest();
		expect(result.citizens).toEqual({});
		expect(result.omnibus).toEqual({});
		expect(result.reforms).toEqual({});
	});

	it("returns citizen summaries for norms that have them", () => {
		insertNorm("BOE-A-2024-001", "This law affects taxes");
		insertNorm("BOE-A-2024-002", ""); // no summary
		insertNorm("BOE-A-2024-003", "This law affects housing");

		const result = svc.getBuildManifest();
		expect(Object.keys(result.citizens)).toHaveLength(2);
		expect(result.citizens["BOE-A-2024-001"]!.summary).toBe(
			"This law affects taxes",
		);
		expect(result.citizens["BOE-A-2024-003"]!.summary).toBe(
			"This law affects housing",
		);
		expect(result.citizens["BOE-A-2024-002"]).toBeUndefined();
	});

	it("includes law-level citizen tags, excludes article-level tags", () => {
		insertNorm("BOE-A-2024-001", "Summary");
		insertCitizenTag("BOE-A-2024-001", "autonomo");
		insertCitizenTag("BOE-A-2024-001", "inquilino");
		insertCitizenTag("BOE-A-2024-001", "article-tag", "art-1"); // article-level

		const result = svc.getBuildManifest();
		expect(result.citizens["BOE-A-2024-001"]!.tags).toEqual([
			"autonomo",
			"inquilino",
		]);
	});

	it("creates citizen entry for tags-only norms (no summary)", () => {
		insertNorm("BOE-A-2024-001");
		insertCitizenTag("BOE-A-2024-001", "empresario");

		const result = svc.getBuildManifest();
		expect(result.citizens["BOE-A-2024-001"]).toEqual({
			summary: "",
			tags: ["empresario"],
			materias: [],
		});
	});

	it("includes DB materias per norm, creating an entry when needed", () => {
		insertNorm("BOE-A-2024-001", "Summary");
		insertMateria("BOE-A-2024-001", "Vivienda");
		insertMateria("BOE-A-2024-001", "Alquiler");
		// materias-only norm (no summary, no tags) still gets an entry
		insertNorm("BOE-A-2024-002", "");
		insertMateria("BOE-A-2024-002", "Empleo");

		const result = svc.getBuildManifest();
		expect(result.citizens["BOE-A-2024-001"]!.materias).toEqual([
			"Alquiler",
			"Vivienda",
		]);
		expect(result.citizens["BOE-A-2024-002"]).toEqual({
			summary: "",
			tags: [],
			materias: ["Empleo"],
		});
	});

	it("returns omnibus topics grouped by norm_id", () => {
		insertNorm("BOE-A-2024-001");
		insertNorm("BOE-A-2024-002");
		insertOmnibusTopic("BOE-A-2024-001", 0, "Fiscal reform");
		insertOmnibusTopic("BOE-A-2024-001", 1, "Labor changes");
		insertOmnibusTopic("BOE-A-2024-002", 0, "Housing policy");

		const result = svc.getBuildManifest();
		expect(Object.keys(result.omnibus)).toHaveLength(2);
		expect(result.omnibus["BOE-A-2024-001"]).toHaveLength(2);
		expect(result.omnibus["BOE-A-2024-001"]![0]!.topic_label).toBe(
			"Fiscal reform",
		);
		expect(result.omnibus["BOE-A-2024-001"]![1]!.topic_label).toBe(
			"Labor changes",
		);
		expect(result.omnibus["BOE-A-2024-002"]).toHaveLength(1);
	});

	it("omnibus topics include all expected fields", () => {
		insertNorm("BOE-A-2024-001");
		insertOmnibusTopic("BOE-A-2024-001", 0, "Topic A");

		const result = svc.getBuildManifest();
		const topic = result.omnibus["BOE-A-2024-001"]![0]!;
		expect(topic).toHaveProperty("topic_label");
		expect(topic).toHaveProperty("article_count");
		expect(topic).toHaveProperty("headline");
		expect(topic).toHaveProperty("summary");
		expect(topic).toHaveProperty("is_sneaked");
		expect(topic).toHaveProperty("block_ids");
	});
});

describe("getArticleSummariesManifest()", () => {
	it("returns empty object when there are no article summaries", () => {
		expect(svc.getArticleSummariesManifest()).toEqual({});
	});

	it("groups [heading, summary, blockId] triples per norm", () => {
		insertNorm("BOE-A-2024-001");
		insertBlock("BOE-A-2024-001", "art-1", "Artículo 1", 0);
		insertBlock("BOE-A-2024-001", "art-2", "Artículo 2", 1);
		insertNorm("BOE-A-2024-002");
		insertBlock("BOE-A-2024-002", "art-1", "Artículo 1", 0);
		insertArticleSummary("BOE-A-2024-001", "art-1", "resumen uno");
		insertArticleSummary("BOE-A-2024-001", "art-2", "resumen dos");
		insertArticleSummary("BOE-A-2024-002", "art-1", "otro resumen");

		const result = svc.getArticleSummariesManifest();
		expect(Object.keys(result)).toHaveLength(2);
		expect(result["BOE-A-2024-001"]).toEqual([
			["Artículo 1", "resumen uno", "art-1"],
			["Artículo 2", "resumen dos", "art-2"],
		]);
		expect(result["BOE-A-2024-002"]).toEqual([
			["Artículo 1", "otro resumen", "art-1"],
		]);
	});

	it("omits empty summaries and titleless blocks", () => {
		insertNorm("BOE-A-2024-001");
		insertBlock("BOE-A-2024-001", "art-1", "Artículo 1", 0);
		insertBlock("BOE-A-2024-001", "preamble", "", 1); // no title
		insertArticleSummary("BOE-A-2024-001", "art-1", "válido");
		insertArticleSummary("BOE-A-2024-001", "preamble", "sin título");

		const result = svc.getArticleSummariesManifest();
		expect(result["BOE-A-2024-001"]).toEqual([
			["Artículo 1", "válido", "art-1"],
		]);
	});

	it("keys pairs by the heading printed in the text, not the BOE title", () => {
		// Código Civil: titles are "Art 1" but the text says "Artículo 1."; the
		// title-keyed manifest rendered 16 of its 1,322 summaries.
		insertNorm("BOE-A-1889-4763");
		insertBlock(
			"BOE-A-1889-4763",
			"a1",
			"Art 1",
			0,
			"Artículo 1.\n\n1. Las fuentes...",
		);
		insertArticleSummary("BOE-A-1889-4763", "a1", "Fuentes del derecho");

		expect(svc.getArticleSummariesManifest()["BOE-A-1889-4763"]).toEqual([
			["Artículo 1.", "Fuentes del derecho", "a1"],
		]);
	});

	it("orders pairs by position and adds placeholders for repeated headings", () => {
		insertNorm("BOE-A-2024-001");
		insertBlock(
			"BOE-A-2024-001",
			"dt1",
			"Primera",
			2,
			"Primera.\n\ntransitoria",
		);
		insertBlock(
			"BOE-A-2024-001",
			"a1",
			"Artículo 1",
			0,
			"Artículo 1.\n\ntexto",
		);
		insertBlock(
			"BOE-A-2024-001",
			"a2",
			"Artículo 2",
			1,
			"Artículo 2.\n\ntexto",
		);
		insertBlock("BOE-A-2024-001", "da1", "Primera", 3, "Primera.\n\nadicional");
		insertArticleSummary("BOE-A-2024-001", "a1", "uno");
		insertArticleSummary("BOE-A-2024-001", "da1", "adicional primera");

		// a2 has no summary and no namesake → omitted; dt1 has no summary but
		// shares "Primera." with da1 → "" placeholder, in document order.
		expect(svc.getArticleSummariesManifest()["BOE-A-2024-001"]).toEqual([
			["Artículo 1.", "uno", "a1"],
			["Primera.", "", "dt1"],
			["Primera.", "adicional primera", "da1"],
		]);
	});
});

describe("getBuildManifest() reforms", () => {
	it("returns AI reform headlines per norm, newest first", () => {
		insertNorm("BOE-A-2015-11430");
		for (const [date, source, headline] of [
			["2023-03-01", "BOE-A-2023-100", "Antigua"],
			["2025-06-01", "BOE-A-2025-200", "Reciente"],
		]) {
			db.run(
				"INSERT INTO reforms (norm_id, date, source_id) VALUES (?, ?, ?)",
				["BOE-A-2015-11430", date!, source!],
			);
			db.run(
				`INSERT INTO reform_summaries (norm_id, source_id, reform_date, headline, summary)
         VALUES (?, ?, ?, ?, 'resumen')`,
				["BOE-A-2015-11430", source!, date!, headline!],
			);
		}

		expect(svc.getBuildManifest().reforms["BOE-A-2015-11430"]).toEqual([
			{
				date: "2025-06-01",
				source: "BOE-A-2025-200",
				headline: "Reciente",
				summary: "resumen",
			},
			{
				date: "2023-03-01",
				source: "BOE-A-2023-100",
				headline: "Antigua",
				summary: "resumen",
			},
		]);
	});
});
