/**
 * Tests for the jurisdictions module — single source of truth for Spanish
 * ELI codes and norm path parsing.
 */

import { describe, expect, test } from "bun:test";
import {
	isSpainJurisdiction,
	parseNormPath,
	SPAIN_JURISDICTION_CODES,
} from "../src/spain/jurisdictions.ts";

describe("SPAIN_JURISDICTION_CODES", () => {
	test("contains exactly the 18 expected jurisdictions", () => {
		expect([...SPAIN_JURISDICTION_CODES].sort()).toEqual([
			"es",
			"es-an",
			"es-ar",
			"es-as",
			"es-cb",
			"es-cl",
			"es-cm",
			"es-cn",
			"es-ct",
			"es-ex",
			"es-ga",
			"es-ib",
			"es-mc",
			"es-md",
			"es-nc",
			"es-pv",
			"es-ri",
			"es-vc",
		]);
	});
});

describe("isSpainJurisdiction", () => {
	test("accepts all canonical codes", () => {
		for (const code of SPAIN_JURISDICTION_CODES) {
			expect(isSpainJurisdiction(code)).toBe(true);
		}
	});

	test("rejects non-Spanish codes", () => {
		expect(isSpainJurisdiction("fr")).toBe(false);
		expect(isSpainJurisdiction("de")).toBe(false);
		expect(isSpainJurisdiction("es-xx")).toBe(false);
		expect(isSpainJurisdiction("ES")).toBe(false);
		expect(isSpainJurisdiction("")).toBe(false);
	});
});

describe("parseNormPath", () => {
	test("parses a state-level BOE path", () => {
		expect(parseNormPath("es/BOE-A-1978-31229.md")).toEqual({
			jurisdiction: "es",
			normId: "BOE-A-1978-31229",
		});
	});

	test("parses an autonomous community path", () => {
		expect(parseNormPath("es-an/BOE-A-2026-7558.md")).toEqual({
			jurisdiction: "es-an",
			normId: "BOE-A-2026-7558",
		});
	});

	test("parses a regional bulletin path (BOA)", () => {
		expect(parseNormPath("es-ar/BOA-d-1991-90001.md")).toEqual({
			jurisdiction: "es-ar",
			normId: "BOA-d-1991-90001",
		});
	});

	test("parses a País Vasco bulletin path (BOPV)", () => {
		expect(parseNormPath("es-pv/BOPV-2014-1234.md")).toEqual({
			jurisdiction: "es-pv",
			normId: "BOPV-2014-1234",
		});
	});

	test("rejects README.md and other non-norm filenames", () => {
		expect(parseNormPath("es/README.md")).toBeNull();
		expect(parseNormPath("es-an/README.md")).toBeNull();
		expect(parseNormPath("es/.gitignore")).toBeNull();
		expect(parseNormPath("es/index.md")).toBeNull();
		expect(parseNormPath("es/notes.md")).toBeNull();
	});

	test("rejects paths in unknown jurisdictions", () => {
		expect(parseNormPath("fr/BOE-A-1978-31229.md")).toBeNull();
		expect(parseNormPath("es-xx/BOE-A-1978-31229.md")).toBeNull();
		expect(parseNormPath("foo/BOE-A-1978-31229.md")).toBeNull();
	});

	test("rejects nested paths", () => {
		expect(parseNormPath("es/sub/BOE-A-1978-31229.md")).toBeNull();
		expect(parseNormPath("es-an/2026/BOE-A-2026-7558.md")).toBeNull();
	});

	test("rejects bare filenames without a jurisdiction folder", () => {
		expect(parseNormPath("BOE-A-1978-31229.md")).toBeNull();
		expect(parseNormPath("/BOE-A-1978-31229.md")).toBeNull();
	});

	test("rejects non-.md extensions", () => {
		expect(parseNormPath("es/BOE-A-1978-31229.txt")).toBeNull();
		expect(parseNormPath("es/BOE-A-1978-31229.json")).toBeNull();
		expect(parseNormPath("es/BOE-A-1978-31229")).toBeNull();
	});

	test("rejects ids without a year-and-number tail", () => {
		expect(parseNormPath("es/BOE-A.md")).toBeNull();
		expect(parseNormPath("es/BOE-A-foo.md")).toBeNull();
		expect(parseNormPath("es/foo-2026-1.md")).toBeNull(); // lowercase prefix
		expect(parseNormPath("es/BOE-A-26-1.md")).toBeNull(); // 2-digit year
		expect(parseNormPath("es/BOE-A-2026-.md")).toBeNull(); // empty number
	});

	test("accepts ids with multi-segment middle parts", () => {
		// Real shapes seen in the BOE catalog: BOC-j-2020-90088 (Cantabria)
		expect(parseNormPath("es-cb/BOC-j-2020-90088.md")).toEqual({
			jurisdiction: "es-cb",
			normId: "BOC-j-2020-90088",
		});
	});
});
