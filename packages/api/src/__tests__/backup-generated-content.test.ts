import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupGeneratedContent } from "../scripts/backup-generated-content.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "backup-gen-"));
	dirs.push(d);
	return d;
}

describe("backupGeneratedContent", () => {
	test("copies the generated-content tables row for row and skips the rest", () => {
		const src = new Database(":memory:");
		src.run(
			"CREATE TABLE reform_summaries (norm_id TEXT, source_id TEXT, headline TEXT, PRIMARY KEY (norm_id, source_id))",
		);
		src.run(
			"CREATE TABLE citizen_tags (norm_id TEXT, block_id TEXT, tag TEXT)",
		);
		src.run("CREATE TABLE ask_log (question TEXT)");
		src.run("CREATE TABLE norms (id TEXT)");
		src.run(
			"INSERT INTO reform_summaries VALUES ('A','B','Titular'),('A','C','Otro')",
		);
		src.run("INSERT INTO citizen_tags VALUES ('A','a1','vivienda')");
		src.run("INSERT INTO ask_log VALUES ('¿pregunta privada?')");

		const out = join(tmp(), "out.db");
		const counts = backupGeneratedContent(src, out);

		expect(counts).toEqual({ reform_summaries: 2, citizen_tags: 1 });
		const dst = new Database(out, { readonly: true });
		const names = (
			dst
				.query(
					"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
				)
				.all() as {
				name: string;
			}[]
		).map((r) => r.name);
		expect(names).toEqual(["citizen_tags", "reform_summaries"]);
		expect(
			dst
				.query("SELECT headline FROM reform_summaries ORDER BY source_id")
				.all(),
		).toEqual([{ headline: "Titular" }, { headline: "Otro" }]);
		dst.close();
	});

	test("overwrites a leftover file from a previous failed run", () => {
		const src = new Database(":memory:");
		src.run("CREATE TABLE digests (id INTEGER)");
		src.run("INSERT INTO digests VALUES (1)");
		const out = join(tmp(), "out.db");
		backupGeneratedContent(src, out);
		expect(backupGeneratedContent(src, out)).toEqual({ digests: 1 });
	});
});
