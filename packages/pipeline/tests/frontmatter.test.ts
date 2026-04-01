import { describe, expect, test } from "bun:test";
import type { Block, NormMetadata, Reform } from "../src/models.ts";
import {
	type AnalisisData,
	renderFrontmatter,
} from "../src/transform/frontmatter.ts";

function makeMetadata(overrides: Partial<NormMetadata> = {}): NormMetadata {
	return {
		title: "Constitucion Espanola",
		shortTitle: "Constitucion",
		id: "BOE-A-1978-31229",
		country: "es",
		rank: "constitucion",
		publishedAt: "1978-12-29",
		status: "vigente",
		department: "Jefatura del Estado",
		source: "https://www.boe.es/eli/es/c/1978/12/27/(1)",
		...overrides,
	};
}

const EMPTY_REFORMS: Reform[] = [];
const EMPTY_BLOCKS: Block[] = [];

function render(
	overrides: Partial<NormMetadata> = {},
	date = "2024-02-17",
	reforms: Reform[] = EMPTY_REFORMS,
	blocks: Block[] = EMPTY_BLOCKS,
	analisis?: AnalisisData,
): string {
	return renderFrontmatter(
		makeMetadata(overrides),
		date,
		reforms,
		blocks,
		analisis,
	);
}

describe("renderFrontmatter", () => {
	test("renders all required fields in Spanish", () => {
		const result = render();

		expect(result).toContain("titulo:");
		expect(result).toContain("identificador:");
		expect(result).toContain("pais:");
		expect(result).toContain("jurisdiccion:");
		expect(result).toContain("rango:");
		expect(result).toContain("fecha_publicacion:");
		expect(result).toContain("ultima_actualizacion:");
		expect(result).toContain("estado:");
		expect(result).toContain("departamento:");
		expect(result).toContain("fuente:");
	});

	test("wraps content in YAML delimiters", () => {
		const result = render();
		expect(result).toStartWith("---\n");
		expect(result).toContain("---\n\n");
	});

	test("escapes special characters in titles via js-yaml", () => {
		const result = render({ title: 'Ley "Orgánica" de Educación' });
		// js-yaml will quote the string properly
		expect(result).toContain("Ley");
		expect(result).toContain("Orgánica");
		// Verify it's valid YAML by checking delimiters
		expect(result).toStartWith("---\n");
	});

	test("handles newlines in titles", () => {
		const result = render({ title: "Ley de\nAguas" });
		// cleanTitle removes trailing dots/spaces, but newlines in middle
		// are handled by js-yaml (quoted or escaped)
		expect(result).toContain("Ley de");
		expect(result).toContain("Aguas");
	});

	test("extracts jurisdiction from ELI URL", () => {
		expect(
			render({ source: "https://www.boe.es/eli/es/c/1978/12/27/(1)" }),
		).toContain("jurisdiccion: es\n");
		expect(
			render({ source: "https://www.boe.es/eli/es-pv/l/2020/06/25/4" }),
		).toContain("jurisdiccion: es-pv\n");
		expect(
			render({ source: "https://www.boe.es/eli/es-ct/l/2014/12/29/16" }),
		).toContain("jurisdiccion: es-ct\n");
	});

	test("falls back to country when no ELI URL", () => {
		const result = render({
			country: "fr",
			source: "https://legifrance.gouv.fr/loda/id/123",
		});
		expect(result).toContain("jurisdiccion: fr\n");
	});

	test("includes pdf field when pdfUrl is set", () => {
		const result = render({
			pdfUrl: "https://www.boe.es/boe/dias/2024/02/17/pdfs/BOE-A-2024-3099.pdf",
		});
		expect(result).toContain("pdf:");
		expect(result).toContain("BOE-A-2024-3099.pdf");
	});

	test("does not include pdf field when pdfUrl is not set", () => {
		const result = render();
		expect(result).not.toContain("pdf:");
	});

	test("cleans trailing dots and spaces from titles", () => {
		const result = render({ title: "Ley de Aguas. . " });
		expect(result).toContain("Ley de Aguas");
		expect(result).not.toContain("Aguas.");
	});

	test("includes articulos count from blocks", () => {
		const blocks: Block[] = [
			{ id: "p1", type: "precepto", title: "Art 1", versions: [] },
			{ id: "p2", type: "precepto", title: "Art 2", versions: [] },
			{ id: "t1", type: "titulo", title: "Título I", versions: [] },
		];
		const result = render({}, "2024-01-01", [], blocks);
		expect(result).toContain("articulos: 2\n");
	});

	test("includes reformas array", () => {
		const reforms: Reform[] = [
			{ date: "1978-12-29", normId: "BOE-A-1978-31229", affectedBlockIds: [] },
			{ date: "2024-02-17", normId: "BOE-A-2024-3099", affectedBlockIds: [] },
		];
		const result = render({}, "2024-02-17", reforms);
		expect(result).toContain("reformas:");
		expect(result).toContain('fecha: "1978-12-29"');
		expect(result).toContain("fuente: BOE-A-2024-3099");
	});

	test("omits reformas when empty", () => {
		const result = render();
		expect(result).not.toContain("reformas:");
	});

	test("includes materias from analisis", () => {
		const analisis: AnalisisData = {
			materias: ["Derecho constitucional", "Derechos fundamentales"],
			notas: [],
			referencias: { anteriores: [], posteriores: [] },
		};
		const result = render({}, "2024-01-01", [], [], analisis);
		expect(result).toContain("materias:");
		expect(result).toContain("Derecho constitucional");
		expect(result).toContain("Derechos fundamentales");
	});

	test("includes notas from analisis", () => {
		const analisis: AnalisisData = {
			materias: [],
			notas: ["Téngase en cuenta que esta ley fue modificada"],
			referencias: { anteriores: [], posteriores: [] },
		};
		const result = render({}, "2024-01-01", [], [], analisis);
		expect(result).toContain("notas:");
		expect(result).toContain("Téngase en cuenta");
	});

	test("includes referencias from analisis", () => {
		const analisis: AnalisisData = {
			materias: [],
			notas: [],
			referencias: {
				anteriores: [
					{
						normId: "BOE-A-1977-123",
						relation: "DEROGA",
						text: "Ley de Reforma",
					},
				],
				posteriores: [
					{ normId: "BOE-A-1985-456", relation: "SE DESARROLLA", text: "LOPJ" },
				],
			},
		};
		const result = render({}, "2024-01-01", [], [], analisis);
		expect(result).toContain("referencias_anteriores:");
		expect(result).toContain("BOE-A-1977-123");
		expect(result).toContain("referencias_posteriores:");
		expect(result).toContain("BOE-A-1985-456");
	});

	test("omits empty analisis sections", () => {
		const analisis: AnalisisData = {
			materias: [],
			notas: [],
			referencias: { anteriores: [], posteriores: [] },
		};
		const result = render({}, "2024-01-01", [], [], analisis);
		expect(result).not.toContain("materias:");
		expect(result).not.toContain("notas:");
		expect(result).not.toContain("referencias_anteriores:");
		expect(result).not.toContain("referencias_posteriores:");
	});
});
