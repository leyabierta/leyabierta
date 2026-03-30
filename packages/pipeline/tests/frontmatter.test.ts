import { describe, expect, test } from "bun:test";
import type { NormMetadata } from "../src/models.ts";
import { renderFrontmatter } from "../src/transform/frontmatter.ts";

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

describe("renderFrontmatter", () => {
	test("renders all required fields in Spanish", () => {
		const result = renderFrontmatter(makeMetadata(), "2024-02-17");

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

		expect(result).toContain('"Constitucion Espanola"');
		expect(result).toContain('"BOE-A-1978-31229"');
		expect(result).toContain('"es"');
		expect(result).toContain('"constitucion"');
		expect(result).toContain('"1978-12-29"');
		expect(result).toContain('"2024-02-17"');
		expect(result).toContain('"vigente"');
		expect(result).toContain('"Jefatura del Estado"');
		expect(result).toContain('"https://www.boe.es/eli/es/c/1978/12/27/(1)"');
	});

	test("wraps content in YAML delimiters", () => {
		const result = renderFrontmatter(makeMetadata(), "2024-02-17");
		expect(result).toStartWith("---\n");
		expect(result).toEndWith("---\n");
	});

	test("escapes YAML special characters in titles: quotes", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: 'Ley "Orgánica" de Educación' }),
			"2024-01-01",
		);
		expect(result).toContain('titulo: "Ley \\"Orgánica\\" de Educación"');
	});

	test("escapes YAML special characters in titles: backslashes", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: "Ley de Caminos \\ Carreteras" }),
			"2024-01-01",
		);
		expect(result).toContain('titulo: "Ley de Caminos \\\\ Carreteras"');
	});

	test("escapes YAML special characters in titles: newlines", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: "Ley de\nAguas" }),
			"2024-01-01",
		);
		expect(result).toContain('titulo: "Ley de Aguas"');
		// The title line should be complete on a single line (no literal newline inside the value)
		const titleLine = result.split("\n").find((l) => l.startsWith("titulo:"));
		expect(titleLine).toBe('titulo: "Ley de Aguas"');
	});

	test("escapes YAML special characters in department", () => {
		const result = renderFrontmatter(
			makeMetadata({ department: 'Ministerio de "Justicia"' }),
			"2024-01-01",
		);
		expect(result).toContain('departamento: "Ministerio de \\"Justicia\\""');
	});

	test("extracts jurisdiction 'es' from ELI URL", () => {
		const result = renderFrontmatter(
			makeMetadata({
				source: "https://www.boe.es/eli/es/c/1978/12/27/(1)",
			}),
			"2024-01-01",
		);
		expect(result).toContain('jurisdiccion: "es"');
	});

	test("extracts jurisdiction 'es-pv' from ELI URL", () => {
		const result = renderFrontmatter(
			makeMetadata({
				source: "https://www.boe.es/eli/es-pv/l/2020/06/25/4",
			}),
			"2024-01-01",
		);
		expect(result).toContain('jurisdiccion: "es-pv"');
	});

	test("extracts jurisdiction 'es-ct' from ELI URL", () => {
		const result = renderFrontmatter(
			makeMetadata({
				source: "https://www.boe.es/eli/es-ct/l/2014/12/29/16",
			}),
			"2024-01-01",
		);
		expect(result).toContain('jurisdiccion: "es-ct"');
	});

	test("falls back to country when no ELI URL", () => {
		const result = renderFrontmatter(
			makeMetadata({
				country: "fr",
				source: "https://legifrance.gouv.fr/loda/id/123",
			}),
			"2024-01-01",
		);
		expect(result).toContain('jurisdiccion: "fr"');
	});

	test("includes pdf field when pdfUrl is set", () => {
		const result = renderFrontmatter(
			makeMetadata({
				pdfUrl:
					"https://www.boe.es/boe/dias/2024/02/17/pdfs/BOE-A-2024-3099.pdf",
			}),
			"2024-01-01",
		);
		expect(result).toContain(
			'pdf: "https://www.boe.es/boe/dias/2024/02/17/pdfs/BOE-A-2024-3099.pdf"',
		);
	});

	test("does not include pdf field when pdfUrl is not set", () => {
		const result = renderFrontmatter(makeMetadata(), "2024-01-01");
		expect(result).not.toContain("pdf:");
	});

	test("cleans trailing dots from titles", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: "Ley de Aguas." }),
			"2024-01-01",
		);
		expect(result).toContain('titulo: "Ley de Aguas"');
	});

	test("cleans trailing spaces from titles", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: "Ley de Aguas   " }),
			"2024-01-01",
		);
		expect(result).toContain('titulo: "Ley de Aguas"');
	});

	test("cleans trailing dots and spaces combined", () => {
		const result = renderFrontmatter(
			makeMetadata({ title: "Ley de Aguas. . " }),
			"2024-01-01",
		);
		expect(result).toContain('titulo: "Ley de Aguas"');
	});
});
