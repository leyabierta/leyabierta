import { describe, expect, test } from "bun:test";
import {
	extractCitations,
	jurisdictionFromSourceId,
	parseDgtDate,
} from "../src/adapters/util.ts";

describe("extractCitations", () => {
	test("extracts Ley with article", () => {
		const result = extractCitations("Ley 35/2006, Art. 7");
		expect(result.some((c) => c.includes("Ley") && c.includes("35/2006"))).toBe(
			true,
		);
	});

	test("extracts Real Decreto", () => {
		const result = extractCitations("Real Decreto 439/2007");
		expect(
			result.some((c) => c.includes("Real Decreto") && c.includes("439/2007")),
		).toBe(true);
	});

	test("extracts Ley Orgánica", () => {
		const result = extractCitations(
			"Ley Orgánica 1/1982, de 5 de mayo, de protección civil del derecho al honor",
		);
		expect(
			result.some((c) => c.includes("Ley Orgánica") && c.includes("1/1982")),
		).toBe(true);
	});

	test("deduplicates repeated citations", () => {
		const result = extractCitations("Ley 35/2006 y también Ley 35/2006");
		const count = result.filter((c) => c.includes("35/2006")).length;
		expect(count).toBe(1);
	});

	test("deduplicates citations that differ only by trailing punctuation", () => {
		const result = extractCitations("Ley 7/1994. y también Ley 7/1994");
		const count = result.filter((c) => c.includes("7/1994")).length;
		expect(count).toBe(1);
		// Result should not end with a period
		expect(result.find((c) => c.includes("7/1994"))).not.toMatch(/\.$/);
	});

	test("returns empty array for text with no citations", () => {
		const result = extractCitations("El cielo es azul y el mar es verde.");
		expect(result).toHaveLength(0);
	});

	test("extracts multiple different citations", () => {
		const result = extractCitations(
			"Según Ley 40/1998 y Real Decreto 214/1999, el contribuyente debe...",
		);
		expect(result.length).toBeGreaterThanOrEqual(2);
	});
});

describe("parseDgtDate", () => {
	test("parses DD/MM/YYYY correctly", () => {
		expect(parseDgtDate("10/01/2012")).toBe("2012-01-10");
	});

	test("parses end of year date", () => {
		expect(parseDgtDate("31/12/2023")).toBe("2023-12-31");
	});

	test("returns undefined for empty string", () => {
		expect(parseDgtDate("")).toBeUndefined();
	});

	test("returns undefined for invalid format", () => {
		expect(parseDgtDate("2012-01-10")).toBeUndefined();
		expect(parseDgtDate("10-01-2012")).toBeUndefined();
	});

	test("returns undefined for partial date", () => {
		expect(parseDgtDate("10/01")).toBeUndefined();
	});
});

describe("jurisdictionFromSourceId", () => {
	test("maps Ceuta bulletin", () => {
		expect(jurisdictionFromSourceId("Boletin_Oficial_Ceuta")).toBe("es-ce");
	});

	test("maps BOCCE prefix", () => {
		expect(jurisdictionFromSourceId("BOCCE-2003-Boletin-4272")).toBe("es-ce");
	});

	test("maps Andalusia BOJA", () => {
		expect(
			jurisdictionFromSourceId("Boletin_Oficial_Junta_Andalucia-BOJA-2016"),
		).toBe("es-an");
	});

	test("maps ParlaMint Andalusia", () => {
		expect(jurisdictionFromSourceId("ParlaMint-ES-AN-pleno-2016")).toBe(
			"es-an",
		);
	});

	test("returns undefined for unknown source", () => {
		expect(jurisdictionFromSourceId("Unknown_Source")).toBeUndefined();
	});

	test("returns undefined for empty string", () => {
		expect(jurisdictionFromSourceId("")).toBeUndefined();
	});
});
