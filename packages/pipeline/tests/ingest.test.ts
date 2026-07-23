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

	test("rejects reform with implausible date (2929-11-19) but keeps valid reforms", async () => {
		// Regression test for the real production incident behind issue #129:
		// the BOE feed produced a reform dated 2929-11-19 for a norm, which
		// contaminated MAX(reforms.date) downstream. Ingest must reject it
		// loudly (logged + counted) rather than insert it silently.
		const norm = makeNormJson({
			reforms: [
				{
					date: "2024-06-01",
					sourceId: "BOE-A-2024-5678",
					affectedBlocks: ["art-1"],
				},
				{
					date: "2929-11-19",
					sourceId: "BOE-A-2929-99999",
					affectedBlocks: ["art-1"],
				},
			],
		});
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(norm),
		);

		const result = await ingestJsonDir(db, tempDir);

		expect(result.reformsInserted).toBe(1);
		expect(result.reformsRejected).toBe(1);
		// Bad source data is NOT an ingest error: it gets its own counter and a
		// loud warning, but must not inflate result.errors — otherwise a
		// perfectly healthy run reports "Errors: 1" every single night.
		expect(result.errors.some((e) => e.includes("2929-11-19"))).toBe(false);

		const reforms = db
			.query("SELECT * FROM reforms WHERE norm_id = 'BOE-A-2024-1234'")
			.all() as Array<Record<string, unknown>>;
		expect(reforms).toHaveLength(1);
		expect(reforms[0]?.date).toBe("2024-06-01");
	});

	test("rejects reform with date before 1800", async () => {
		const norm = makeNormJson({
			reforms: [
				{
					date: "1799-01-01",
					sourceId: "BOE-A-1799-1",
					affectedBlocks: ["art-1"],
				},
			],
		});
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(norm),
		);

		const result = await ingestJsonDir(db, tempDir);

		expect(result.reformsInserted).toBe(0);
		expect(result.reformsRejected).toBe(1);

		const reforms = db.query("SELECT * FROM reforms").all();
		expect(reforms).toHaveLength(0);
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

	test("re-ingesting with a different set of block_ids removes only orphaned blocks, preserving surviving citizen_article_summaries and reform_summaries", async () => {
		// Regression test for the diario→consolidated promotion path (#130):
		// the diario parser's block ids ("a1", "a2", ...) don't match the
		// consolidated parser's ids ("art-1", "da", "df", ...), so without SOME
		// delete the old rows become orphans and norms_fts mixes stale diario
		// text with fresh consolidated text.
		//
		// But the delete must be SURGICAL: it must not wipe
		// citizen_article_summaries for a block that survives unchanged
		// (expensive to regenerate), and it must never touch `reforms` at all —
		// reform_summaries/notified_reforms FK to reforms(norm_id, date,
		// source_id), and there's no safe order to delete a reform out from
		// under an AI summary that still references it.
		const diarioVersion = makeNormJson({
			articles: [
				{
					blockId: "a1",
					blockType: "precepto",
					title: "Articulo que sobrevive",
					position: 0,
					versions: [
						{
							date: "2024-01-15",
							sourceId: "BOE-A-2024-1234",
							text: "Diario text a1.",
						},
					],
					currentText: "Diario text a1.",
				},
				{
					blockId: "a2",
					blockType: "precepto",
					title: "Articulo que desaparece al consolidar",
					position: 1,
					versions: [
						{
							date: "2024-01-15",
							sourceId: "BOE-A-2024-1234",
							text: "Diario text a2.",
						},
					],
					currentText: "Diario text a2.",
				},
			],
			reforms: [
				{
					date: "2024-01-15",
					sourceId: "BOE-A-2024-1234",
					affectedBlocks: ["a1", "a2"],
				},
			],
		});
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(diarioVersion),
		);
		await ingestJsonDir(db, tempDir);

		// Seed AI-generated children that a real run would have produced by
		// the time a norm gets promoted: a citizen summary per block, and a
		// reform summary for the (single) reform.
		db.run(
			"INSERT INTO citizen_article_summaries (norm_id, block_id, summary) VALUES (?, ?, ?)",
			["BOE-A-2024-1234", "a1", "Resumen ciudadano de a1"],
		);
		db.run(
			"INSERT INTO citizen_article_summaries (norm_id, block_id, summary) VALUES (?, ?, ?)",
			["BOE-A-2024-1234", "a2", "Resumen ciudadano de a2"],
		);
		db.run(
			`INSERT INTO reform_summaries
				(norm_id, source_id, reform_date, reform_type, headline, summary, importance, generated_at, model)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"BOE-A-2024-1234",
				"BOE-A-2024-1234",
				"2024-01-15",
				"publicacion",
				"Titular de prueba",
				"Resumen de la reforma",
				"alta",
				"2024-01-15T00:00:00Z",
				"test-model",
			],
		);

		// Consolidated re-ingest: "a1" survives with new text, "a2" is dropped
		// (replaced by "art-2"), same reform (norm_id/date/source_id unchanged).
		const consolidatedVersion = makeNormJson({
			articles: [
				{
					blockId: "a1",
					blockType: "precepto",
					title: "Articulo que sobrevive",
					position: 0,
					versions: [
						{
							date: "2024-01-15",
							sourceId: "BOE-A-2024-1234",
							text: "Consolidated text a1.",
						},
					],
					currentText: "Consolidated text a1.",
				},
				{
					blockId: "art-2",
					blockType: "articulo",
					title: "Articulo nuevo tras consolidar",
					position: 1,
					versions: [
						{
							date: "2024-01-15",
							sourceId: "BOE-A-2024-1234",
							text: "Consolidated text art-2.",
						},
					],
					currentText: "Consolidated text art-2.",
				},
			],
			reforms: [
				{
					date: "2024-01-15",
					sourceId: "BOE-A-2024-1234",
					affectedBlocks: ["a1", "art-2"],
				},
			],
		});
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(consolidatedVersion),
		);

		// (i) No throw — with PRAGMA foreign_keys=ON, a blanket delete of
		// `blocks` would violate the FK from citizen_article_summaries/
		// reform_blocks/versions before this surgical version was written.
		await expect(ingestJsonDir(db, tempDir)).resolves.toBeTruthy();

		const blocksAfter = db
			.query(
				"SELECT block_id FROM blocks WHERE norm_id = 'BOE-A-2024-1234' ORDER BY block_id",
			)
			.all() as Array<{ block_id: string }>;
		expect(blocksAfter.map((b) => b.block_id)).toEqual(["a1", "art-2"]);

		// (ii) The orphaned block's citizen summary is gone.
		const orphanSummary = db
			.query(
				"SELECT * FROM citizen_article_summaries WHERE norm_id = 'BOE-A-2024-1234' AND block_id = 'a2'",
			)
			.get();
		expect(orphanSummary).toBeNull();

		// (iii) The surviving block's citizen summary is PRESERVED (not
		// regenerated, not deleted) — this is the expensive-to-regenerate
		// asset the surgical delete exists to protect.
		const survivingSummary = db
			.query(
				"SELECT summary FROM citizen_article_summaries WHERE norm_id = 'BOE-A-2024-1234' AND block_id = 'a1'",
			)
			.get() as { summary: string } | null;
		expect(survivingSummary?.summary).toBe("Resumen ciudadano de a1");

		// No orphaned versions or reform_blocks for the dropped block either.
		const orphanVersions = db
			.query(
				"SELECT COUNT(*) as n FROM versions WHERE norm_id = 'BOE-A-2024-1234' AND block_id = 'a2'",
			)
			.get() as { n: number };
		expect(orphanVersions.n).toBe(0);
		const orphanReformBlocks = db
			.query(
				"SELECT COUNT(*) as n FROM reform_blocks WHERE norm_id = 'BOE-A-2024-1234' AND block_id = 'a2'",
			)
			.get() as { n: number };
		expect(orphanReformBlocks.n).toBe(0);

		// (iv) reform_summaries is untouched — reforms is never cascade-deleted.
		const reformSummary = db
			.query(
				"SELECT * FROM reform_summaries WHERE norm_id = 'BOE-A-2024-1234' AND source_id = 'BOE-A-2024-1234' AND reform_date = '2024-01-15'",
			)
			.get() as { headline: string } | null;
		expect(reformSummary?.headline).toBe("Titular de prueba");

		// Exactly one reform row survives (same PK — upsert, not a duplicate).
		const reforms = db
			.query("SELECT * FROM reforms WHERE norm_id = 'BOE-A-2024-1234'")
			.all();
		expect(reforms).toHaveLength(1);
	});

	test("ingests materias/notas/referencias for a diario-origin norm with PRAGMA foreign_keys=ON (no FK violation)", async () => {
		// Regression test for #130 Stage 2 review finding: writing analisis
		// BEFORE the norm's own row existed in `norms` threw a foreign key
		// violation (materias/notas/referencias all REFERENCES norms(id)).
		// `ingest` now writes analisis for diario-origin norms itself, right
		// after inserting the parent `norms` row in the same transaction, so
		// the FK is always satisfied.
		const diarioNorm = makeNormJson({
			metadata: {
				...makeNormJson().metadata,
				id: "BOE-A-2026-16010",
				origin: "diario",
				consolidated: false,
				section: "1",
			},
			analisis: {
				materias: ["Vehículos eléctricos", "Subvenciones"],
				notas: ["Entra en vigor el día siguiente de su publicación."],
				referencias: {
					anteriores: [
						{
							normId: "BOE-A-2020-1000",
							relation: "DE CONFORMIDAD con",
							text: "Real Decreto anterior",
						},
					],
					posteriores: [],
				},
			},
		});
		await writeFile(
			join(tempDir, "BOE-A-2026-16010.json"),
			JSON.stringify(diarioNorm),
		);

		await expect(ingestJsonDir(db, tempDir)).resolves.toBeTruthy();

		const materias = db
			.query("SELECT materia FROM materias WHERE norm_id = ? ORDER BY materia")
			.all("BOE-A-2026-16010") as Array<{ materia: string }>;
		expect(materias.map((m) => m.materia)).toEqual([
			"Subvenciones",
			"Vehículos eléctricos",
		]);

		const notas = db
			.query("SELECT nota FROM notas WHERE norm_id = ?")
			.all("BOE-A-2026-16010") as Array<{ nota: string }>;
		expect(notas).toHaveLength(1);

		const refs = db
			.query(
				"SELECT target_id, relation FROM referencias WHERE norm_id = ? AND direction = 'anterior'",
			)
			.all("BOE-A-2026-16010") as Array<{
			target_id: string;
			relation: string;
		}>;
		expect(refs).toEqual([
			{ target_id: "BOE-A-2020-1000", relation: "DE CONFORMIDAD con" },
		]);
	});

	test("does NOT write analisis from ingest for consolidated-origin norms", async () => {
		// ingest-analisis stays the sole writer for consolidated norms — this
		// guards against the diario-analisis-write path in ingest.ts silently
		// widening scope to the ~12k consolidated norms.
		const consolidatedNorm = makeNormJson({
			analisis: {
				materias: ["No debería escribirse"],
				notas: [],
				referencias: { anteriores: [], posteriores: [] },
			},
		});
		await writeFile(
			join(tempDir, "BOE-A-2024-1234.json"),
			JSON.stringify(consolidatedNorm),
		);

		await ingestJsonDir(db, tempDir);

		const materias = db
			.query("SELECT * FROM materias WHERE norm_id = ?")
			.all("BOE-A-2024-1234");
		expect(materias).toHaveLength(0);
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
			.query(
				"SELECT country, jurisdiction FROM norms WHERE id = 'BOE-A-2024-ANDA'",
			)
			.get() as { country: string; jurisdiction: string };
		expect(row.country).toBe("es");
		expect(row.jurisdiction).toBe("es-an");
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
			.query(
				"SELECT country, jurisdiction FROM norms WHERE id = 'BOJA-2024-0001'",
			)
			.get() as { country: string; jurisdiction: string };
		expect(row.country).toBe("es");
		expect(row.jurisdiction).toBe("es-an");
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
