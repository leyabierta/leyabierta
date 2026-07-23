/**
 * Unit tests for isPlausibleReformDate / maxPlausibleReformDate.
 *
 * Motivated by a real production incident: the `reforms` table contains a
 * row with date `2929-11-19` sourced verbatim from the BOE feed. It passes
 * basic ISO format checks but is obvious garbage and contaminates
 * MAX(reforms.date) (see issue #129).
 */

import { describe, expect, test } from "bun:test";
import {
	isPlausibleReformDate,
	MIN_PLAUSIBLE_REFORM_DATE,
	maxPlausibleReformDate,
} from "../src/utils/date.ts";

const FIXED_NOW = new Date("2026-07-23T12:00:00Z");

describe("isPlausibleReformDate", () => {
	// ── Valid dates ──────────────────────────────────────────────────────

	test("accepts a normal recent reform date", () => {
		expect(isPlausibleReformDate("2026-07-18", FIXED_NOW)).toBe(true);
	});

	test("accepts the earliest allowed date", () => {
		expect(isPlausibleReformDate(MIN_PLAUSIBLE_REFORM_DATE, FIXED_NOW)).toBe(
			true,
		);
	});

	test("accepts a historical date (1978 Constitution)", () => {
		expect(isPlausibleReformDate("1978-12-29", FIXED_NOW)).toBe(true);
	});

	test("accepts a date up to 5 years in the future", () => {
		expect(isPlausibleReformDate("2031-07-23", FIXED_NOW)).toBe(true);
	});

	// ── The real corrupt-data incident ──────────────────────────────────

	test("rejects the known corrupt production date 2929-11-19", () => {
		expect(isPlausibleReformDate("2929-11-19", FIXED_NOW)).toBe(false);
	});

	// ── Out of range ─────────────────────────────────────────────────────

	test("rejects a date before 1800", () => {
		expect(isPlausibleReformDate("1799-12-31", FIXED_NOW)).toBe(false);
	});

	test("rejects a date more than 5 years in the future", () => {
		expect(isPlausibleReformDate("2032-01-01", FIXED_NOW)).toBe(false);
	});

	// ── Malformed / invalid calendar dates ───────────────────────────────

	test("rejects Feb 30", () => {
		expect(isPlausibleReformDate("2024-02-30", FIXED_NOW)).toBe(false);
	});

	test("rejects Feb 29 in a non-leap year", () => {
		expect(isPlausibleReformDate("2023-02-29", FIXED_NOW)).toBe(false);
	});

	test("rejects malformed string", () => {
		expect(isPlausibleReformDate("20260718", FIXED_NOW)).toBe(false);
	});

	test("rejects empty string", () => {
		expect(isPlausibleReformDate("", FIXED_NOW)).toBe(false);
	});

	test("rejects random text", () => {
		expect(isPlausibleReformDate("not-a-date", FIXED_NOW)).toBe(false);
	});
});

describe("maxPlausibleReformDate", () => {
	test("is exactly 5 years after `now`", () => {
		expect(maxPlausibleReformDate(FIXED_NOW)).toBe("2031-07-23");
	});
});
