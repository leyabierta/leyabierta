import { describe, expect, test } from "bun:test";
import { cohortOf } from "../lib.ts";

const O = "https://leyabierta.es";

describe("cohortOf", () => {
	test("splits reforms by URL form — that split is the experiment", () => {
		expect(cohortOf(`${O}/cambios/reforma/BOE-A-2026-1/2026-02-20/`)).toBe(
			"reforma-path",
		);
		expect(
			cohortOf(`${O}/cambios/reforma/?id=BOE-A-1978-31229&date=2024-02-17`),
		).toBe("reforma-query");
	});

	// The bare shell has no id/date, so it isn't a reform URL at all. Counting it
	// as treatment would dilute the cohort the experiment is measured on.
	test("the bare shell is not counted as treatment", () => {
		expect(cohortOf(`${O}/cambios/reforma/`)).toBe("otra");
		expect(cohortOf(`${O}/cambios/reforma/?from=law`)).toBe("otra");
	});

	test("laws and key pages keep their own cohorts", () => {
		expect(cohortOf(`${O}/leyes/BOE-A-1978-31229/`)).toBe("ley");
		expect(cohortOf(`${O}/pregunta/`)).toBe("clave");
		expect(cohortOf(`${O}/`)).toBe("clave");
		expect(cohortOf(`${O}/algo-que-no-listamos/`)).toBe("otra");
	});
});
