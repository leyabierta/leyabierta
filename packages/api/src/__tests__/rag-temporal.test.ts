/**
 * Tests for temporal enrichment functions.
 * Uses real in-memory SQLite to test actual SQL queries.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
	buildTemporalEvidence,
	enrichWithTemporalContext,
} from "../services/rag/temporal.ts";

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	db.exec(`
		CREATE TABLE versions (
			norm_id TEXT,
			block_id TEXT,
			date TEXT,
			source_id TEXT,
			text TEXT
		)
	`);
});

describe("enrichWithTemporalContext", () => {
	test("single version: hasChanges=false, empty changeSummary", () => {
		db.exec(
			"INSERT INTO versions VALUES ('BOE-A-2024-001', 'art1', '2024-01-01', 'SRC-1', 'Texto original')",
		);

		const results = enrichWithTemporalContext(db, [
			{
				normId: "BOE-A-2024-001",
				blockId: "art1",
				blockTitle: "Articulo 1",
				text: "Texto original",
			},
		]);

		expect(results).toHaveLength(1);
		expect(results[0]!.hasChanges).toBe(false);
		expect(results[0]!.changeSummary).toBe("");
		expect(results[0]!.versions).toHaveLength(1);
	});

	test("2 versions: hasChanges=true, includes both in changeSummary", () => {
		db.exec(
			"INSERT INTO versions VALUES ('BOE-A-2024-001', 'art1', '2020-01-01', 'SRC-1', 'Texto v1')",
		);
		db.exec(
			"INSERT INTO versions VALUES ('BOE-A-2024-001', 'art1', '2024-06-15', 'SRC-2', 'Texto v2')",
		);

		const results = enrichWithTemporalContext(db, [
			{
				normId: "BOE-A-2024-001",
				blockId: "art1",
				blockTitle: "Articulo 1",
				text: "Texto v2",
			},
		]);

		expect(results[0]!.hasChanges).toBe(true);
		expect(results[0]!.versions).toHaveLength(2);
		// 2 versions = <= 3, so all versions are included
		expect(results[0]!.changeSummary).toContain("2020-01-01");
		expect(results[0]!.changeSummary).toContain("2024-06-15");
		expect(results[0]!.changeSummary).toContain("SRC-1");
		expect(results[0]!.changeSummary).toContain("SRC-2");
		expect(results[0]!.changeSummary).toContain("modificado 1 veces");
	});

	test("4+ versions: includes first, second-to-last, and last only", () => {
		const insert = db.prepare("INSERT INTO versions VALUES (?, ?, ?, ?, ?)");
		insert.run("N1", "b1", "2018-01-01", "S1", "Version 1 text");
		insert.run("N1", "b1", "2019-06-01", "S2", "Version 2 text");
		insert.run("N1", "b1", "2021-03-15", "S3", "Version 3 text");
		insert.run("N1", "b1", "2024-01-01", "S4", "Version 4 text");

		const results = enrichWithTemporalContext(db, [
			{
				normId: "N1",
				blockId: "b1",
				blockTitle: "Art. 5",
				text: "Version 4 text",
			},
		]);

		const summary = results[0]!.changeSummary;
		expect(results[0]!.hasChanges).toBe(true);
		expect(results[0]!.versions).toHaveLength(4);
		// Should include first (2018), second-to-last (2021), and last (2024)
		expect(summary).toContain("2018-01-01");
		expect(summary).toContain("2021-03-15");
		expect(summary).toContain("2024-01-01");
		// Should NOT include the second version text (2019)
		expect(summary).not.toContain("Version 2 text");
	});

	test("empty articles array returns empty array", () => {
		const results = enrichWithTemporalContext(db, []);
		expect(results).toHaveLength(0);
	});
});

describe("buildTemporalEvidence", () => {
	test("respects maxTokens budget (truncates when low)", () => {
		// Create a context with a very long text
		const longText = "A".repeat(2000);
		const contexts = [
			{
				normId: "N1",
				blockId: "b1",
				blockTitle: "Art. 1",
				currentText: longText,
				versions: [],
				hasChanges: false,
				changeSummary: "",
			},
			{
				normId: "N2",
				blockId: "b2",
				blockTitle: "Art. 2",
				currentText: longText,
				versions: [],
				hasChanges: false,
				changeSummary: "",
			},
		];

		// Very low budget: only enough for part of the first context
		const evidence = buildTemporalEvidence(contexts, 100);
		// At ~4 chars/token, 100 tokens = ~400 chars budget
		// The first chunk header + 2000 chars text > 400, so nothing fits
		// Or the first one fits depending on calculation. Either way, not both.
		expect(evidence).not.toContain("N2"); // second should be excluded
	});

	test("includes change summary for articles with changes", () => {
		const contexts = [
			{
				normId: "N1",
				blockId: "b1",
				blockTitle: "Art. 1",
				currentText: "Texto vigente",
				versions: [
					{ date: "2020-01-01", sourceId: "S1", text: "v1" },
					{ date: "2024-01-01", sourceId: "S2", text: "v2" },
				],
				hasChanges: true,
				changeSummary: "[HISTORIAL: modificado 1 veces]\n\n",
			},
		];

		const evidence = buildTemporalEvidence(contexts, 6000);
		expect(evidence).toContain("[HISTORIAL");
		expect(evidence).toContain("TEXTO VIGENTE:");
		expect(evidence).toContain("Texto vigente");
	});

	test("formats simple articles without change summary", () => {
		const contexts = [
			{
				normId: "N1",
				blockId: "b1",
				blockTitle: "Art. 1",
				currentText: "Texto simple",
				versions: [
					{ date: "2024-01-01", sourceId: "S1", text: "Texto simple" },
				],
				hasChanges: false,
				changeSummary: "",
			},
		];

		const evidence = buildTemporalEvidence(contexts, 6000);
		expect(evidence).toContain("[N1, Art. 1]");
		expect(evidence).toContain("Texto simple");
		expect(evidence).not.toContain("TEXTO VIGENTE:");
	});
});
