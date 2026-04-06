/**
 * Unit tests for isValidISODate.
 */

import { describe, expect, test } from "bun:test";
import { isValidISODate } from "../routes/laws.ts";

describe("isValidISODate", () => {
	// ── Valid dates ──────────────────────────────────────────────────────

	test("accepts standard ISO date", () => {
		expect(isValidISODate("2024-01-15")).toBe(true);
	});

	test("accepts leap year Feb 29", () => {
		expect(isValidISODate("2024-02-29")).toBe(true);
	});

	test("accepts first day of year", () => {
		expect(isValidISODate("2024-01-01")).toBe(true);
	});

	test("accepts last day of year", () => {
		expect(isValidISODate("2024-12-31")).toBe(true);
	});

	test("accepts historical date (1835)", () => {
		expect(isValidISODate("1835-07-04")).toBe(true);
	});

	test("accepts recent date", () => {
		expect(isValidISODate("2026-04-06")).toBe(true);
	});

	// ── Invalid calendar dates ──────────────────────────────────────────

	test("rejects Feb 30", () => {
		expect(isValidISODate("2024-02-30")).toBe(false);
	});

	test("rejects Feb 29 in non-leap year", () => {
		expect(isValidISODate("2023-02-29")).toBe(false);
	});

	test("rejects month 13", () => {
		expect(isValidISODate("2024-13-01")).toBe(false);
	});

	test("rejects month 00", () => {
		expect(isValidISODate("2024-00-15")).toBe(false);
	});

	test("rejects day 32", () => {
		expect(isValidISODate("2024-01-32")).toBe(false);
	});

	test("rejects day 00", () => {
		expect(isValidISODate("2024-01-00")).toBe(false);
	});

	test("rejects April 31 (30-day month)", () => {
		expect(isValidISODate("2024-04-31")).toBe(false);
	});

	test("rejects month 99", () => {
		expect(isValidISODate("2024-99-01")).toBe(false);
	});

	// ── Malformed strings ───────────────────────────────────────────────

	test("rejects empty string", () => {
		expect(isValidISODate("")).toBe(false);
	});

	test("rejects random text", () => {
		expect(isValidISODate("not-a-date")).toBe(false);
	});

	test("rejects datetime (too long)", () => {
		expect(isValidISODate("2024-01-15T00:00:00Z")).toBe(false);
	});

	test("rejects short format YYYYMMDD", () => {
		expect(isValidISODate("20240115")).toBe(false);
	});

	test("rejects slash format", () => {
		expect(isValidISODate("2024/01/15")).toBe(false);
	});

	test("rejects partial date", () => {
		expect(isValidISODate("2024-01")).toBe(false);
	});

	test("rejects year only", () => {
		expect(isValidISODate("2024")).toBe(false);
	});

	// ── Potential injection payloads ─────────────────────────────────────

	test("rejects SQL injection attempt", () => {
		expect(isValidISODate("2024-01-01' OR 1=1--")).toBe(false);
	});

	test("rejects command injection attempt", () => {
		expect(isValidISODate("$(whoami)")).toBe(false);
	});

	test("rejects path traversal", () => {
		expect(isValidISODate("../../etc/passwd")).toBe(false);
	});
});
