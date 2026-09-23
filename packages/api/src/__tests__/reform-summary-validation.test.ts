import { describe, expect, test } from "bun:test";
import { validateReformSummary } from "../scripts/reform-summary-validation.ts";

const valid = {
	headline: "Sube el salario mínimo",
	summary:
		"El Gobierno actualiza la cuantía del salario mínimo interprofesional.",
	importance: "normal",
	reform_type: "modification",
};

describe("validateReformSummary", () => {
	test("accepts a well-formed summary", () => {
		const { result, reason } = validateReformSummary(valid);
		expect(reason).toBe("ok");
		expect(result?.headline).toBe(valid.headline);
	});

	test("rejects a blank headline (would otherwise be persisted and never retried)", () => {
		const { result, reason } = validateReformSummary({
			...valid,
			headline: "",
		});
		expect(result).toBeNull();
		expect(reason).toBe("empty headline or summary");
	});

	test("rejects a whitespace-only summary", () => {
		const { result } = validateReformSummary({ ...valid, summary: "   \n" });
		expect(result).toBeNull();
	});

	test("rejects blank text even for importance=skip", () => {
		const { result } = validateReformSummary({
			...valid,
			importance: "skip",
			headline: "",
			summary: "",
		});
		expect(result).toBeNull();
	});

	test("rejects unknown enums and non-objects", () => {
		expect(
			validateReformSummary({ ...valid, importance: "x" }).result,
		).toBeNull();
		expect(
			validateReformSummary({ ...valid, reform_type: "x" }).result,
		).toBeNull();
		expect(validateReformSummary(null).result).toBeNull();
	});

	test("truncates overlong fields instead of rejecting", () => {
		const { result } = validateReformSummary({
			...valid,
			headline: "a".repeat(150),
			summary: "b".repeat(600),
		});
		expect(result?.headline.length).toBe(100);
		expect(result?.summary.length).toBe(500);
	});

	test("rejects a language switch into another script (retried next run)", () => {
		for (const over of [
			{ headline: "Sube el salario mínimo军事" },
			{ summary: "El Gobierno actualiza la cuantía кредит." },
		]) {
			const { result, reason } = validateReformSummary({ ...valid, ...over });
			expect(result).toBeNull();
			expect(reason).toBe("foreign script (model switched language)");
		}
	});
});
