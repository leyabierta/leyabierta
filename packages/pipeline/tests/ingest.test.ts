import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestJsonDir } from "../src/db/index.ts";
import { createSchema } from "../src/db/schema.ts";

function makeNormJson(overrides: Record<string, unknown> = {}) {
	return {
		metadata: {
			title: "Ley de Pruebas Unitarias",
			shortTitle: "Ley de Pruebas",
			id: "BOE-A-2024-1234",
			country: "es",
			rank: "ley",
			published: "2024-01-15",
			updated: "2024-06-01",
			status: "vigente",
			department: "Ministerio de Justicia",
			source: "https://www.boe.es/eli/es/l/2024/01/15/1",
		},
		articles: [
			{
				blockId: "art-1",
				blockType: "articulo",
				title: "Articulo 1",
				position: 0,
				versions: [
					{
						date: "2024-01-15",
						sourceId: "BOE-A-2024-1234",
						text: "First version of article 1.",
					},
				],
				currentText: "First version of article 1.",
			},
		],
		reforms: [],
		...overrides,
	};
}

let db: Database;
let tempDir: string;

beforeEach(async () => {
	db = new Database(":memory:");
	createSchema(db);
	tempDir = await mkdtemp(join(tmpdir(), "ingest-test-"));
});

afterEach(async () => {
	db.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe("createSchema", () => {
	test("creates all expected tables", () => {
		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as Array<{ name: string }>;

		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("norms");
		expect(tableNames).toContain("blocks");
		expect(tableNames).toContain("versions");
		expect(tableNames).toContain("reforms");
		expect(tableNames).toContain("reform_blocks");
		expect(tableNames).toContain("norms_fts");
		expect(tableNames).toContain("materias");
		expect(tableNames).toContain("notas");
		expect(tableNames).toContain("referencias");
	});
});

describe("ingestJsonDir", () => {
	test("ingests a norm JSON file correctly", async () => {
		const norm = makeNormJson();
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(norm),
		);

		const result = await ingestJsonDir(db, tempDir);

		expect(result.normsInserted).toBe(1);
		expect(result.blocksInserted).toBe(1);
		expect(result.versionsInserted).toBe(1);
		expect(result.errors).toHaveLength(0);

		const row = db
			.query("SELECT * FROM norms WHERE id = 'BOE-A-2024-1234'")
			.get() as Record<string, unknown>;
		expect(row).toBeTruthy();
		expect(row.title).toBe("Ley de Pruebas Unitarias");
		expect(row.country).toBe("es");
		expect(row.rank).toBe("ley");
		expect(row.status).toBe("vigente");
		expect(row.published_at).toBe("2024-01-15");
		expect(row.updated_at).toBe("2024-06-01");

		const block = db
			.query("SELECT * FROM blocks WHERE norm_id = 'BOE-A-2024-1234'")
			.get() as Record<string, unknown>;
		expect(block).toBeTruthy();
		expect(block.block_id).toBe("art-1");
		expect(block.block_type).toBe("articulo");

		const version = db
			.query("SELECT * FROM versions WHERE norm_id = 'BOE-A-2024-1234'")
			.get() as Record<string, unknown>;
		expect(version).toBeTruthy();
		expect(version.text).toBe("First version of article 1.");
	});

	test("handles norm with multiple reforms and versions", async () => {
		const norm = makeNormJson({
			articles: [
				{
					blockId: "art-1",
					blockType: "articulo",
					title: "Articulo 1",
					position: 0,
					versions: [
						{
							date: "2024-01-15",
							sourceId: "BOE-A-2024-1234",
							text: "Original text.",
						},
						{
							date: "2024-06-01",
							sourceId: "BOE-A-2024-5678",
							text: "Reformed text.",
						},
					],
					currentText: "Reformed text.",
				},
				{
					blockId: "art-2",
					blockType: "articulo",
					title: "Articulo 2",
					position: 1,
					versions: [
						{
							date: "2024-01-15",
							sourceId: "BOE-A-2024-1234",
							text: "Article 2 text.",
						},
					],
					currentText: "Article 2 text.",
				},
			],
			reforms: [
				{
					date: "2024-06-01",
					sourceId: "BOE-A-2024-5678",
					affectedBlocks: ["art-1"],
				},
				{
					date: "2024-09-01",
					sourceId: "BOE-A-2024-9999",
					affectedBlocks: ["art-1", "art-2"],
				},
			],
		});

		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(norm),
		);

		const result = await ingestJsonDir(db, tempDir);

		expect(result.normsInserted).toBe(1);
		expect(result.blocksInserted).toBe(2);
		expect(result.versionsInserted).toBe(3);
		expect(result.reformsInserted).toBe(2);
		expect(result.errors).toHaveLength(0);

		const reformBlocks = db
			.query("SELECT * FROM reform_blocks WHERE norm_id = 'BOE-A-2024-1234'")
			.all();
		// Reform 1 affects 1 block, reform 2 affects 2 blocks = 3 total
		expect(reformBlocks).toHaveLength(3);
	});

	test("populates FTS5 index and search by title works", async () => {
		const norm = makeNormJson();
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(norm),
		);

		await ingestJsonDir(db, tempDir);

		const ftsResult = db
			.query("SELECT * FROM norms_fts WHERE norms_fts MATCH 'Pruebas'")
			.all() as Array<Record<string, unknown>>;
		expect(ftsResult).toHaveLength(1);
		expect(ftsResult[0].norm_id).toBe("BOE-A-2024-1234");
	});

	test("re-ingesting same norm does not create duplicates (upsert)", async () => {
		const norm = makeNormJson();
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(norm),
		);

		await ingestJsonDir(db, tempDir);
		await ingestJsonDir(db, tempDir);

		const norms = db.query("SELECT * FROM norms").all();
		expect(norms).toHaveLength(1);

		const blocks = db.query("SELECT * FROM blocks").all();
		expect(blocks).toHaveLength(1);

		const versions = db.query("SELECT * FROM versions").all();
		expect(versions).toHaveLength(1);

		// Note: FTS5 INSERT OR REPLACE does not deduplicate like regular tables,
		// so we verify the core tables have no duplicates instead.
		// FTS5 accumulates entries -- this is a known limitation of the current ingest code.
	});

	test("handles empty articles array", async () => {
		const norm = makeNormJson({ articles: [] });
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(norm),
		);

		const result = await ingestJsonDir(db, tempDir);

		expect(result.normsInserted).toBe(1);
		expect(result.blocksInserted).toBe(0);
		expect(result.versionsInserted).toBe(0);
		expect(result.errors).toHaveLength(0);

		const row = db
			.query("SELECT * FROM norms WHERE id = 'BOE-A-2024-1234'")
			.get();
		expect(row).toBeTruthy();
	});

	test("handles missing optional fields gracefully", async () => {
		const norm = makeNormJson({
			metadata: {
				title: "Minimal Norm",
				shortTitle: "",
				id: "BOE-A-2024-0001",
				country: "es",
				rank: "ley",
				published: "2024-01-01",
				updated: "",
				status: "vigente",
				department: "",
				source: "",
			},
			articles: [],
			reforms: [],
		});
		await writeFile(
			join(tempDir, "BOE-A-2024-0001.json"),
			JSON.stringify(norm),
		);

		const result = await ingestJsonDir(db, tempDir);

		expect(result.normsInserted).toBe(1);
		expect(result.errors).toHaveLength(0);

		const row = db
			.query("SELECT * FROM norms WHERE id = 'BOE-A-2024-0001'")
			.get() as Record<string, unknown>;
		expect(row).toBeTruthy();
		expect(row.title).toBe("Minimal Norm");
		expect(row.department).toBe("");
	});

	test("reports error when no JSON files found", async () => {
		const emptyDir = await mkdtemp(join(tmpdir(), "empty-"));
		try {
			const result = await ingestJsonDir(db, emptyDir);
			expect(result.normsInserted).toBe(0);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain("No JSON files found");
		} finally {
			await rm(emptyDir, { recursive: true, force: true });
		}
	});
});
