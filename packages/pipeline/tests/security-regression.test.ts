/**
 * Regression tests for CodeQL security fixes.
 *
 * These tests capture the exact behavior of functions BEFORE
 * the security fixes, so we can verify the fixes don't change output.
 */

import { describe, expect, test } from "bun:test";
import type { Block, NormMetadata } from "../src/models.ts";
import { renderFrontmatter } from "../src/transform/frontmatter.ts";
import { renderNormAtDate } from "../src/transform/markdown.ts";
import { lintMarkdown } from "../src/transform/markdown-linter.ts";
import { parseTextXml } from "../src/transform/xml-parser.ts";

// ─── Helpers ───

function makeMetadata(overrides: Partial<NormMetadata> = {}): NormMetadata {
	return {
		title: "Constitución Española",
		shortTitle: "Constitución Española",
		id: "BOE-A-1978-31229",
		country: "es",
		rank: "constitucion",
		publishedAt: "1978-12-29",
		status: "vigente",
		department: "Cortes Generales",
		source: "https://www.boe.es/eli/es/c/1978/12/27/(1)",
		...overrides,
	};
}

const EMPTY_BLOCKS: Block[] = [];

const VALID_FRONTMATTER = `---
title: "Test Law"
id: "BOE-A-2024-1234"
country: "es"
rank: "ley"
published: "2024-01-01"
status: "vigente"
source: "https://boe.es"
---`;

function doc(body: string): string {
	return `${VALID_FRONTMATTER}\n# Test Law\n\n${body}`;
}

// ─── #7, #9: cleanTitle ReDoS ───

describe("cleanTitle regression (alerts #7, #9)", () => {
	test("strips trailing dots and spaces", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: "Ley de Aguas. . " }),
			"2024-01-01",
			[],
			EMPTY_BLOCKS,
		);
		expect(result).toContain("titulo: Ley de Aguas\n");
		expect(result).not.toContain("Aguas.");
		expect(result).not.toContain("Aguas ");
	});

	test("strips trailing dots only", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: "Ley de Aguas..." }),
			"2024-01-01",
			[],
			EMPTY_BLOCKS,
		);
		expect(result).toContain("titulo: Ley de Aguas");
	});

	test("strips trailing spaces only", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: "Ley de Aguas   " }),
			"2024-01-01",
			[],
			EMPTY_BLOCKS,
		);
		expect(result).toContain("titulo: Ley de Aguas");
	});

	test("preserves title without trailing junk", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: "Constitución Española" }),
			"2024-01-01",
			[],
			EMPTY_BLOCKS,
		);
		expect(result).toContain("titulo: Constitución Española");
	});

	test("handles mixed trailing dots and spaces", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: "Código Penal .  . " }),
			"2024-01-01",
			[],
			EMPTY_BLOCKS,
		);
		expect(result).toContain("titulo: Código Penal");
	});

	test("title in H1 is also cleaned (markdown.ts)", () => {
		const blocks: Block[] = [
			{
				id: "a1",
				type: "precepto",
				title: "Art 1",
				versions: [
					{
						normId: "BOE-A-1978-31229",
						publishedAt: "1978-12-29",
						effectiveAt: "1978-12-29",
						paragraphs: [{ cssClass: "parrafo", text: "Texto." }],
					},
				],
			},
		];
		const md = renderNormAtDate(
			makeMetadata({ title: "Ley de Aguas. . " }),
			blocks,
			"1978-12-29",
		);
		expect(md).toContain("# Ley de Aguas\n");
		expect(md).not.toContain("# Ley de Aguas.");
	});

	test("does not hang on pathological input", () => {
		// This is the actual ReDoS concern: many trailing spaces+dots
		const evilTitle = `Ley${" .".repeat(1000)}`;
		const start = performance.now();
		const result = renderFrontmatter(
			makeMetadata({ title: evilTitle }),
			"2024-01-01",
			[],
			EMPTY_BLOCKS,
		);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(100); // Should be <1ms, 100ms is generous
		expect(result).toContain("titulo: Ley");
	});
});

// ─── #8: checkHtmlTags image stripping ReDoS ───

describe("checkHtmlTags image stripping regression (alert #8)", () => {
	test("strips markdown images before checking for HTML", () => {
		const issues = lintMarkdown(
			doc("See ![diagram](https://example.com/img.png) for details."),
		);
		expect(issues.filter((i) => i.rule === "no-html-tags")).toHaveLength(0);
	});

	test("still detects HTML tags after stripping images", () => {
		const issues = lintMarkdown(
			doc("![img](url) and also <strong>bold</strong> text."),
		);
		expect(issues.some((i) => i.rule === "no-html-tags")).toBe(true);
	});

	test("handles multiple images on one line", () => {
		const issues = lintMarkdown(doc("![a](url1) text ![b](url2) more text"));
		expect(issues.filter((i) => i.rule === "no-html-tags")).toHaveLength(0);
	});

	test("handles image with complex alt text", () => {
		const issues = lintMarkdown(
			doc("![alt text with spaces and (parens)](https://example.com/img.png)"),
		);
		expect(issues.filter((i) => i.rule === "no-html-tags")).toHaveLength(0);
	});

	test("does not hang on pathological input", () => {
		// Nested brackets/parens that could cause backtracking
		const evil = `![${"]".repeat(500)}](${")".repeat(500)})`;
		const start = performance.now();
		lintMarkdown(doc(evil));
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(500);
	});
});

// ─── #5: decodeEntities double escaping ───

describe("decodeEntities regression (alert #5)", () => {
	test("decodes basic HTML entities", () => {
		const xml = `
<bloque id="t1" tipo="titulo" titulo="Test">
  <version id_norma="X" fecha_publicacion="20240101">
    <p class="parrafo">one &amp; two</p>
  </version>
</bloque>`;
		const blocks = parseTextXml(new TextEncoder().encode(xml));
		const text = blocks[0]!.versions[0]!.paragraphs[0]!.text;
		expect(text).toBe("one & two");
	});

	test("decodes &lt; and &gt;", () => {
		const xml = `
<bloque id="t1" tipo="titulo" titulo="Test">
  <version id_norma="X" fecha_publicacion="20240101">
    <p class="parrafo">a &lt; b &gt; c</p>
  </version>
</bloque>`;
		const blocks = parseTextXml(new TextEncoder().encode(xml));
		const text = blocks[0]!.versions[0]!.paragraphs[0]!.text;
		expect(text).toBe("a < b > c");
	});

	test("decodes numeric entities", () => {
		const xml = `
<bloque id="t1" tipo="titulo" titulo="Test">
  <version id_norma="X" fecha_publicacion="20240101">
    <p class="parrafo">&#169; &#x20AC;</p>
  </version>
</bloque>`;
		const blocks = parseTextXml(new TextEncoder().encode(xml));
		const text = blocks[0]!.versions[0]!.paragraphs[0]!.text;
		expect(text).toBe("© €");
	});

	test("does NOT double-decode &amp;lt; into <", () => {
		// Bug: &amp;lt; → & (step1: &amp;→&) → then &lt;→< (step2)
		// Fix: single-pass decode so &amp;lt; → &lt; (only one level)
		const xml = `
<bloque id="t1" tipo="titulo" titulo="Test">
  <version id_norma="X" fecha_publicacion="20240101">
    <p class="parrafo">&amp;lt;script&amp;gt;</p>
  </version>
</bloque>`;
		const blocks = parseTextXml(new TextEncoder().encode(xml));
		const text = blocks[0]!.versions[0]!.paragraphs[0]!.text;
		expect(text).toBe("&lt;script&gt;");
	});

	test("does NOT double-decode &amp;amp; into &", () => {
		const xml = `
<bloque id="t1" tipo="titulo" titulo="Test">
  <version id_norma="X" fecha_publicacion="20240101">
    <p class="parrafo">&amp;amp; test</p>
  </version>
</bloque>`;
		const blocks = parseTextXml(new TextEncoder().encode(xml));
		const text = blocks[0]!.versions[0]!.paragraphs[0]!.text;
		expect(text).toBe("&amp; test");
	});

	test("decodes &nbsp; to space", () => {
		const xml = `
<bloque id="t1" tipo="titulo" titulo="Test">
  <version id_norma="X" fecha_publicacion="20240101">
    <p class="parrafo">hello&nbsp;world</p>
  </version>
</bloque>`;
		const blocks = parseTextXml(new TextEncoder().encode(xml));
		const text = blocks[0]!.versions[0]!.paragraphs[0]!.text;
		expect(text).toBe("hello world");
	});
});

// ─── #6: table cell sanitization ───

describe("tableToMarkdown sanitization regression (alert #6)", () => {
	test("escapes pipe characters in cells", () => {
		const xml = `
<bloque id="t1" tipo="titulo" titulo="Test">
  <version id_norma="X" fecha_publicacion="20240101">
    <table>
      <tr><th>A</th><th>B</th></tr>
      <tr><td>val|ue</td><td>normal</td></tr>
    </table>
  </version>
</bloque>`;
		const blocks = parseTextXml(new TextEncoder().encode(xml));
		const tableParagraph = blocks[0]!.versions[0]!.paragraphs.find(
			(p) => p.cssClass === "__table",
		);
		expect(tableParagraph).toBeDefined();
		expect(tableParagraph!.text).toContain("val\\|ue");
	});

	test("replaces newlines in cells with spaces", () => {
		const xml = `
<bloque id="t1" tipo="titulo" titulo="Test">
  <version id_norma="X" fecha_publicacion="20240101">
    <table>
      <tr><th>Header</th></tr>
      <tr><td>line1
line2</td></tr>
    </table>
  </version>
</bloque>`;
		const blocks = parseTextXml(new TextEncoder().encode(xml));
		const tableParagraph = blocks[0]!.versions[0]!.paragraphs.find(
			(p) => p.cssClass === "__table",
		);
		expect(tableParagraph).toBeDefined();
		expect(tableParagraph!.text).not.toContain("\n line2");
		expect(tableParagraph!.text).toContain("line1");
		expect(tableParagraph!.text).toContain("line2");
	});

	test("escapes multiple pipes in one cell", () => {
		const xml = `
<bloque id="t1" tipo="titulo" titulo="Test">
  <version id_norma="X" fecha_publicacion="20240101">
    <table>
      <tr><th>H</th></tr>
      <tr><td>a|b|c</td></tr>
    </table>
  </version>
</bloque>`;
		const blocks = parseTextXml(new TextEncoder().encode(xml));
		const tableParagraph = blocks[0]!.versions[0]!.paragraphs.find(
			(p) => p.cssClass === "__table",
		);
		expect(tableParagraph!.text).toContain("a\\|b\\|c");
	});
});
