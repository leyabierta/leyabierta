import { describe, expect, test } from "bun:test";
import { parseLawCitizenMetadata } from "../src/scripts/citizen-tags-validation.ts";

describe("parseLawCitizenMetadata", () => {
	test("accepts a valid response and trims fields", () => {
		const r = parseLawCitizenMetadata(
			JSON.stringify({
				citizen_tags: [" pensión viudedad ", "", 3],
				citizen_summary: "  Regula las pensiones de la Seguridad Social. ",
			}),
		);
		expect(r).toEqual({
			citizen_tags: ["pensión viudedad"],
			citizen_summary: "Regula las pensiones de la Seguridad Social.",
		});
	});

	test("rejects an empty citizen_summary (norm would be re-selected every run)", () => {
		expect(
			parseLawCitizenMetadata(
				JSON.stringify({ citizen_tags: ["x"], citizen_summary: "" }),
			),
		).toBeNull();
		expect(
			parseLawCitizenMetadata(
				JSON.stringify({ citizen_tags: ["x"], citizen_summary: "  " }),
			),
		).toBeNull();
		expect(
			parseLawCitizenMetadata(JSON.stringify({ citizen_tags: [] })),
		).toBeNull();
	});

	test("rejects invalid JSON and non-objects", () => {
		expect(parseLawCitizenMetadata("not json")).toBeNull();
		expect(parseLawCitizenMetadata("null")).toBeNull();
		expect(parseLawCitizenMetadata('"text"')).toBeNull();
	});

	test("tolerates missing tags", () => {
		expect(
			parseLawCitizenMetadata(JSON.stringify({ citizen_summary: "Resumen." })),
		).toEqual({ citizen_tags: [], citizen_summary: "Resumen." });
	});
});
