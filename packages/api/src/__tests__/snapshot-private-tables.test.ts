/**
 * Tests the privacy invariants enforced by `scripts/upload-db-snapshot.sh`.
 *
 * The script must:
 *   1. Remove every table in PRIVATE_TABLES from any public snapshot.
 *   2. Produce a "main" snapshot with no `embeddings` table.
 *   3. Produce an "embeddings-only" snapshot with ONLY the `embeddings` table.
 *
 * We replay the same SQL transformations against an in-memory fixture so we
 * catch regressions if the table list in the script and this test ever drift.
 * If a new private/PII table is added to the schema, both lists must be
 * updated.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const PRIVATE_TABLES = [
	"subscribers",
	"ask_log",
	"notified_reforms",
	"norm_follows",
	"digests",
	"notification_runs",
];

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	// Minimal schema replicating the relevant tables. We do not need the full
	// columns — only that the table exists and has at least one row to verify
	// the DROP actually removed it (not just emptied).
	db.exec(`
		CREATE TABLE norms (id TEXT PRIMARY KEY, title TEXT);
		CREATE TABLE blocks (id INTEGER PRIMARY KEY);
		CREATE TABLE versions (id INTEGER PRIMARY KEY);
		CREATE TABLE reforms (id INTEGER PRIMARY KEY);
		CREATE TABLE embeddings (norm_id TEXT, block_id INTEGER, vector BLOB);
		CREATE TABLE materias (norm_id TEXT, materia TEXT);
		CREATE TABLE reform_summaries (id INTEGER PRIMARY KEY);
		CREATE TABLE citizen_article_summaries (id INTEGER PRIMARY KEY);
		CREATE TABLE omnibus_topics (id INTEGER PRIMARY KEY);

		CREATE TABLE subscribers (email TEXT, token TEXT);
		CREATE TABLE ask_log (id INTEGER PRIMARY KEY, question TEXT);
		CREATE TABLE notified_reforms (id INTEGER PRIMARY KEY);
		CREATE TABLE norm_follows (id INTEGER PRIMARY KEY);
		CREATE TABLE digests (id INTEGER PRIMARY KEY);
		CREATE TABLE notification_runs (id INTEGER PRIMARY KEY);
	`);
	db.run(
		"INSERT INTO subscribers (email, token) VALUES ('alice@example.com', 'secret')",
	);
	db.run("INSERT INTO ask_log (question) VALUES ('user PII goes here')");
	db.run(
		"INSERT INTO embeddings (norm_id, block_id, vector) VALUES ('BOE-A-1', 1, x'00')",
	);
	db.run("INSERT INTO norms (id, title) VALUES ('BOE-A-1', 'Demo')");
});

afterEach(() => {
	db.close();
});

function listUserTables(d: Database): string[] {
	return d
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all()
		.map((r) => r.name);
}

describe("snapshot privacy invariants", () => {
	it("drops every private table from the main snapshot", () => {
		// Simulate Step 2 of the script.
		for (const t of PRIVATE_TABLES) {
			db.exec(`DROP TABLE IF EXISTS ${t}`);
		}
		// Main snapshot also drops embeddings (Step 3 of the script).
		db.exec("DROP TABLE IF EXISTS embeddings");

		const tables = listUserTables(db);
		for (const t of PRIVATE_TABLES) {
			expect(tables).not.toContain(t);
		}
		expect(tables).not.toContain("embeddings");
		expect(tables).toContain("norms");
		expect(tables).toContain("blocks");
	});

	it("produces an embeddings-only snapshot with only the embeddings table", () => {
		// Step 3 of the script: copy main, then drop everything except embeddings.
		const tables = listUserTables(db);
		for (const t of tables) {
			if (t !== "embeddings") {
				db.exec(`DROP TABLE IF EXISTS "${t}"`);
			}
		}

		const remaining = listUserTables(db);
		expect(remaining).toEqual(["embeddings"]);

		// Embeddings table should still have its row.
		const count = db
			.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM embeddings")
			.get();
		expect(count?.c).toBe(1);
	});

	it("PRIVATE_TABLES list is non-empty and unique", () => {
		expect(PRIVATE_TABLES.length).toBeGreaterThan(0);
		const set = new Set(PRIVATE_TABLES);
		expect(set.size).toBe(PRIVATE_TABLES.length);
	});

	it("PRIVATE_TABLES matches the list in upload-db-snapshot.sh", async () => {
		// Read the script and assert the bash array matches.
		const script = await Bun.file(
			new URL("../../../../scripts/upload-db-snapshot.sh", import.meta.url),
		).text();
		const match = script.match(/PRIVATE_TABLES=\(([\s\S]*?)\)/);
		expect(match).not.toBeNull();
		const scriptTables = (match?.[1] ?? "")
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		expect(scriptTables.sort()).toEqual([...PRIVATE_TABLES].sort());
	});
});
