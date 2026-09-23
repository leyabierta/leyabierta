import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import {
	importRows,
	textHash,
	validateGeneratedRow,
} from "../scripts/article-summary-import.ts";

const TEXT_A1 =
	"Artículo 1. Plazo.\n\nLas solicitudes se presentarán en el plazo de un mes desde la publicación.";
const TEXT_A2 =
	"Artículo 2. Órgano.\n\nEl Consejo estará compuesto por cinco miembros nombrados por el Gobierno.";

const row = (over: Record<string, unknown> = {}) => ({
	ok: true,
	norm_id: "N",
	block_id: "a1",
	input_hash: textHash(TEXT_A1),
	model: "qwen3.8-27b",
	summary:
		"Las solicitudes se presentan en el plazo de un mes desde la publicación de la convocatoria.",
	tags: ["solicitudes", "plazos", "convocatoria"],
	...over,
});

describe("validateGeneratedRow", () => {
	test("accepts a well-formed row and trims/dedupes tags", () => {
		const v = validateGeneratedRow(
			row({ tags: [" plazos ", "plazos", "a", "b"] }),
		);
		expect(v).toEqual({
			ok: true,
			summary: row().summary,
			tags: ["plazos", "a", "b"],
		});
	});

	test.each([
		[{ ok: false }, "generation_failed"],
		[{ input_hash: "xyz" }, "no_input_hash"],
		[{ summary: "Corto." }, "too_short"],
		[{ summary: "x".repeat(321) }, "too_long"],
		[{ tags: ["uno", "dos"] }, "bad_tag_count"],
		[{ tags: ["a", "b", "c", "d", "e", "f"] }, "bad_tag_count"],
		[{ summary: `${row().summary} 法律` }, "foreign_script"],
		[
			{ summary: "<think>ok</think> Las solicitudes se presentan en un mes." },
			"reasoning_leak",
		],
		[
			{
				summary:
					"Puedes presentar la solicitud en el plazo de un mes desde la publicación.",
			},
			"second_person",
		],
		[
			{
				summary:
					"The request shall be filed within one month of the publication date.",
			},
			"english",
		],
	])("rejects %p as %s", (over, reason) => {
		expect(validateGeneratedRow(row(over))).toEqual({ ok: false, reason });
	});

	test.each([
		"El túnel y los túneles de la red ferroviaria se inspeccionan cada 5 años.",
		"El andén debe tener una anchura mínima de 3 metros en las estaciones.",
		"Se protegen los mustélidos y los ñandús en los centros de recuperación.",
		"El Tribunal de Túnez y el río Túria se citan como ejemplos del convenio.",
		"Durante el primer quinquenio, el valor del parámetro α del Factor de Sostenibilidad será 0,25.",
	])("accepts Spanish words that contain a flagged word: %s", (summary) => {
		expect(validateGeneratedRow(row({ summary })).ok).toBe(true);
	});

	test.each([
		[
			"Tú presentas la solicitud en el plazo de un mes desde la publicación.",
			"second_person",
		],
		["Summary: the applicant files the request within one month.", "english"],
		[`${row().summary}\u0000`, "unsafe_chars"],
		[`${row().summary}\u200b`, "unsafe_chars"],
		[`${row().summary} <script>`, "unsafe_chars"],
	])("rejects %p as %s", (summary, reason) => {
		expect(validateGeneratedRow(row({ summary }))).toEqual({
			ok: false,
			reason,
		});
	});

	test("dedupes tags case-insensitively, keeping the first spelling", () => {
		const v = validateGeneratedRow(
			row({ tags: ["País Vasco", "país vasco", "plazos", "Plazos", "cuotas"] }),
		);
		expect(v).toEqual({
			ok: true,
			summary: row().summary,
			tags: ["País Vasco", "plazos", "cuotas"],
		});
	});
});

describe("importRows", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		createSchema(db);
		db.run(
			"INSERT INTO norms (id, title, country, rank, published_at, status, citizen_summary) VALUES ('N', 'Ley', 'es', 'ley', '2026-01-01', 'vigente', 'Resumen de la ley.'), ('D', 'Ley vieja', 'es', 'ley', '1990-01-01', 'derogada', 'Resumen.'), ('P', 'Ley sin resumen', 'es', 'ley', '2026-01-01', 'vigente', '')",
		);
		db.run(
			"INSERT INTO blocks (norm_id, block_id, block_type, title, position, current_text) VALUES ('N', 'a1', 'precepto', 'Artículo 1', 1, ?), ('N', 'a2', 'precepto', 'Artículo 2', 2, ?), ('D', 'a1', 'precepto', 'Artículo 1', 1, ?), ('P', 'a1', 'precepto', 'Artículo 1', 1, ?)",
			[TEXT_A1, TEXT_A2, TEXT_A1, TEXT_A1],
		);
	});

	afterEach(() => db.close());

	const count = (table: string) =>
		(db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;

	test("dry run reports what would be inserted but writes nothing", () => {
		const report = importRows(db, [row()], { apply: false });
		expect(report.inserted).toBe(1);
		expect(count("citizen_article_summaries")).toBe(0);
		expect(count("citizen_tags")).toBe(0);
	});

	test("apply inserts summary and article-level tags", () => {
		const report = importRows(db, [row()], { apply: true });
		expect(report).toEqual({ total: 1, inserted: 1, skipped: {} });
		expect(
			db
				.prepare(
					"SELECT summary FROM citizen_article_summaries WHERE norm_id='N' AND block_id='a1'",
				)
				.get(),
		).toEqual({ summary: row().summary });
		expect(count("citizen_tags")).toBe(3);
	});

	test("never overwrites an existing summary, even an empty one", () => {
		db.run(
			"INSERT INTO citizen_article_summaries (norm_id, block_id, summary) VALUES ('N', 'a1', '')",
		);
		const report = importRows(db, [row()], { apply: true });
		expect(report.inserted).toBe(0);
		expect(report.skipped).toEqual({ already_has_summary: 1 });
		expect(
			db
				.prepare(
					"SELECT summary FROM citizen_article_summaries WHERE norm_id='N' AND block_id='a1'",
				)
				.get(),
		).toEqual({ summary: "" });
	});

	test("skips rows whose article text changed since the export", () => {
		db.run(
			"UPDATE blocks SET current_text = current_text || ' Reformado.' WHERE norm_id='N' AND block_id='a1'",
		);
		const report = importRows(db, [row()], { apply: true });
		expect(report.skipped).toEqual({ source_text_changed: 1 });
		expect(count("citizen_article_summaries")).toBe(0);
	});

	test("skips missing, derogated and duplicate articles and invalid rows", () => {
		const report = importRows(
			db,
			[
				row(),
				row(),
				row({ block_id: "a99" }),
				row({ norm_id: "D" }),
				row({
					block_id: "a2",
					input_hash: textHash(TEXT_A2),
					summary: "Corto.",
				}),
			],
			{ apply: true },
		);
		expect(report.inserted).toBe(1);
		expect(report.skipped).toEqual({
			duplicate_in_file: 1,
			article_missing_or_not_vigente: 2,
			too_short: 1,
		});
	});

	test("skips laws whose law-level summary is pending (the daily cron would delete them)", () => {
		const report = importRows(db, [row({ norm_id: "P" })], { apply: true });
		expect(report.skipped).toEqual({ law_summary_pending: 1 });
		expect(count("citizen_article_summaries")).toBe(0);
	});

	test("a failed attempt later retried successfully is not reported as a failure", () => {
		const report = importRows(
			db,
			[
				{ ok: false, norm_id: "N", block_id: "a1", error: "timeout" },
				row(),
				{ ok: false, norm_id: "N", block_id: "a2" },
			],
			{ apply: true },
		);
		expect(report.inserted).toBe(1);
		expect(report.skipped).toEqual({
			failed_then_retried_ok: 1,
			generation_failed: 1,
		});
	});

	test("keeps existing article tags instead of mixing in new ones", () => {
		db.run(
			"INSERT INTO citizen_tags (norm_id, block_id, tag) VALUES ('N', 'a1', 'previa')",
		);
		importRows(db, [row()], { apply: true });
		expect(
			db
				.prepare(
					"SELECT tag FROM citizen_tags WHERE norm_id='N' AND block_id='a1'",
				)
				.all(),
		).toEqual([{ tag: "previa" }]);
		expect(count("citizen_article_summaries")).toBe(1);
	});
});
