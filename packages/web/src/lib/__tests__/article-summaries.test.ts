import { describe, expect, test } from "bun:test";
import {
	articleLabel,
	bakeArticleSummaries,
	matchArticleSummaries,
	normKey,
} from "../article-summaries.ts";
import { renderLawHtml } from "../law-text.ts";

describe("normKey", () => {
	test("lowercases, strips accents, maps dots to boundaries", () => {
		// "." becomes "-" so decimal articles stay distinct (see collision test).
		expect(normKey("Artículo 1. Título")).toBe("articulo 1- titulo");
		expect(normKey("  DISPOSICIÓN  final  ")).toBe("disposicion final");
		expect(normKey("Artículo 1.1")).toBe("articulo 1-1");
		expect(normKey("Artículo 11")).toBe("articulo 11");
	});

	test("treats abbreviated article headings as the same article", () => {
		// The Código Civil's BOE titles are "Art 1"; older texts print "Art. 1.".
		expect(normKey("Art 1")).toBe(normKey("Artículo 1"));
		expect(normKey("Art. 1.")).toBe(normKey("Artículo 1."));
		expect(normKey("Artículo 1.º")).toBe(normKey("Artículo 1."));
		// ...but not words that merely start with "art".
		expect(normKey("Arte y cultura")).toBe("arte y cultura");
	});
});

const H = (title: string, id = "", tag = "h6") =>
	`<${tag}${id ? ` id="${id}"` : ""}>${title}</${tag}>`;
const count = (html: string) =>
	(html.match(/class="article-summary"/g) ?? []).length;

describe("bakeArticleSummaries", () => {
	test("injects a visible, labelled note after a matching heading", () => {
		const html = `${H("Artículo 14", "articulo-14")}<p>Los españoles...</p>`;
		const out = bakeArticleSummaries(html, [
			["Artículo 14", "Nadie puede ser discriminado."],
		]);
		expect(out).toContain('<div class="article-summary" role="note">');
		expect(out).toContain("Resumen en lenguaje sencillo");
		expect(out).toContain("generado con IA");
		expect(out).toContain('href="/sobre/#resumenes-ia"');
		expect(out).toContain("Nadie puede ser discriminado.");
		// Visible: no <details> fold anymore.
		expect(out).not.toContain("<details");
		// The note comes right after the heading, before the legal text.
		expect(out.indexOf("</h6>")).toBeLessThan(out.indexOf("article-summary"));
		expect(out.indexOf("article-summary")).toBeLessThan(out.indexOf("<p>Los"));
	});

	test("escapes HTML in the summary text", () => {
		const out = bakeArticleSummaries(H("Artículo 1"), [
			["Artículo 1", 'Ver <script>alert("x")</script> & <b>bold</b>'],
		]);
		expect(out).toContain("&lt;script&gt;");
		expect(out).not.toContain("<script>alert");
		expect(out).toContain("&amp;");
	});

	test("matches the heading as printed in the text (Código Civil case)", () => {
		// Regression: the manifest used blocks.title ("Art 1"), which never
		// matched "Artículo 1." — 16 of 1,322 Código Civil summaries rendered.
		const html = `${H("Artículo 1.")}<p>a</p>${H("Artículo 2.")}<p>b</p>`;
		expect(
			count(
				bakeArticleSummaries(html, [
					["Art 1", "uno"],
					["Art 2", "dos"],
				]),
			),
		).toBe(2);
		expect(
			count(
				bakeArticleSummaries(html, [
					["Artículo 1.", "uno"],
					["Artículo 2.", "dos"],
				]),
			),
		).toBe(2);
	});

	test("matches the longest title first (Artículo 1 vs Artículo 1 bis)", () => {
		const out = bakeArticleSummaries(H("Artículo 1 bis"), [
			["Artículo 1", "resumen del uno"],
			["Artículo 1 bis", "resumen del uno bis"],
		]);
		expect(out).toContain("resumen del uno bis");
		expect(out).not.toContain("resumen del uno<");
	});

	test("keeps decimal articles distinct (Artículo 1.1 vs Artículo 11)", () => {
		const html = `${H("Artículo 1.1")}<p>a</p>${H("Artículo 11")}<p>b</p>`;
		const out = bakeArticleSummaries(html, [
			["Artículo 1.1", "resumen uno punto uno"],
			["Artículo 11", "resumen once"],
		]);
		const h11Start = out.indexOf("Artículo 11");
		expect(out.slice(h11Start)).toContain("resumen once");
		expect(out.slice(h11Start)).not.toContain("resumen uno punto uno");
		expect(out.slice(0, h11Start)).toContain("resumen uno punto uno");
	});

	test("respects the word boundary (Artículo 1 does not match Artículo 12)", () => {
		const out = bakeArticleSummaries(H("Artículo 12"), [
			["Artículo 1", "resumen del uno"],
		]);
		expect(count(out)).toBe(0);
	});

	test("repeated headings consume summaries in document order", () => {
		// "Primera." under the transitorias and again under the adicionales.
		const html = `${H("DISPOSICIONES TRANSITORIAS", "", "h4")}${H("Primera.")}<p>t</p>${H("DISPOSICIONES ADICIONALES", "", "h4")}${H("Primera.")}<p>a</p>`;
		const out = bakeArticleSummaries(html, [
			["Primera.", "transitoria"],
			["Primera.", "adicional"],
		]);
		expect(out.indexOf("transitoria")).toBeLessThan(out.indexOf("ADICIONALES"));
		expect(out.indexOf("adicional<")).toBeGreaterThan(
			out.indexOf("ADICIONALES"),
		);
	});

	test("an empty placeholder keeps a summary off the wrong repeated heading", () => {
		// Only the second "Primera." has a summary; the placeholder for the first
		// stops it from being stamped on the first heading.
		const html = `${H("Primera.")}<p>t</p>${H("Primera.")}<p>a</p>`;
		const out = bakeArticleSummaries(html, [
			["Primera.", ""],
			["Primera.", "solo la segunda"],
		]);
		expect(count(out)).toBe(1);
		expect(out.indexOf("solo la segunda")).toBeGreaterThan(
			out.lastIndexOf("Primera."),
		);
	});

	test("falls back to the article number when the heading was reworded", () => {
		const out = bakeArticleSummaries(
			H("Artículo 5. Competencias del Presidente."),
			[["Artículo 5. Competencias de la Presidencia.", "resumen cinco"]],
		);
		expect(out).toContain("resumen cinco");
	});

	test("a reworded fallback never takes a summary whose own heading comes later", () => {
		// Two annexes, each with its own "Artículo 12.". Only the second one
		// has a summary; the first (unsummarized, no placeholder) must not
		// grab it through the article-number fallback.
		const out = bakeArticleSummaries(
			H("Artículo 12. Inspecciones y pruebas.") +
				"<p>anexo I</p>" +
				H("Artículo 12. Distancias entre recipientes."),
			[["Artículo 12. Distancias entre recipientes.", "resumen distancias"]],
		);
		expect(count(out)).toBe(1);
		expect(out.indexOf("resumen distancias")).toBeGreaterThan(
			out.indexOf("Distancias entre recipientes."),
		);
	});

	test("latin and ordinal suffixes beyond decies are part of the article number", () => {
		// Before: "103 terdecies" and "103 quaterdecies" both keyed as
		// "articulo 103", so an unmatched one slid onto its neighbour.
		const { items } = matchArticleSummaries(
			H("Artículo 103 terdecies. Sujeto pasivo.", "a") +
				H("Artículo 103 quaterdecies. Cuantía.", "b") +
				H("Artículo 30. Afectación.", "c") +
				H("Artículo 30 tercero. Sujeto pasivo.", "d"),
			[
				["Artículo 103 quaterdecies. Cuantía.", "cuantia"],
				["Artículo 30 tercero. Sujeto pasivo.", "tercero"],
			],
			{ inject: false },
		);
		expect(items.map((i) => [i.summary, i.anchor])).toEqual([
			["cuantia", "b"],
			["tercero", "d"],
		]);
	});

	test("matches articles rendered at other heading levels", () => {
		const out = bakeArticleSummaries(H("Artículo 1", "", "h4"), [
			["Artículo 1", "tratado"],
		]);
		expect(out).toContain("tratado");
	});

	test("leaves HTML untouched when there is no match or no pairs", () => {
		const html = `${H("Artículo 3")}<p>x</p>`;
		expect(bakeArticleSummaries(html, [])).toBe(html);
		expect(bakeArticleSummaries(html, undefined)).toBe(html);
		expect(bakeArticleSummaries(html, [["Artículo 99", "no match"]])).toBe(
			html,
		);
	});
});

describe("matchArticleSummaries", () => {
	test("returns every summary with its anchor and section, without injecting", () => {
		const html = renderLawHtml(
			[
				"## TÍTULO I",
				"##### Artículo 1. Objeto.",
				"texto",
				"### DISPOSICIONES TRANSITORIAS",
				"##### Primera.",
				"texto",
				"### DISPOSICIONES ADICIONALES",
				"##### Primera.",
				"texto",
			].join("\n\n"),
		);
		const { html: out, items } = matchArticleSummaries(
			html,
			[
				["Artículo 1. Objeto.", "uno"],
				["Primera.", "transitoria"],
				["Primera.", "adicional"],
				["Artículo 99.", "sin encaje"],
			],
			{ inject: false },
		);
		expect(out).toBe(html);
		expect(items.map((i) => [i.summary, i.anchor])).toEqual([
			["uno", "articulo-1"],
			["transitoria", "primera"],
			["adicional", "primera-2"],
			["sin encaje", null],
		]);
		expect(items[1]!.section).toBe("DISPOSICIONES TRANSITORIAS");
		expect(items[2]!.section).toBe("DISPOSICIONES ADICIONALES");
	});

	test("carries the BOE block id of each pair, when the manifest has it", () => {
		const html = renderLawHtml(
			["##### Artículo 1.", "texto", "##### Artículo 2.", "texto"].join("\n\n"),
		);
		const { items } = matchArticleSummaries(
			html,
			[
				["Artículo 1.", "uno", "art1"],
				["Artículo 2.", "dos"], // older manifest: no block id
			],
			{ inject: false },
		);
		expect(items.map((i) => i.blockId)).toEqual(["art1", null]);
	});
});

describe("articleLabel", () => {
	test("formats article headings as 'Artículo N — título'", () => {
		expect(articleLabel("Artículo 14. Igualdad ante la ley.", null)).toBe(
			"Artículo 14 — Igualdad ante la ley",
		);
		expect(articleLabel("Artículo 1.", null)).toBe("Artículo 1");
		expect(articleLabel("Artículo 17 bis. Comisión Estatal.", null)).toBe(
			"Artículo 17 bis — Comisión Estatal",
		);
		expect(articleLabel("Artículo único.", null)).toBe("Artículo único");
		expect(articleLabel("Art. 2.º", null)).toBe("Artículo 2");
		expect(articleLabel("Art 94 bis.", null)).toBe("Artículo 94 bis");
	});

	test("gives bare ordinals their section", () => {
		expect(articleLabel("Primera.", "DISPOSICIONES TRANSITORIAS")).toBe(
			"Disposiciones transitorias — Primera",
		);
	});

	test("formats disposiciones with a title", () => {
		expect(
			articleLabel("Disposición final primera. Entrada en vigor.", null),
		).toBe("Disposición final primera — Entrada en vigor");
		expect(articleLabel("Disposición derogatoria única.", null)).toBe(
			"Disposición derogatoria única",
		);
	});
});
