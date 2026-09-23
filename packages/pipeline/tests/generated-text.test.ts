import { describe, expect, test } from "bun:test";
import { parseLawCitizenMetadata } from "../src/scripts/citizen-tags-validation.ts";
import { hasForeignScript } from "../src/utils/generated-text.ts";

describe("hasForeignScript", () => {
	test.each([
		// Real fragments from production summaries (2026-09).
		"…entre el 1 de enero de 1976 y esa fecha por servicio军事.",
		"…Puede realizar кредит",
		"…se prohíbe el trabajo nocturno a menores de 18 y se要求",
		"texto con カタカナ",
		"texto con 한국어",
		"texto con عربي",
		"texto con ภาษาไทย",
	])("rejects %p", (text) => {
		expect(hasForeignScript(text)).toBe(true);
	});

	test.each([
		"Plazo de 15 días hábiles (art. 23.2); pérdidas <50 % del capital.",
		"El parámetro α se fija en 0,5 €/kWh — «según el anexo».",
		"Pingüino, ñandú, ÀÉÎÕÜ, l·l, ç: español, catalán y gallego.",
		"Criterios Common Criteria (CC), ISO/IEC 15408 y ITSEC.",
	])("accepts %p", (text) => {
		expect(hasForeignScript(text)).toBe(false);
	});

	test("checks every text it is given", () => {
		expect(hasForeignScript("bien", "también bien")).toBe(false);
		expect(hasForeignScript("bien", "mal军事")).toBe(true);
	});
});

describe("parseLawCitizenMetadata", () => {
	test("rejects a law summary or tag in another script (retried next run)", () => {
		expect(
			parseLawCitizenMetadata(
				JSON.stringify({
					citizen_tags: ["pensiones"],
					citizen_summary: "Regula las pensiones军事.",
				}),
			),
		).toBeNull();
		expect(
			parseLawCitizenMetadata(
				JSON.stringify({
					citizen_tags: ["pensiones", "军事"],
					citizen_summary: "Regula las pensiones.",
				}),
			),
		).toBeNull();
	});
});
