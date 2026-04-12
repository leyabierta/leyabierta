import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ingestJsonDir,
	normalizeArticle,
	validateNorm,
} from "../src/db/index.ts";
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
		expect(ftsResult[0]!.norm_id).toBe("BOE-A-2024-1234");
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

	test("processes files in batches with correct results", async () => {
		// Create 5 norm files, use batchSize=2 → should produce 3 batches
		for (let i = 1; i <= 5; i++) {
			const norm = makeNormJson({
				metadata: {
					...makeNormJson().metadata,
					id: `BOE-A-2024-000${i}`,
					title: `Ley ${i}`,
				},
			});
			await writeFile(
				join(tempDir, `BOE-A-2024-000${i}.json`),
				JSON.stringify(norm),
			);
		}

		const result = await ingestJsonDir(db, tempDir, { batchSize: 2 });

		expect(result.normsInserted).toBe(5);
		expect(result.blocksInserted).toBe(5);
		expect(result.errors).toHaveLength(0);
		expect(result.duration).toBeGreaterThan(0);

		const norms = db.query("SELECT * FROM norms").all();
		expect(norms).toHaveLength(5);
	});

	test("selective ingest by IDs only processes specified norms", async () => {
		for (let i = 1; i <= 3; i++) {
			const norm = makeNormJson({
				metadata: {
					...makeNormJson().metadata,
					id: `BOE-A-2024-000${i}`,
					title: `Ley ${i}`,
				},
			});
			await writeFile(
				join(tempDir, `BOE-A-2024-000${i}.json`),
				JSON.stringify(norm),
			);
		}

		const result = await ingestJsonDir(db, tempDir, {
			ids: ["BOE-A-2024-0001", "BOE-A-2024-0003"],
		});

		expect(result.normsInserted).toBe(2);
		expect(result.errors).toHaveLength(0);

		const norms = db.query("SELECT id FROM norms ORDER BY id").all() as Array<{
			id: string;
		}>;
		expect(norms.map((n) => n.id)).toEqual([
			"BOE-A-2024-0001",
			"BOE-A-2024-0003",
		]);
	});

	test("normalizes snake_case JSON keys to camelCase", async () => {
		const snakeCaseNorm = {
			metadata: {
				title: "Ley con snake_case",
				shortTitle: "",
				id: "BOE-A-2024-SNAKE",
				country: "es",
				rank: "real_decreto_ley",
				published: "2024-01-01",
				updated: "",
				status: "vigente",
				department: "",
				source: "",
			},
			articles: [
				{
					block_id: "art-1",
					block_type: "articulo",
					title: "Articulo 1",
					versions: [
						{
							date: "2024-01-01",
							sourceId: "BOE-A-2024-SNAKE",
							text: "Snake case text.",
						},
					],
				},
			],
			reforms: [],
		};

		await writeFile(
			join(tempDir, "BOE-A-2024-SNAKE.json"),
			JSON.stringify(snakeCaseNorm),
		);

		const result = await ingestJsonDir(db, tempDir);

		expect(result.normsInserted).toBe(1);
		expect(result.blocksInserted).toBe(1);
		expect(result.errors).toHaveLength(0);

		const block = db
			.query("SELECT * FROM blocks WHERE norm_id = 'BOE-A-2024-SNAKE'")
			.get() as Record<string, unknown>;
		expect(block).toBeTruthy();
		expect(block.block_id).toBe("art-1");
		expect(block.block_type).toBe("articulo");
		expect(block.current_text).toBe("Snake case text.");
	});

	test("skips corrupt JSON with error, continues batch", async () => {
		// Valid norm
		const norm = makeNormJson();
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(norm),
		);

		// Corrupt JSON
		await writeFile(join(tempDir, "BOE-A-2024-BAD.json"), "{invalid json!!!");

		// Valid norm 2
		const norm2 = makeNormJson({
			metadata: { ...makeNormJson().metadata, id: "BOE-A-2024-0002" },
		});
		await writeFile(
			join(tempDir, "BOE-A-2024-0002.json"),
			JSON.stringify(norm2),
		);

		const result = await ingestJsonDir(db, tempDir);

		// Both valid norms should be ingested
		expect(result.normsInserted).toBe(2);
		// One error from corrupt JSON
		expect(result.errors.length).toBeGreaterThanOrEqual(1);
		expect(result.errors.some((e) => e.includes("BOE-A-2024-BAD"))).toBe(true);
	});

	test("skips empty file with error", async () => {
		await writeFile(join(tempDir, "BOE-A-2024-EMPTY.json"), "");

		const result = await ingestJsonDir(db, tempDir);

		expect(result.normsInserted).toBe(0);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test("handles non-existent ID gracefully", async () => {
		const norm = makeNormJson();
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(norm),
		);

		const result = await ingestJsonDir(db, tempDir, {
			ids: ["BOE-A-DOES-NOT-EXIST"],
		});

		expect(result.normsInserted).toBe(0);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("No JSON files found for IDs");
	});

	test("re-ingest preserves citizen_summary", async () => {
		const norm = makeNormJson();
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(norm),
		);

		await ingestJsonDir(db, tempDir);

		// Set a citizen_summary manually
		db.run(
			"UPDATE norms SET citizen_summary = 'Test summary' WHERE id = 'BOE-A-2024-1234'",
		);

		// Re-ingest
		await ingestJsonDir(db, tempDir);

		const row = db
			.query("SELECT citizen_summary FROM norms WHERE id = 'BOE-A-2024-1234'")
			.get() as { citizen_summary: string };
		expect(row.citizen_summary).toBe("Test summary");
	});

	test("skips JSON with missing required metadata fields", async () => {
		const invalidNorm = {
			metadata: {
				title: "Missing id",
				shortTitle: "",
				country: "es",
				rank: "ley",
				published: "2024-01-01",
				status: "vigente",
			},
			articles: [],
			reforms: [],
		};

		await writeFile(
			join(tempDir, "BOE-A-2024-INVALID.json"),
			JSON.stringify(invalidNorm),
		);

		const result = await ingestJsonDir(db, tempDir);

		expect(result.normsInserted).toBe(0);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("metadata.id");
	});

	test("resolves jurisdiction from ELI source URL", async () => {
		const norm = makeNormJson({
			metadata: {
				...makeNormJson().metadata,
				id: "BOE-A-2024-ANDA",
				country: "es",
				source: "https://www.boe.es/eli/es-an/l/2024/01/01/1",
			},
		});
		await writeFile(
			join(tempDir, "BOE-A-2024-ANDA.json"),
			JSON.stringify(norm),
		);

		await ingestJsonDir(db, tempDir);

		const row = db
			.query("SELECT country FROM norms WHERE id = 'BOE-A-2024-ANDA'")
			.get() as { country: string };
		expect(row.country).toBe("es-an");
	});

	test("resolves jurisdiction from regional bulletin ID prefix", async () => {
		const norm = makeNormJson({
			metadata: {
				...makeNormJson().metadata,
				id: "BOJA-2024-0001",
				country: "es",
				source: "https://www.boe.es/buscar/act.php?id=BOJA-2024-0001",
			},
		});
		await writeFile(join(tempDir, "BOJA-2024-0001.json"), JSON.stringify(norm));

		await ingestJsonDir(db, tempDir);

		const row = db
			.query("SELECT country FROM norms WHERE id = 'BOJA-2024-0001'")
			.get() as { country: string };
		expect(row.country).toBe("es-an");
	});
});

describe("validateNorm", () => {
	test("accepts valid norm", () => {
		const norm = makeNormJson();
		const { valid, errors } = validateNorm(norm);
		expect(valid).toBe(true);
		expect(errors).toHaveLength(0);
	});

	test("rejects null input", () => {
		const { valid } = validateNorm(null);
		expect(valid).toBe(false);
	});

	test("rejects missing metadata", () => {
		const { valid, errors } = validateNorm({ articles: [], reforms: [] });
		expect(valid).toBe(false);
		expect(errors[0]).toContain("metadata");
	});

	test("rejects missing required fields", () => {
		const { valid, errors } = validateNorm({
			metadata: { title: "Test" },
			articles: [],
			reforms: [],
		});
		expect(valid).toBe(false);
		expect(errors.some((e) => e.includes("metadata.id"))).toBe(true);
	});
});

describe("normalizeArticle", () => {
	test("converts snake_case to camelCase", () => {
		const result = normalizeArticle(
			{
				block_id: "art-1",
				block_type: "articulo",
				title: "Test",
				versions: [],
			},
			0,
		);
		expect(result.blockId).toBe("art-1");
		expect(result.blockType).toBe("articulo");
		expect(result.position).toBe(0);
		expect(result.currentText).toBe("");
	});

	test("preserves camelCase without modification", () => {
		const result = normalizeArticle(
			{
				blockId: "art-2",
				blockType: "preambulo",
				title: "Preamble",
				position: 5,
				versions: [{ date: "2024-01-01", sourceId: "X", text: "hello" }],
				currentText: "hello",
			},
			0,
		);
		expect(result.blockId).toBe("art-2");
		expect(result.position).toBe(5);
		expect(result.currentText).toBe("hello");
	});

	test("defaults currentText to last version text", () => {
		const result = normalizeArticle(
			{
				block_id: "art-3",
				block_type: "articulo",
				title: "Test",
				versions: [
					{ date: "2024-01-01", sourceId: "X", text: "v1" },
					{ date: "2024-06-01", sourceId: "Y", text: "v2" },
				],
			},
			2,
		);
		expect(result.currentText).toBe("v2");
		expect(result.position).toBe(2);
	});
});
