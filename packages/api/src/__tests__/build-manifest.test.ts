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
	});

	it("returns citizen summaries for norms that have them", () => {
		insertNorm("BOE-A-2024-001", "This law affects taxes");
		insertNorm("BOE-A-2024-002", ""); // no summary
		insertNorm("BOE-A-2024-003", "This law affects housing");

		const result = svc.getBuildManifest();
		expect(Object.keys(result.citizens)).toHaveLength(2);
		expect(result.citizens["BOE-A-2024-001"].summary).toBe(
			"This law affects taxes",
		);
		expect(result.citizens["BOE-A-2024-003"].summary).toBe(
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
		expect(result.citizens["BOE-A-2024-001"].tags).toEqual([
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
		expect(result.omnibus["BOE-A-2024-001"][0].topic_label).toBe(
			"Fiscal reform",
		);
		expect(result.omnibus["BOE-A-2024-001"][1].topic_label).toBe(
			"Labor changes",
		);
		expect(result.omnibus["BOE-A-2024-002"]).toHaveLength(1);
	});

	it("omnibus topics include all expected fields", () => {
		insertNorm("BOE-A-2024-001");
		insertOmnibusTopic("BOE-A-2024-001", 0, "Topic A");

		const result = svc.getBuildManifest();
		const topic = result.omnibus["BOE-A-2024-001"][0];
		expect(topic).toHaveProperty("topic_label");
		expect(topic).toHaveProperty("article_count");
		expect(topic).toHaveProperty("headline");
		expect(topic).toHaveProperty("summary");
		expect(topic).toHaveProperty("is_sneaked");
		expect(topic).toHaveProperty("block_ids");
	});
});
