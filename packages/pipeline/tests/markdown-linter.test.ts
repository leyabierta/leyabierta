import { describe, expect, test } from "bun:test";
import { lintMarkdown } from "../src/transform/markdown-linter.ts";

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

describe("valid-frontmatter", () => {
	test("passes with valid frontmatter", () => {
		const issues = lintMarkdown(doc("Some text."));
		expect(issues.filter((i) => i.rule === "valid-frontmatter")).toHaveLength(
			0,
		);
	});

	test("fails without frontmatter", () => {
		const issues = lintMarkdown("# No frontmatter\n\nSome text.");
		expect(issues.some((i) => i.rule === "valid-frontmatter")).toBe(true);
	});

	test("fails with missing required field", () => {
		const bad = '---\ntitle: "X"\n---\n# X\n\nText.';
		const issues = lintMarkdown(bad);
		const fm = issues.filter((i) => i.rule === "valid-frontmatter");
		expect(fm.length).toBeGreaterThan(0);
	});
});

describe("no-broken-emphasis", () => {
	test("passes with correct emphasis", () => {
		const issues = lintMarkdown(doc("This is *italic* and **bold** text."));
		expect(issues.filter((i) => i.rule === "no-broken-emphasis")).toHaveLength(
			0,
		);
	});

	test("detects broken bold", () => {
		const issues = lintMarkdown(doc("This is **broken ** emphasis."));
		expect(issues.some((i) => i.rule === "no-broken-emphasis")).toBe(true);
	});
});

describe("no-html-tags", () => {
	test("passes with clean text", () => {
		const issues = lintMarkdown(doc("Clean text here."));
		expect(issues.filter((i) => i.rule === "no-html-tags")).toHaveLength(0);
	});

	test("detects residual HTML", () => {
		const issues = lintMarkdown(doc("Text with <strong>html</strong> inside."));
		expect(issues.some((i) => i.rule === "no-html-tags")).toBe(true);
	});

	test("allows Markdown images", () => {
		const issues = lintMarkdown(doc("![alt](https://example.com/img.png)"));
		expect(issues.filter((i) => i.rule === "no-html-tags")).toHaveLength(0);
	});
});

describe("no-html-entities", () => {
	test("passes with decoded text", () => {
		const issues = lintMarkdown(doc("Normal & clean text."));
		expect(issues.filter((i) => i.rule === "no-html-entities")).toHaveLength(0);
	});

	test("detects unresolved entities", () => {
		const issues = lintMarkdown(doc("Text with &amp; entity."));
		expect(issues.some((i) => i.rule === "no-html-entities")).toBe(true);
	});
});

describe("no-empty-headings", () => {
	test("passes with content headings", () => {
		const issues = lintMarkdown(doc("## Chapter One"));
		expect(issues.filter((i) => i.rule === "no-empty-headings")).toHaveLength(
			0,
		);
	});

	test("detects empty heading", () => {
		const issues = lintMarkdown(doc("## \n\nSome text."));
		expect(issues.some((i) => i.rule === "no-empty-headings")).toBe(true);
	});
});

describe("no-editorial-notes", () => {
	test("passes without editorial notes", () => {
		const issues = lintMarkdown(doc("Regular legal text."));
		expect(issues.filter((i) => i.rule === "no-editorial-notes")).toHaveLength(
			0,
		);
	});

	test("detects Téngase en cuenta", () => {
		const issues = lintMarkdown(doc("Téngase en cuenta que esta ley..."));
		expect(issues.some((i) => i.rule === "no-editorial-notes")).toBe(true);
	});

	test("detects Redacción anterior:", () => {
		const issues = lintMarkdown(doc('Redacción anterior: "1. El texto..."'));
		expect(issues.some((i) => i.rule === "no-editorial-notes")).toBe(true);
	});
});

describe("no-excessive-blanks", () => {
	test("passes with normal spacing", () => {
		const issues = lintMarkdown(doc("Line 1.\n\nLine 2."));
		expect(issues.filter((i) => i.rule === "no-excessive-blanks")).toHaveLength(
			0,
		);
	});

	test("warns on triple blanks", () => {
		const issues = lintMarkdown(doc("Line 1.\n\n\n\nLine 2."));
		expect(issues.some((i) => i.rule === "no-excessive-blanks")).toBe(true);
	});
});

describe("table-integrity", () => {
	test("passes with consistent table", () => {
		const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
		const issues = lintMarkdown(doc(table));
		expect(issues.filter((i) => i.rule === "table-integrity")).toHaveLength(0);
	});

	test("warns on inconsistent columns", () => {
		const table = "| A | B |\n| --- | --- |\n| 1 | 2 | 3 |";
		const issues = lintMarkdown(doc(table));
		expect(issues.some((i) => i.rule === "table-integrity")).toBe(true);
	});
});
