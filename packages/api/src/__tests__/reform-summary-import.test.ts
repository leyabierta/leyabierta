import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import {
	importReformRows,
	normalizeModelId,
	promptHash,
	summaryHash,
	validateGeneratedReform,
} from "../scripts/reform-summary-import.ts";
import {
	buildReformPrompt,
	PROMPT_VERSION,
} from "../scripts/reform-summary-prompt.ts";

const RESULT = {
	headline: "Se amplía a cuatro meses el plazo de solicitud",
	summary:
		"El plazo para presentar solicitudes pasa de tres a cuatro meses desde la convocatoria.",
	importance: "normal",
	reform_type: "modification",
};

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	createSchema(db);
	db.run(
		"INSERT INTO norms (id, title, country, rank, published_at, status) VALUES ('N', 'Ley de ayudas', 'es', 'ley', '2020-01-01', 'vigente'), ('D', 'Ley derogada', 'es', 'ley', '2020-01-01', 'derogada'), ('S', 'Ley de medidas', 'es', 'ley', '2021-01-01', 'vigente')",
	);
	db.run(
		"INSERT INTO reforms (norm_id, date, source_id) VALUES ('N', '2020-01-01', 'N'), ('N', '2021-06-01', 'S'), ('D', '2021-06-01', 'S')",
	);
	db.run(
		"INSERT INTO blocks (norm_id, block_id, block_type, title, position, current_text) VALUES ('N', 'a1', 'precepto', 'Artículo 1', 1, 'Plazo de cuatro meses.')",
	);
	db.run(
		"INSERT INTO versions (norm_id, block_id, date, source_id, text) VALUES ('N', 'a1', '2020-01-01', 'N', 'Plazo de tres meses.'), ('N', 'a1', '2021-06-01', 'S', 'Plazo de cuatro meses.')",
	);
	db.run(
		"INSERT INTO reform_blocks (norm_id, reform_date, reform_source_id, block_id) VALUES ('N', '2021-06-01', 'S', 'a1')",
	);
});
afterEach(() => db.close());

const reformOf = (norm_id: string, source_id: string, date: string) => ({
	norm_id,
	source_id,
	date,
	title: norm_id === "N" ? "Ley de ayudas" : "Ley derogada",
	rank: "ley",
});

const row = (over: Record<string, unknown> = {}) => ({
	ok: true,
	norm_id: "N",
	source_id: "S",
	reform_date: "2021-06-01",
	input_hash: promptHash(
		buildReformPrompt(db, reformOf("N", "S", "2021-06-01")),
	),
	prompt_version: PROMPT_VERSION,
	model: "qwen3.8-27b",
	result: RESULT,
	...over,
});

describe("validateGeneratedReform", () => {
	test("accepts a well-formed row", () => {
		expect(validateGeneratedReform(row()).ok).toBe(true);
	});

	test.each([
		[{ ok: false }, "generation_failed"],
		[{ input_hash: "nope" }, "no_input_hash"],
		[
			{ result: { ...RESULT, importance: "huge" } },
			'invalid: invalid importance: "huge"',
		],
		[
			{ result: { ...RESULT, headline: "" } },
			"invalid: empty headline or summary",
		],
		[
			{ result: { ...RESULT, headline: Array(25).fill("ley").join(" ") } },
			"headline_too_long",
		],
		[
			{ result: { ...RESULT, summary: `${RESULT.summary} 法律` } },
			"invalid: foreign script (model switched language)",
		],
		[
			{
				result: {
					...RESULT,
					summary: "Puedes pedir la ayuda durante cuatro meses.",
				},
			},
			"second_person",
		],
		[
			{ result: { ...RESULT, summary: "The deadline shall be four months." } },
			"english",
		],
	])("rejects %p as %s", (over, reason) => {
		expect(validateGeneratedReform(row(over))).toEqual({ ok: false, reason });
	});
});

describe("importReformRows", () => {
	const summaries = () =>
		db.prepare("SELECT * FROM reform_summaries").all() as Record<
			string,
			string
		>[];

	test("the prompt shows the real change (not the first 500 chars)", () => {
		const { user } = buildReformPrompt(db, reformOf("N", "S", "2021-06-01"));
		expect(user).toContain("[-tres-] {+cuatro+}");
	});

	test("dry run writes nothing", () => {
		const report = importReformRows(db, [row()], { apply: false });
		expect(report.inserted).toBe(1);
		expect(summaries()).toHaveLength(0);
	});

	test("apply inserts with the model name (provider-prefixed) and prompt version", () => {
		const report = importReformRows(db, [row()], { apply: true });
		expect(report).toEqual({
			total: 1,
			inserted: 1,
			replaced: 0,
			markedNotified: 1,
			skipped: {},
		});
		const [s] = summaries();
		expect(s?.headline).toBe(RESULT.headline);
		expect(s?.model).toBe("qwen/qwen3.8-27b");
		expect(s?.prompt_version).toBe(PROMPT_VERSION);
		expect(s?.reform_type).toBe("modification");
	});

	test("never overwrites an existing summary", () => {
		db.run(
			"INSERT INTO reform_summaries (norm_id, source_id, reform_date, headline, summary) VALUES ('N', 'S', '2021-06-01', 'previo', 'previo')",
		);
		const report = importReformRows(db, [row()], { apply: true });
		expect(report.skipped).toEqual({ already_has_summary: 1 });
		expect(summaries()[0]?.headline).toBe("previo");
	});

	test("skips the row if the data behind the prompt changed", () => {
		const generated = row();
		db.run(
			"UPDATE versions SET text = 'Plazo de cinco meses.' WHERE norm_id = 'N' AND date = '2021-06-01'",
		);
		const report = importReformRows(db, [generated], { apply: true });
		expect(report.skipped).toEqual({ source_data_changed: 1 });
		expect(summaries()).toHaveLength(0);
	});

	test("rows built by another prompt version are skipped as such", () => {
		const report = importReformRows(db, [row({ prompt_version: "old" })], {
			apply: true,
		});
		expect(report.skipped).toEqual({ prompt_version_changed: 1 });
	});

	test("an original publication is stored as new_law", () => {
		const r = row({
			source_id: "N",
			reform_date: "2020-01-01",
			input_hash: promptHash(
				buildReformPrompt(db, reformOf("N", "N", "2020-01-01")),
			),
		});
		importReformRows(db, [r], { apply: true });
		expect(summaries()[0]?.reform_type).toBe("new_law");
	});

	test("skips reforms of derogated laws, unknown reforms and duplicates", () => {
		const report = importReformRows(
			db,
			[
				row(),
				row(),
				row({ norm_id: "D" }),
				row({ reform_date: "1999-01-01" }),
				{ ok: false, norm_id: "N", source_id: "S", reform_date: "2021-06-01" },
			],
			{ apply: true },
		);
		expect(report.inserted).toBe(1);
		expect(report.skipped).toEqual({
			duplicate_in_file: 1,
			reform_missing_or_not_vigente: 2,
			failed_then_retried_ok: 1,
		});
	});

	describe("replace (regeneration)", () => {
		const KEY = "N|S|2021-06-01";
		const seedOld = () =>
			db.run(
				"INSERT INTO reform_summaries (norm_id, source_id, reform_date, reform_type, headline, summary, importance, generated_at, model) VALUES ('N', 'S', '2021-06-01', 'modification', 'viejo', 'resumen viejo', 'normal', '2026-09-23 18:04:00', 'google/gemini-2.5-flash-lite')",
			);
		const exported = () =>
			new Map([[KEY, summaryHash("viejo", "resumen viejo")]]);

		test("replaces the summary seen at export time, with model and date", () => {
			seedOld();
			const dry = importReformRows(db, [row()], {
				apply: false,
				replace: exported(),
			});
			expect(dry.replaced).toBe(1);
			expect(summaries()[0]?.headline).toBe("viejo");

			const report = importReformRows(db, [row()], {
				apply: true,
				replace: exported(),
			});
			expect(report).toEqual({
				total: 1,
				inserted: 0,
				replaced: 1,
				markedNotified: 1,
				skipped: {},
			});
			const [s] = summaries();
			expect(s?.headline).toBe(RESULT.headline);
			expect(s?.summary).toBe(RESULT.summary);
			expect(s?.model).toBe("qwen/qwen3.8-27b");
			expect(s?.prompt_version).toBe(PROMPT_VERSION);
			expect(s?.generated_at).not.toBe("2026-09-23 18:04:00");
		});

		test("a summary changed since export is left alone", () => {
			seedOld();
			db.run(
				"UPDATE reform_summaries SET summary = 'otro' WHERE norm_id = 'N'",
			);
			const report = importReformRows(db, [row()], {
				apply: true,
				replace: exported(),
			});
			expect(report.skipped).toEqual({ summary_changed_since_export: 1 });
			expect(summaries()[0]?.summary).toBe("otro");
		});

		test("running the import twice reports already_replaced", () => {
			seedOld();
			importReformRows(db, [row()], { apply: true, replace: exported() });
			const again = importReformRows(db, [row()], {
				apply: true,
				replace: exported(),
			});
			expect(again.skipped).toEqual({ already_replaced: 1 });
		});

		test("reforms not in the export are still never overwritten", () => {
			seedOld();
			const report = importReformRows(db, [row()], {
				apply: true,
				replace: new Map([["N|N|2020-01-01", "x"]]),
			});
			expect(report.skipped).toEqual({ already_has_summary: 1 });
			expect(summaries()[0]?.headline).toBe("viejo");
		});

		test("a stale prompt still blocks the replacement", () => {
			seedOld();
			const report = importReformRows(db, [row({ prompt_version: "old" })], {
				apply: true,
				replace: exported(),
			});
			expect(report.skipped).toEqual({ prompt_version_changed: 1 });
			expect(summaries()[0]?.headline).toBe("viejo");
		});

		test("rows without a previous summary are inserted", () => {
			const report = importReformRows(db, [row()], {
				apply: true,
				replace: exported(),
			});
			expect(report.inserted).toBe(1);
		});
	});

	describe("alert emails", () => {
		const notified = () =>
			db
				.prepare("SELECT norm_id, source_id, reform_date FROM notified_reforms")
				.all();

		test("an old reform inserted offline is marked as notified", () => {
			const report = importReformRows(db, [row()], { apply: true });
			expect(report.markedNotified).toBe(1);
			expect(notified()).toEqual([
				{ norm_id: "N", source_id: "S", reform_date: "2021-06-01" },
			]);
		});

		test("a recent reform is left for the daily alerts", () => {
			const report = importReformRows(db, [row()], {
				apply: true,
				alertCutoff: "2021-05-01",
			});
			expect(report.inserted).toBe(1);
			expect(report.markedNotified).toBe(0);
			expect(notified()).toHaveLength(0);
		});

		test("a replaced old summary is marked; a recent one keeps alerting", () => {
			const seed = () =>
				db.run(
					"INSERT OR REPLACE INTO reform_summaries (norm_id, source_id, reform_date, headline, summary, importance) VALUES ('N', 'S', '2021-06-01', 'viejo', 'resumen viejo', 'skip')",
				);
			const replace = () =>
				new Map([["N|S|2021-06-01", summaryHash("viejo", "resumen viejo")]]);
			seed();
			const recent = importReformRows(db, [row()], {
				apply: true,
				alertCutoff: "2021-05-01",
				replace: replace(),
			});
			expect(recent.replaced).toBe(1);
			expect(notified()).toHaveLength(0);

			seed();
			const old = importReformRows(db, [row()], {
				apply: true,
				replace: replace(),
			});
			expect(old.replaced).toBe(1);
			expect(old.markedNotified).toBe(1);
			expect(notified()).toHaveLength(1);
		});

		test("dry run counts but writes nothing", () => {
			const report = importReformRows(db, [row()], { apply: false });
			expect(report.markedNotified).toBe(1);
			expect(notified()).toHaveLength(0);
		});
	});
});

describe("normalizeModelId", () => {
	test.each([
		["qwen3.8-27b", "qwen/qwen3.8-27b"],
		["Qwen3.8-27B", "qwen/qwen3.8-27b"],
		["qwen/qwen3.8-27b", "qwen/qwen3.8-27b"],
		["openai/gpt-6-luna", "openai/gpt-6-luna"],
		["openai/gpt-6-luna:batch", "openai/gpt-6-luna:batch"],
		["", ""],
		[undefined, ""],
		["local-model", "local-model"],
		["qwen3.8:27b-mlx", "qwen3.8:27b-mlx"],
	])("%p → %p", (input, expected) => {
		expect(normalizeModelId(input)).toBe(expected);
	});
});
