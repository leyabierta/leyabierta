import { describe, expect, test } from "bun:test";
import { bakeArticleSummaries, normKey } from "../article-summaries.ts";

describe("normKey", () => {
	test("lowercases, strips accents, maps dots to boundaries", () => {
		// "." becomes "-" so decimal articles stay distinct (see collision test).
		expect(normKey("Artículo 1. Título")).toBe("articulo 1- titulo");
		expect(normKey("  DISPOSICIÓN  final  ")).toBe("disposicion final");
		expect(normKey("Artículo 1.1")).toBe("articulo 1-1");
		expect(normKey("Artículo 11")).toBe("articulo 11");
	});
});

describe("bakeArticleSummaries", () => {
	const H = (title: string, id = "") =>
		`<h6${id ? ` id="${id}"` : ""}>${title}</h6>`;

	test("injects a collapsed <details> after a matching heading", () => {
		const html = `${H("Artículo 14", "articulo-14")}<p>Los españoles...</p>`;
		const out = bakeArticleSummaries(html, [
			["Artículo 14", "Nadie puede ser discriminado."],
		]);
		expect(out).toContain('<details class="article-summary">');
		expect(out).toContain("Ver resumen ciudadano");
		expect(out).toContain("Nadie puede ser discriminado.");
		// details comes right after the heading, before the paragraph.
		expect(out.indexOf("</h6>")).toBeLessThan(out.indexOf("<details"));
		expect(out.indexOf("<details")).toBeLessThan(out.indexOf("<p>"));
		// still collapsed by default
		expect(out).not.toContain("<details open");
	});

	test("escapes HTML in the summary text", () => {
		const out = bakeArticleSummaries(H("Artículo 1"), [
			["Artículo 1", 'Ver <script>alert("x")</script> & <b>bold</b>'],
		]);
		expect(out).toContain("&lt;script&gt;");
		expect(out).not.toContain("<script>alert");
		expect(out).toContain("&amp;");
	});

	test("matches the longest title first (Artículo 1 vs Artículo 1 bis)", () => {
		const html = H("Artículo 1 bis");
		const out = bakeArticleSummaries(html, [
			["Artículo 1", "resumen del uno"],
			["Artículo 1 bis", "resumen del uno bis"],
		]);
		expect(out).toContain("resumen del uno bis");
		expect(out).not.toContain("resumen del uno<"); // not the shorter one
	});

	test("keeps decimal articles distinct (Artículo 1.1 vs Artículo 11)", () => {
		// Both blocks present on the same norm: each must get its own summary,
		// not collide on a shared key.
		const html = `${H("Artículo 1.1")}<p>a</p>${H("Artículo 11")}<p>b</p>`;
		const out = bakeArticleSummaries(html, [
			["Artículo 1.1", "resumen uno punto uno"],
			["Artículo 11", "resumen once"],
		]);
		expect(normKey("Artículo 1.1")).not.toBe(normKey("Artículo 11"));
		const h11 = out.slice(out.indexOf("Artículo 11"));
		expect(h11).toContain("resumen once");
		expect(h11).not.toContain("resumen uno punto uno");
		const h11Start = out.indexOf("Artículo 11");
		expect(out.slice(0, h11Start)).toContain("resumen uno punto uno");
	});

	test("still matches a heading that carries a dotted title", () => {
		const out = bakeArticleSummaries(H("Artículo 1.1"), [
			["Artículo 1.1", "resumen decimal"],
		]);
		expect(out).toContain("resumen decimal");
	});

	test("respects the word boundary (Artículo 1 does not match Artículo 12)", () => {
		const out = bakeArticleSummaries(H("Artículo 12"), [
			["Artículo 1", "resumen del uno"],
		]);
		expect(out).not.toContain("<details");
	});

	test("matches headings that carry an id attribute", () => {
		const out = bakeArticleSummaries(H("Artículo 90", "articulo-90"), [
			["Artículo 90", "resumen noventa"],
		]);
		expect(out).toContain("resumen noventa");
	});

	test("leaves HTML untouched when there is no match or no pairs", () => {
		const html = `${H("Artículo 3")}<p>x</p>`;
		expect(bakeArticleSummaries(html, [])).toBe(html);
		expect(bakeArticleSummaries(html, undefined)).toBe(html);
		expect(bakeArticleSummaries(html, [["Artículo 99", "no match"]])).toBe(
			html,
		);
	});

	test("injects into multiple articles independently", () => {
		const html = `${H("Artículo 1")}<p>a</p>${H("Artículo 2")}<p>b</p>`;
		const out = bakeArticleSummaries(html, [
			["Artículo 1", "uno"],
			["Artículo 2", "dos"],
		]);
		expect((out.match(/<details/g) ?? []).length).toBe(2);
		expect(out).toContain("uno");
		expect(out).toContain("dos");
	});
});
