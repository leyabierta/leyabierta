import { describe, expect, test } from "bun:test";
import type { Block, NormMetadata, Paragraph } from "../src/models.ts";
import {
	renderNormAtDate,
	renderParagraphs,
} from "../src/transform/markdown.ts";

describe("renderParagraphs", () => {
	test("renders article heading", () => {
		const paragraphs: Paragraph[] = [
			{ cssClass: "articulo", text: "Artículo 1" },
		];
		expect(renderParagraphs(paragraphs)).toContain("##### Artículo 1");
	});

	test("renders normal paragraph as-is", () => {
		const paragraphs: Paragraph[] = [
			{ cssClass: "parrafo", text: "Some legal text here." },
		];
		expect(renderParagraphs(paragraphs)).toContain("Some legal text here.");
	});

	test("combines paired titulo_num + titulo_tit", () => {
		const paragraphs: Paragraph[] = [
			{ cssClass: "titulo_num", text: "TÍTULO I" },
			{ cssClass: "titulo_tit", text: "De los derechos fundamentales" },
		];
		const result = renderParagraphs(paragraphs);
		expect(result).toContain("## TÍTULO I. De los derechos fundamentales");
	});

	test("combines paired capitulo_num + capitulo_tit", () => {
		const paragraphs: Paragraph[] = [
			{ cssClass: "capitulo_num", text: "CAPÍTULO PRIMERO" },
			{ cssClass: "capitulo_tit", text: "De los españoles" },
		];
		const result = renderParagraphs(paragraphs);
		expect(result).toContain("### CAPÍTULO PRIMERO. De los españoles");
	});

	test("handles titulo_num without following titulo_tit", () => {
		const paragraphs: Paragraph[] = [
			{ cssClass: "titulo_num", text: "TÍTULO PRELIMINAR" },
			{ cssClass: "parrafo", text: "Some text" },
		];
		const result = renderParagraphs(paragraphs);
		expect(result).toContain("## TÍTULO PRELIMINAR");
	});

	test("renders firma classes", () => {
		const paragraphs: Paragraph[] = [
			{ cssClass: "firma_rey", text: "JUAN CARLOS" },
			{ cssClass: "firma_ministro", text: "Antonio Hernández Gil" },
		];
		const result = renderParagraphs(paragraphs);
		expect(result).toContain("**JUAN CARLOS**");
		expect(result).toContain("Antonio Hernández Gil");
	});
});

describe("renderNormAtDate", () => {
	const metadata: NormMetadata = {
		title: "Constitución Española",
		shortTitle: "Constitución Española",
		id: "BOE-A-1978-31229",
		country: "es",
		rank: "constitucion",
		publishedAt: "1978-12-29",
		status: "vigente",
		department: "Cortes Generales",
		source: "https://www.boe.es/eli/es/c/1978/12/27/(1)",
	};

	const blocks: Block[] = [
		{
			id: "a1",
			type: "precepto",
			title: "Artículo 1",
			versions: [
				{
					normId: "BOE-A-1978-31229",
					publishedAt: "1978-12-29",
					effectiveAt: "1978-12-29",
					paragraphs: [
						{ cssClass: "articulo", text: "Artículo 1" },
						{
							cssClass: "parrafo",
							text: "España se constituye en un Estado social.",
						},
					],
				},
			],
		},
	];

	test("includes frontmatter", () => {
		const md = renderNormAtDate(metadata, blocks, "1978-12-29");
		expect(md).toContain("---");
		expect(md).toContain("identificador: BOE-A-1978-31229");
		expect(md).toContain("estado: vigente");
	});

	test("includes H1 title", () => {
		const md = renderNormAtDate(metadata, blocks, "1978-12-29");
		expect(md).toContain("# Constitución Española");
	});

	test("includes article content", () => {
		const md = renderNormAtDate(metadata, blocks, "1978-12-29");
		expect(md).toContain("##### Artículo 1");
		expect(md).toContain("España se constituye en un Estado social.");
	});

	test("excludes blocks not yet in effect", () => {
		const md = renderNormAtDate(metadata, blocks, "1970-01-01");
		expect(md).not.toContain("Artículo 1");
	});
});
