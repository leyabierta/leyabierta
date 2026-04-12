/**
 * Bill Parser — synthetic (inline) tests.
 *
 * These tests use inline text snippets instead of external PDF files,
 * so they always run in CI and fresh clones. No LLM calls, no DB, no network.
 */

import { describe, expect, test } from "bun:test";
import {
	extractQuotedText,
	parseModifications,
} from "../services/bill-parser/classification.ts";
import {
	extractBocgId,
	extractPublicationDate,
	extractTitle,
} from "../services/bill-parser/header.ts";
import {
	lawNamesMatch,
	normalizeLawName,
} from "../services/bill-parser/llm.ts";
import { classifyBillType } from "../services/bill-parser/parser.ts";

// ── 1. classifyBillType ──

describe("classifyBillType", () => {
	test("text with 5+ numbered articles and no modification keywords → new_law", () => {
		const text = [
			"",
			"Artículo 1. Objeto.",
			"Esta ley tiene por objeto regular el acceso a la información pública.",
			"",
			"Artículo 2. Ámbito de aplicación.",
			"La presente ley se aplica a todas las administraciones públicas.",
			"",
			"Artículo 3. Definiciones.",
			"A los efectos de esta ley se entiende por información pública todo contenido.",
			"",
			"Artículo 4. Derecho de acceso.",
			"Toda persona tiene derecho a acceder a la información pública.",
			"",
			"Artículo 5. Límites.",
			"El derecho de acceso podrá ser limitado cuando acceder a la información suponga un perjuicio.",
			"",
			"Disposición final primera. Entrada en vigor.",
			"La presente ley entrará en vigor a los veinte días de su publicación.",
		].join("\n");
		const result = classifyBillType(text, []);
		expect(result).toBe("new_law");
	});

	test("text with DF modifications and no substantial articulado → amendment", () => {
		const text = [
			"",
			"Disposición final primera. Modificación de la Ley Orgánica 10/1995, del Código Penal.",
			"Uno. Se modifica el artículo 31 bis, que queda redactado como sigue:",
			"«Texto nuevo del artículo.»",
		].join("\n");
		const modGroups = [
			{
				title: "DF primera. Modificación del Código Penal",
				targetLaw: "Código Penal",
				modifications: [
					{
						ordinal: "Uno",
						changeType: "modify" as const,
						targetProvision: "artículo 31 bis",
						newText: "Texto nuevo del artículo.",
						sourceText: "",
					},
				],
			},
		];
		const result = classifyBillType(text, modGroups);
		expect(result).toBe("amendment");
	});

	test("text with both articles and DF modifications → mixed", () => {
		const text = [
			"",
			"Artículo 1. Objeto.",
			"Esta ley tiene por objeto establecer medidas de protección integral.",
			"",
			"Artículo 2. Ámbito.",
			"Quedan sujetas a esta ley todas las personas residentes en territorio español.",
			"",
			"Artículo 3. Principios.",
			"Los principios rectores de esta ley son la igualdad y la no discriminación.",
			"",
			"Artículo 4. Derechos.",
			"Se reconoce el derecho a la asistencia jurídica gratuita.",
			"",
			"Artículo 5. Medidas.",
			"Las administraciones adoptarán medidas de prevención y sensibilización.",
			"",
			"Disposición final primera. Modificación de la Ley de Enjuiciamiento Criminal.",
			"Uno. Se modifica el artículo 14, que queda redactado como sigue:",
			"«Texto nuevo.»",
		].join("\n");
		const modGroups = [
			{
				title: "DF primera. Modificación de la LECrim",
				targetLaw: "Ley de Enjuiciamiento Criminal",
				modifications: [
					{
						ordinal: "Uno",
						changeType: "modify" as const,
						targetProvision: "artículo 14",
						newText: "Texto nuevo.",
						sourceText: "",
					},
				],
			},
		];
		const result = classifyBillType(text, modGroups);
		expect(result).toBe("mixed");
	});

	test('"Artículo único" with modifications → amendment', () => {
		const text = [
			"",
			"Artículo único. Modificación de la Ley Orgánica 10/1995, de 23 de noviembre, del Código Penal.",
			"Uno. Se modifica el artículo 178, que queda redactado como sigue:",
			"«Texto nuevo del artículo 178.»",
			"Dos. Se modifica el artículo 179, que queda redactado como sigue:",
			"«Texto nuevo del artículo 179.»",
		].join("\n");
		const modGroups = [
			{
				title: "Artículo único. Modificación del Código Penal",
				targetLaw: "Código Penal",
				modifications: [
					{
						ordinal: "Uno",
						changeType: "modify" as const,
						targetProvision: "artículo 178",
						newText: "",
						sourceText: "",
					},
					{
						ordinal: "Dos",
						changeType: "modify" as const,
						targetProvision: "artículo 179",
						newText: "",
						sourceText: "",
					},
				],
			},
		];
		const result = classifyBillType(text, modGroups);
		expect(result).toBe("amendment");
	});

	test('"Artículo único" without modifications → new_law', () => {
		// A bill with "Artículo único" that creates new rules (no modification groups)
		// Must have enough text to trigger the fallback (articulado.length > 2000)
		const longBody = "A".repeat(2100);
		const text = `\nArtículo único. Aprobación del texto refundido.\n${longBody}`;
		const result = classifyBillType(text, []);
		expect(result).toBe("new_law");
	});
});

// ── 2. Modification classification (parseModifications) ──

describe("parseModifications", () => {
	// The ordinal regex requires (?:^|\n) before the ordinal word,
	// so we prefix text with \n to simulate real bill content.

	test('"Se modifica el artículo 31 bis" → modify', () => {
		const text =
			"\nUno. Se modifica el artículo 31 bis, que queda redactado como sigue:\n«Texto nuevo del artículo 31 bis.»\n";
		const { modifications } = parseModifications(text);
		expect(modifications.length).toBe(1);
		expect(modifications[0]!.changeType).toBe("modify");
		expect(modifications[0]!.targetProvision).toContain("artículo 31 bis");
	});

	test('"Se añade un nuevo artículo 197 ter" → add', () => {
		const text =
			"\nUno. Se añade un nuevo artículo 197 ter, con la siguiente redacción:\n«Texto nuevo del artículo 197 ter.»\n";
		const { modifications } = parseModifications(text);
		expect(modifications.length).toBe(1);
		expect(modifications[0]!.changeType).toBe("add");
		expect(modifications[0]!.targetProvision).toContain("artículo 197 ter");
	});

	test('"Se suprime el artículo 89" → delete', () => {
		const text = "\nUno. Se suprime el artículo 89.\n";
		const { modifications } = parseModifications(text);
		expect(modifications.length).toBe(1);
		expect(modifications[0]!.changeType).toBe("delete");
		expect(modifications[0]!.targetProvision).toContain("artículo 89");
	});

	test('"Se suprime el Capítulo I del Título XXII" → suppress_chapter', () => {
		const text =
			"\nUno. Se suprime el Capítulo I del Título XXII del Libro II.\n";
		const { modifications } = parseModifications(text);
		expect(modifications.length).toBe(1);
		expect(modifications[0]!.changeType).toBe("suppress_chapter");
		expect(modifications[0]!.targetProvision).toContain("Capítulo I");
	});

	test("unknown pattern falls back gracefully (no crash, returns result object)", () => {
		const text =
			"\nUno. Esta disposición no contiene ningún verbo de modificación reconocible y simplemente describe algo.\n";
		// Should not throw
		const result = parseModifications(text);
		// Returns a ParseModificationsResult; unknown ordinals go to unclassified
		expect(Array.isArray(result.modifications)).toBe(true);
		expect(Array.isArray(result.unclassified)).toBe(true);
		// The unrecognized ordinal should be in unclassified, not modifications
		expect(result.modifications.length).toBe(0);
		expect(result.unclassified.length).toBe(1);
	});

	test("multiple ordinals are split correctly", () => {
		const text = [
			"",
			"Uno. Se modifica el artículo 10, que queda redactado como sigue:",
			"«Nuevo texto del artículo 10.»",
			"",
			"Dos. Se añade un nuevo artículo 10 bis, con la siguiente redacción:",
			"«Texto del artículo 10 bis.»",
			"",
			"Tres. Se suprime el artículo 11.",
		].join("\n");
		const { modifications } = parseModifications(text);
		expect(modifications.length).toBe(3);
		expect(modifications[0]!.changeType).toBe("modify");
		expect(modifications[1]!.changeType).toBe("add");
		expect(modifications[2]!.changeType).toBe("delete");
	});
});

// ── 3. Header extraction ──

describe("header extraction", () => {
	const REALISTIC_HEADER = [
		"BOLETÍN OFICIAL DE LAS CORTES GENERALES",
		"CONGRESO DE LOS DIPUTADOS",
		"XIV LEGISLATURA",
		"Serie A:",
		"PROYECTOS DE LEY",
		"Núm. 62-1",
		"20 de mayo de 2022",
		"BOCG-14-A-62-1",
		"PROYECTO DE LEY",
		"Orgánica de garantía integral de la libertad sexual.",
		"121/000062  Proyecto de Ley Orgánica de garantía integral de la libertad sexual.",
		"La Mesa de la Cámara, en su reunión del día...",
	].join("\n");

	test("extractBocgId from realistic BOCG header", () => {
		const id = extractBocgId(REALISTIC_HEADER);
		expect(id).toBe("BOCG-14-A-62-1");
	});

	test("extractBocgId from CVE reference", () => {
		const text = "cve: BOCG-15-A-3-1\nSome other content.";
		const id = extractBocgId(text);
		expect(id).toBe("BOCG-15-A-3-1");
	});

	test("extractBocgId returns unknown for unrecognized text", () => {
		const id = extractBocgId("No hay ningún identificador aquí.");
		expect(id).toBe("unknown");
	});

	test("extractPublicationDate from realistic header", () => {
		const date = extractPublicationDate(REALISTIC_HEADER);
		expect(date).toBe("2022-05-20");
	});

	test("extractPublicationDate with different month", () => {
		const text = "3 de noviembre de 2023\nOther content";
		const date = extractPublicationDate(text);
		expect(date).toBe("2023-11-03");
	});

	test("extractPublicationDate returns unknown for missing date", () => {
		const date = extractPublicationDate("No date here.");
		expect(date).toBe("unknown");
	});

	test("extractTitle from realistic header", () => {
		const title = extractTitle(REALISTIC_HEADER);
		// Should extract the title after the reference number
		expect(title).not.toBe("unknown");
		expect(title.length).toBeGreaterThan(5);
	});

	test("extractTitle returns unknown for unrecognized format", () => {
		const title = extractTitle(
			"Just some random text without a title pattern.",
		);
		expect(title).toBe("unknown");
	});
});

// ── 4. normalizeLawName ──

describe("normalizeLawName", () => {
	test("Ley Orgánica → lo", () => {
		const result = normalizeLawName(
			"Ley Orgánica 10/1995, de 23 de noviembre, del Código Penal",
		);
		expect(result).toContain("lo 10/1995");
	});

	test("Real Decreto-ley → rdl", () => {
		const result = normalizeLawName("Real Decreto-ley 5/2023");
		expect(result).toContain("rdl");
	});

	test("Real Decreto Legislativo → rdleg (NOT rdl)", () => {
		const result = normalizeLawName("Real Decreto Legislativo 2/2015");
		expect(result).toContain("rdleg");
		// The normalized form should be "rdleg 2/2015"
		expect(result).toBe("rdleg 2/2015");
	});

	test("lowercases and normalizes whitespace", () => {
		const result = normalizeLawName("Ley  39/2015");
		expect(result).toBe("ley 39/2015");
	});

	test("strips date clause with full date pattern", () => {
		// The regex strips ", de DD de MONTH de YYYY"
		const result = normalizeLawName(
			"Ley 39/2015, de 1 de octubre de 2015, del Procedimiento Administrativo Común",
		);
		expect(result).not.toContain("octubre");
		expect(result).toContain("ley 39/2015");
	});
});

// ── 5. lawNamesMatch ──

describe("lawNamesMatch", () => {
	test("exact same name → true", () => {
		expect(
			lawNamesMatch(
				"Ley Orgánica 10/1995, del Código Penal",
				"Ley Orgánica 10/1995, del Código Penal",
			),
		).toBe(true);
	});

	test('"Código Penal" matches "Ley Orgánica 10/1995, del Código Penal"', () => {
		expect(
			lawNamesMatch("Código Penal", "Ley Orgánica 10/1995, del Código Penal"),
		).toBe(true);
	});

	test('"Ley 39/2015" does NOT match "Ley 39/2006"', () => {
		expect(
			lawNamesMatch(
				"Ley 39/2015, de Procedimiento Administrativo",
				"Ley 39/2006, de Promoción de la Autonomía Personal",
			),
		).toBe(false);
	});

	test("completely unrelated laws → false", () => {
		expect(
			lawNamesMatch(
				"Ley Orgánica del Poder Judicial",
				"Estatuto de los Trabajadores",
			),
		).toBe(false);
	});
});

// ── 6. extractQuotedText ──

describe("extractQuotedText", () => {
	test("single «...» block → returns content", () => {
		const text = "Se modifica:\n«Nuevo texto del artículo.»\nFin.";
		const result = extractQuotedText(text);
		expect(result).toBe("Nuevo texto del artículo.");
	});

	test("multiple «...» blocks → returns all concatenated", () => {
		const text = "«Primer bloque.»\nTexto intermedio.\n«Segundo bloque.»";
		const result = extractQuotedText(text);
		expect(result).toBe("Primer bloque.\n\nSegundo bloque.");
	});

	test("no quotes → returns empty string", () => {
		const result = extractQuotedText(
			"Texto sin comillas angulares de ningún tipo.",
		);
		expect(result).toBe("");
	});

	test("nested content with newlines inside quotes", () => {
		const text = "«Línea uno.\nLínea dos.\nLínea tres.»";
		const result = extractQuotedText(text);
		expect(result).toContain("Línea uno.");
		expect(result).toContain("Línea tres.");
	});
});
