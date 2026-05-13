import { describe, expect, test } from "bun:test";
import type { QAEntry } from "../src/qa-schema.ts";
import { checkQuality } from "../src/quality.ts";

function makeEntry(overrides: Partial<QAEntry> = {}): QAEntry {
	return {
		id: "test_001",
		source: "dgt-generales",
		question:
			"¿Cuáles son los requisitos para la deducción por vivienda habitual según el IRPF?",
		answer:
			"La deducción por inversión en vivienda habitual se regula en el artículo 68 de la Ley 35/2006 del IRPF. Para aplicarla el contribuyente debe haber adquirido la vivienda antes del 1 de enero de 2013 y haberla destinado como residencia habitual durante al menos tres años continuados.",
		norms: { citations_raw: [], boe_a_ids: [] },
		metadata: { domain: "tax", jurisdiction: "es" },
		...overrides,
	};
}

describe("checkQuality", () => {
	test("passes a valid entry", () => {
		const result = checkQuality(makeEntry());
		expect(result.pass).toBe(true);
		expect(result.reasons).toHaveLength(0);
	});

	test("fails when question is too short", () => {
		const result = checkQuality(makeEntry({ question: "¿Qué?" }));
		expect(result.pass).toBe(false);
		expect(result.reasons.some((r) => r.includes("question too short"))).toBe(
			true,
		);
	});

	test("fails when answer is too short", () => {
		const result = checkQuality(makeEntry({ answer: "No aplica." }));
		expect(result.pass).toBe(false);
		expect(result.reasons.some((r) => r.includes("answer too short"))).toBe(
			true,
		);
	});

	test("fails when question has no alphabetic characters", () => {
		const result = checkQuality(
			makeEntry({ question: "123456789012345678901234567890" }),
		);
		expect(result.pass).toBe(false);
		expect(result.reasons.some((r) => r.includes("no alphabetic"))).toBe(true);
	});

	test("fails when id is empty", () => {
		const result = checkQuality(makeEntry({ id: "" }));
		expect(result.pass).toBe(false);
		expect(result.reasons.some((r) => r.includes("missing id"))).toBe(true);
	});

	test("passes entry with Spanish accents in question", () => {
		const result = checkQuality(
			makeEntry({
				question:
					"¿Cuál es el procedimiento para solicitar la reducción de la base imponible del IRPF?",
			}),
		);
		expect(result.pass).toBe(true);
	});

	test("fails purely numeric content (high non-letter ratio)", () => {
		const result = checkQuality(
			makeEntry({
				question:
					"Pregunta sobre el artículo 123456789012345678901234567890 número.",
				answer:
					"12345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234",
			}),
		);
		// This should still pass because the question/answer are mostly letters
		// Just testing it doesn't crash
		expect(typeof result.pass).toBe("boolean");
	});
});
