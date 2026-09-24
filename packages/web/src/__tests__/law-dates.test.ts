import { describe, expect, test } from "bun:test";
import { effectiveLastUpdated, todayIso } from "../lib/law-dates.ts";

const TODAY = "2026-09-23";

describe("effectiveLastUpdated", () => {
	// Estatuto de los Trabajadores (BOE-A-2015-11430): the frontmatter said
	// 2023-03-01 while its reforms list ran to 2025-12-04.
	test("uses the latest reform when ultima_actualizacion lags behind", () => {
		expect(
			effectiveLastUpdated(
				{
					ultima_actualizacion: "2023-03-01",
					reformas: [
						{ fecha: "2015-10-24" },
						{ fecha: "2025-07-30" },
						{ fecha: "2025-12-04" },
						{ fecha: "2023-03-01" },
					],
				},
				TODAY,
			),
		).toBe("2025-12-04");
	});

	test("keeps ultima_actualizacion when it is the latest date", () => {
		expect(
			effectiveLastUpdated(
				{
					ultima_actualizacion: "2024-06-01",
					reformas: [{ fecha: "2020-01-01" }],
				},
				TODAY,
			),
		).toBe("2024-06-01");
	});

	// BOE-A-1985-26400: the BOE ships fecha_publicacion="29291119".
	test("ignores future dates, including the year-2929 BOE typo", () => {
		expect(
			effectiveLastUpdated(
				{
					ultima_actualizacion: "2929-11-19",
					reformas: [
						{ fecha: "1985-12-03" },
						{ fecha: "2016-05-11" },
						{ fecha: "2929-11-19" },
					],
				},
				TODAY,
			),
		).toBe("2016-05-11");
		expect(
			effectiveLastUpdated(
				{ ultima_actualizacion: "2026-09-24", reformas: [] },
				TODAY,
			),
		).toBeUndefined();
	});

	test("accepts today itself", () => {
		expect(effectiveLastUpdated({ ultima_actualizacion: TODAY }, TODAY)).toBe(
			TODAY,
		);
	});

	test("ignores malformed and impossible dates", () => {
		expect(
			effectiveLastUpdated(
				{
					ultima_actualizacion: "2024-02-30",
					reformas: [{ fecha: "not-a-date" }, { fecha: "1990-05-05" }],
				},
				TODAY,
			),
		).toBe("1990-05-05");
	});

	test("keeps old but real dates (pre-1970 is valid data)", () => {
		expect(
			effectiveLastUpdated(
				{ ultima_actualizacion: "1909-02-08", reformas: [] },
				TODAY,
			),
		).toBe("1909-02-08");
	});

	test("returns undefined when nothing is usable", () => {
		expect(effectiveLastUpdated({}, TODAY)).toBeUndefined();
		expect(
			effectiveLastUpdated({ ultima_actualizacion: "" }, TODAY),
		).toBeUndefined();
	});
});

describe("todayIso", () => {
	test("formats the Europe/Madrid calendar day as YYYY-MM-DD", () => {
		// 23:30 UTC in September is already 01:30 of the next day in Madrid.
		expect(todayIso(new Date("2026-09-23T23:30:00Z"))).toBe("2026-09-24");
		expect(todayIso(new Date("2026-09-23T21:30:00Z"))).toBe("2026-09-23");
		// Winter (UTC+1).
		expect(todayIso(new Date("2026-01-15T22:59:00Z"))).toBe("2026-01-15");
	});
});
