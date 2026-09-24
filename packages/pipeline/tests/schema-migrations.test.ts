import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createSchema, hasColumn } from "../src/db/index.ts";

describe("reform_summaries.prompt_version migration", () => {
	test("a new DB gets the column", () => {
		const db = new Database(":memory:");
		createSchema(db);
		expect(hasColumn(db, "reform_summaries", "prompt_version")).toBe(true);
	});

	test("an old DB without the column gets it, keeping its rows", () => {
		const db = new Database(":memory:");
		db.exec(`CREATE TABLE reform_summaries (
			norm_id TEXT NOT NULL, source_id TEXT NOT NULL, reform_date TEXT NOT NULL,
			reform_type TEXT NOT NULL DEFAULT '', headline TEXT NOT NULL DEFAULT '',
			summary TEXT NOT NULL DEFAULT '', importance TEXT NOT NULL DEFAULT '',
			generated_at TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (norm_id, source_id, reform_date))`);
		db.exec(
			"INSERT INTO reform_summaries (norm_id, source_id, reform_date, headline) VALUES ('N', 'S', '2021-06-01', 'viejo')",
		);
		expect(hasColumn(db, "reform_summaries", "prompt_version")).toBe(false);
		createSchema(db);
		expect(hasColumn(db, "reform_summaries", "prompt_version")).toBe(true);
		const row = db
			.query<{ headline: string; prompt_version: string }, []>(
				"SELECT headline, prompt_version FROM reform_summaries",
			)
			.get();
		expect(row).toEqual({ headline: "viejo", prompt_version: "" });
	});

	test("running createSchema twice is idempotent", () => {
		const db = new Database(":memory:");
		createSchema(db);
		expect(() => createSchema(db)).not.toThrow();
	});
});

describe("citizen_article_summaries traceability migration", () => {
	const COLUMNS = ["model", "prompt_version", "generated_at"];

	test("a new DB gets model, prompt_version and generated_at", () => {
		const db = new Database(":memory:");
		createSchema(db);
		for (const c of COLUMNS)
			expect(hasColumn(db, "citizen_article_summaries", c)).toBe(true);
	});

	test("an old DB gets the columns, keeping its rows with ''", () => {
		const db = new Database(":memory:");
		db.exec(`CREATE TABLE citizen_article_summaries (
			norm_id TEXT NOT NULL, block_id TEXT NOT NULL,
			summary TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (norm_id, block_id))`);
		db.exec(
			"INSERT INTO citizen_article_summaries (norm_id, block_id, summary) VALUES ('N', 'a1', 'viejo')",
		);
		createSchema(db);
		expect(
			db
				.query(
					"SELECT summary, model, prompt_version, generated_at FROM citizen_article_summaries",
				)
				.get(),
		).toEqual({
			summary: "viejo",
			model: "",
			prompt_version: "",
			generated_at: "",
		});
		expect(() => createSchema(db)).not.toThrow();
	});
});
