import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	extractReforms,
	getBlockAtDate,
	parseTextXml,
} from "../src/transform/xml-parser.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

function loadFixture(name: string): Uint8Array {
	return readFileSync(join(FIXTURES_DIR, name));
}

describe("parseTextXml", () => {
	const xml = loadFixture("constitucion-sample.xml");
	const blocks = parseTextXml(xml);

	test("parses all blocks from the Constitution", () => {
		expect(blocks.length).toBe(17);
	});

	test("extracts block attributes", () => {
		const art1 = blocks.find((b) => b.id === "a1");
		expect(art1).toBeDefined();
		expect(art1!.type).toBe("precepto");
		expect(art1!.title).toBe("Artículo 1");
	});

	test("parses version dates from YYYYMMDD format", () => {
		const art1 = blocks.find((b) => b.id === "a1")!;
		expect(art1.versions).toHaveLength(1);
		expect(art1.versions[0]!.publishedAt).toBe("1978-12-29");
	});

	test("parses multiple versions of an article", () => {
		const art13 = blocks.find((b) => b.id === "a13")!;
		expect(art13.versions).toHaveLength(2);
		expect(art13.versions[0]!.publishedAt).toBe("1978-12-29");
		expect(art13.versions[1]!.publishedAt).toBe("1992-08-28");
	});

	test("extracts paragraphs with css classes", () => {
		const art1 = blocks.find((b) => b.id === "a1")!;
		const paragraphs = art1.versions[0]!.paragraphs;
		expect(paragraphs[0]!.cssClass).toBe("articulo");
		expect(paragraphs[0]!.text).toBe("Artículo 1");
		expect(paragraphs[1]!.cssClass).toBe("parrafo");
	});

	test("skips footnotes (nota_pie)", () => {
		const art13 = blocks.find((b) => b.id === "a13")!;
		const v2 = art13.versions[1]!;
		const classes = v2.paragraphs.map((p) => p.cssClass);
		expect(classes).not.toContain("nota_pie");
	});
});

describe("extractReforms", () => {
	const xml = loadFixture("constitucion-sample.xml");
	const blocks = parseTextXml(xml);
	const reforms = extractReforms(blocks);

	test("extracts 4 reforms chronologically", () => {
		expect(reforms).toHaveLength(4);
		expect(reforms.map((r) => r.date)).toEqual([
			"1978-12-29",
			"1992-08-28",
			"2011-09-27",
			"2024-02-17",
		]);
	});

	test("tracks affected block IDs", () => {
		const reform1992 = reforms.find((r) => r.date === "1992-08-28")!;
		expect(reform1992.affectedBlockIds).toContain("a13");
	});

	test("first reform affects all original blocks", () => {
		const first = reforms[0]!;
		expect(first.affectedBlockIds.length).toBeGreaterThan(10);
	});
});

describe("getBlockAtDate", () => {
	const xml = loadFixture("constitucion-sample.xml");
	const blocks = parseTextXml(xml);
	const art13 = blocks.find((b) => b.id === "a13")!;

	test("returns original version before reform", () => {
		const version = getBlockAtDate(art13, "1990-01-01");
		expect(version).toBeDefined();
		expect(version!.publishedAt).toBe("1978-12-29");
		expect(
			version!.paragraphs.some((p) => p.text.includes("sufragio activo en")),
		).toBe(true);
	});

	test("returns reformed version after reform date", () => {
		const version = getBlockAtDate(art13, "2000-01-01");
		expect(version).toBeDefined();
		expect(version!.publishedAt).toBe("1992-08-28");
		expect(
			version!.paragraphs.some((p) =>
				p.text.includes("sufragio activo y pasivo"),
			),
		).toBe(true);
	});

	test("returns undefined before any version exists", () => {
		const version = getBlockAtDate(art13, "1970-01-01");
		expect(version).toBeUndefined();
	});
});

describe("normalizeWhitespace via <br><br>", () => {
	// Regression test for review finding on PR #67: the previous regex
	// `/\s*\n\s*/g` collapsed `\n\n` to `\n`, because `\s` matches `\n`. A
	// paragraph with two consecutive <br> elements produces "...\n\n..." inside
	// renderInlineNodes; downstream code (reforma.astro diff renderer) splits
	// on `\n\n` so the collapse silently merged paragraph breaks.
	const xml = new TextEncoder().encode(`<?xml version="1.0" encoding="utf-8"?>
<response>
  <data>
    <texto>
      <bloque id="a1" tipo="precepto" titulo="Artículo 1">
        <version id_norma="BOE-A-TEST" fecha_publicacion="20240101" fecha_vigencia="20240101">
          <p class="parrafo">First line.<br/><br/>Second line.</p>
        </version>
      </bloque>
    </texto>
  </data>
</response>`);

	test("preserves \\n\\n produced by consecutive <br> elements", () => {
		const blocks = parseTextXml(xml);
		const text = blocks[0]!.versions[0]!.paragraphs[0]!.text;
		expect(text).toBe("First line.\n\nSecond line.");
	});
});
