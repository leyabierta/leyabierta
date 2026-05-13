import { describe, expect, test } from "bun:test";
import { EvalEntrySchema, QAEntrySchema } from "../src/qa-schema.ts";

const validQA = {
	id: "dgt-generales_0001-00",
	source: "dgt-generales",
	question:
		"¿Cuáles son los requisitos para la deducción por vivienda habitual?",
	answer:
		"La deducción por inversión en vivienda habitual se regula en el artículo 68 de la Ley 35/2006 del IRPF. Para aplicarla el contribuyente debe haber adquirido la vivienda antes del 1 de enero de 2013 y haberla destinado como residencia habitual durante un plazo continuado de al menos tres años.",
	norms: { citations_raw: ["Ley 35/2006, Art. 68"], boe_a_ids: [] },
	metadata: { domain: "tax", jurisdiction: "es" },
};

const validEval = {
	id: "eval_dgt_0001-00",
	source: "dgt-generales",
	question:
		"¿Cuáles son los requisitos para la deducción por vivienda habitual?",
	expected_norm_ids: ["BOE-A-2006-20764"],
	expected_articles: ["Artículo 68"],
	domain: "tax",
};

describe("QAEntrySchema", () => {
	test("accepts valid entry", () => {
		const result = QAEntrySchema.safeParse(validQA);
		expect(result.success).toBe(true);
	});

	test("rejects missing id", () => {
		const result = QAEntrySchema.safeParse({ ...validQA, id: "" });
		expect(result.success).toBe(false);
	});

	test("rejects missing question", () => {
		const result = QAEntrySchema.safeParse({ ...validQA, question: "" });
		expect(result.success).toBe(false);
	});

	test("rejects missing answer", () => {
		const result = QAEntrySchema.safeParse({ ...validQA, answer: "" });
		expect(result.success).toBe(false);
	});

	test("rejects invalid source", () => {
		const result = QAEntrySchema.safeParse({
			...validQA,
			source: "unknown-source",
		});
		expect(result.success).toBe(false);
	});

	test("rejects missing norms field", () => {
		const { norms: _n, ...rest } = validQA;
		const result = QAEntrySchema.safeParse(rest);
		expect(result.success).toBe(false);
	});

	test("accepts optional context as undefined", () => {
		const result = QAEntrySchema.safeParse({ ...validQA, context: undefined });
		expect(result.success).toBe(true);
	});

	test("accepts all valid sources", () => {
		const sources = [
			"dgt-generales",
			"dgt-vinculantes",
			"sinai-cqa-boja",
			"sinai-cqa-parlamint",
			"refugiados",
			"divorce",
			"sinai-triplets",
		];
		for (const source of sources) {
			const result = QAEntrySchema.safeParse({ ...validQA, source });
			expect(result.success).toBe(true);
		}
	});
});

describe("EvalEntrySchema", () => {
	test("accepts valid eval entry", () => {
		const result = EvalEntrySchema.safeParse(validEval);
		expect(result.success).toBe(true);
	});

	test("rejects missing id", () => {
		const result = EvalEntrySchema.safeParse({ ...validEval, id: "" });
		expect(result.success).toBe(false);
	});

	test("rejects missing question", () => {
		const result = EvalEntrySchema.safeParse({ ...validEval, question: "" });
		expect(result.success).toBe(false);
	});

	test("rejects wrong type for expected_norm_ids", () => {
		const result = EvalEntrySchema.safeParse({
			...validEval,
			expected_norm_ids: "not-an-array",
		});
		expect(result.success).toBe(false);
	});

	test("accepts optional domain as undefined", () => {
		const { domain: _d, ...rest } = validEval;
		const result = EvalEntrySchema.safeParse(rest);
		expect(result.success).toBe(true);
	});
});
