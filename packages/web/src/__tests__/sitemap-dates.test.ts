import { describe, expect, test } from "bun:test";
import { clampLastmod, isPlausibleReformDate } from "../lib/sitemap-dates.ts";

const MAX_YEAR = 2027;

describe("isPlausibleReformDate", () => {
	test("accepts real dates in range", () => {
		expect(isPlausibleReformDate("1978-12-29", MAX_YEAR)).toBe(true);
		expect(isPlausibleReformDate("2024-02-17", MAX_YEAR)).toBe(true);
		expect(isPlausibleReformDate("1835-01-01", MAX_YEAR)).toBe(true);
	});

	test("rejects the corrupt year-2929 pipeline bug", () => {
		expect(isPlausibleReformDate("2929-11-19", MAX_YEAR)).toBe(false);
	});

	test("rejects out-of-range years", () => {
		expect(isPlausibleReformDate("1799-12-31", MAX_YEAR)).toBe(false);
		expect(isPlausibleReformDate("3000-01-01", MAX_YEAR)).toBe(false);
	});

	test("rejects malformed shapes and non-dates", () => {
		expect(isPlausibleReformDate("2024-2-1", MAX_YEAR)).toBe(false);
		expect(isPlausibleReformDate("not-a-date", MAX_YEAR)).toBe(false);
		expect(isPlausibleReformDate("", MAX_YEAR)).toBe(false);
	});

	test("rejects calendar rollovers Date silently normalizes", () => {
		expect(isPlausibleReformDate("2024-02-30", MAX_YEAR)).toBe(false);
		expect(isPlausibleReformDate("2024-13-01", MAX_YEAR)).toBe(false);
	});
});

describe("clampLastmod", () => {
	test("passes through past dates unchanged", () => {
		expect(clampLastmod("2020-05-01", "2026-07-22")).toBe("2020-05-01");
	});

	test("clamps future dates to today", () => {
		expect(clampLastmod("2027-01-01", "2026-07-22")).toBe("2026-07-22");
	});
});
