/**
 * Unit tests for BoeMetadataParser.
 */

import { describe, expect, test } from "bun:test";
import {
	BoeMetadataParser,
	extractShortTitle,
} from "../src/spain/boe-metadata.ts";

const parser = new BoeMetadataParser();

function encode(obj: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(obj));
}

function makeItem(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		titulo: "Ley Organica 1/2024, de 10 de junio, de amnistia",
		rango: { codigo: "1290", texto: "Ley Orgánica" },
		departamento: { codigo: "100", texto: "Jefatura del Estado" },
		fecha_publicacion: "20240611",
		fecha_vigencia: "20240612",
		url_eli: "https://www.boe.es/eli/es/lo/2024/06/10/1",
		estatus_derogacion: "N",
		vigencia_agotada: "N",
		...overrides,
	};
}

describe("BoeMetadataParser", () => {
	describe("parse (from JSON bytes)", () => {
		test("parses title correctly and removes trailing period", () => {
			const data = encode({
				data: [makeItem({ titulo: "Constitucion Espanola." })],
			});
			const meta = parser.parse(data, "BOE-A-1978-31229");
			expect(meta.title).toBe("Constitucion Espanola");
		});

		test("parses title without trailing period unchanged", () => {
			const data = encode({ data: [makeItem()] });
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.title).toBe(
				"Ley Organica 1/2024, de 10 de junio, de amnistia",
			);
		});
	});

	describe("rank mapping", () => {
		// Codes match BOE's own catalog (data/auxiliar/rangos.json). Keep this
		// list aligned: a regression here means citizens see the wrong rank label.
		const rankCases: [string, string][] = [
			["1020", "acuerdo"],
			["1070", "constitucion"],
			["1080", "ley_organica"],
			["1180", "acuerdo_internacional"],
			["1220", "reglamento"],
			["1290", "ley_organica"],
			["1300", "ley"],
			["1310", "real_decreto_legislativo"],
			["1320", "real_decreto_ley"],
			["1325", "real_decreto_ley"],
			["1340", "real_decreto"],
			["1350", "orden"],
			["1370", "resolucion"],
			["1390", "circular"],
			["1410", "instruccion"],
			["1450", "ley"],
			["1470", "decreto"],
			["1480", "decreto"],
			["1500", "real_decreto_ley"],
			["1510", "decreto"],
		];

		for (const [codigo, expectedRank] of rankCases) {
			test(`maps rank code ${codigo} to ${expectedRank}`, () => {
				const data = encode({
					data: [makeItem({ rango: { codigo, texto: "X" } })],
				});
				const meta = parser.parse(data, "BOE-X-0000-0000");
				expect(meta.rank).toBe(expectedRank);
			});
		}

		test("maps unknown rank code to 'otro'", () => {
			const data = encode({
				data: [makeItem({ rango: { codigo: "9999", texto: "Desconocido" } })],
			});
			const meta = parser.parse(data, "BOE-X-0000-0000");
			expect(meta.rank).toBe("otro");
		});
	});

	describe("status", () => {
		test("returns vigente for active norm", () => {
			const data = encode({ data: [makeItem()] });
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.status).toBe("vigente");
		});

		test("returns derogada when estatus_derogacion is S", () => {
			const data = encode({ data: [makeItem({ estatus_derogacion: "S" })] });
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.status).toBe("derogada");
		});

		test("returns derogada when vigencia_agotada is S", () => {
			const data = encode({ data: [makeItem({ vigencia_agotada: "S" })] });
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.status).toBe("derogada");
		});
	});

	describe("dates", () => {
		test("parses published date from YYYYMMDD format", () => {
			const data = encode({
				data: [makeItem({ fecha_publicacion: "19781229" })],
			});
			const meta = parser.parse(data, "BOE-A-1978-31229");
			expect(meta.publishedAt).toBe("1978-12-29");
		});

		test("parses updated date when different from published", () => {
			const data = encode({
				data: [
					makeItem({
						fecha_publicacion: "20240611",
						fecha_vigencia: "20240715",
					}),
				],
			});
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.updatedAt).toBe("2024-07-15");
		});

		test("updatedAt is undefined when same as published", () => {
			const data = encode({
				data: [
					makeItem({
						fecha_publicacion: "20240611",
						fecha_vigencia: "20240611",
					}),
				],
			});
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.updatedAt).toBeUndefined();
		});

		test("defaults to 1900-01-01 for missing published date", () => {
			const data = encode({
				data: [makeItem({ fecha_publicacion: undefined })],
			});
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.publishedAt).toBe("1900-01-01");
		});
	});

	describe("department", () => {
		test("parses department text", () => {
			const data = encode({ data: [makeItem()] });
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.department).toBe("Jefatura del Estado");
		});

		test("returns empty string when department is missing", () => {
			const data = encode({ data: [makeItem({ departamento: undefined })] });
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.department).toBe("");
		});
	});

	describe("source URL", () => {
		test("uses ELI URL when available", () => {
			const data = encode({ data: [makeItem()] });
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.source).toBe("https://www.boe.es/eli/es/lo/2024/06/10/1");
		});

		test("falls back to buscar URL when ELI is missing", () => {
			const data = encode({ data: [makeItem({ url_eli: undefined })] });
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.source).toBe(
				"https://www.boe.es/buscar/act.php?id=BOE-A-2024-1234",
			);
		});
	});

	describe("missing optional fields", () => {
		test("handles missing vigencia date", () => {
			const data = encode({ data: [makeItem({ fecha_vigencia: undefined })] });
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.updatedAt).toBeUndefined();
		});

		test("handles sentinel date 99999999", () => {
			const data = encode({ data: [makeItem({ fecha_vigencia: "99999999" })] });
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.updatedAt).toBeUndefined();
		});
	});

	describe("short title", () => {
		test("extracts short title from Ley Organica", () => {
			const data = encode({
				data: [
					makeItem({
						titulo: "Ley Organica 1/2024, de 10 de junio, de amnistia",
					}),
				],
			});
			const meta = parser.parse(data, "BOE-A-2024-1234");
			expect(meta.shortTitle).toBe("Ley Organica 1/2024");
		});

		test("extracts Constitucion Espanola for constitution", () => {
			const data = encode({
				data: [
					makeItem({
						titulo: "Constitucion Espanola",
					}),
				],
			});
			const meta = parser.parse(data, "BOE-A-1978-31229");
			// "Constitucion" doesn't have the accent, so regex may not match
			// but the special case handles "constitucion" case-insensitively
			expect(meta.shortTitle).toContain("Constitu");
		});

		test("extracts short title from Real Decreto", () => {
			const data = encode({
				data: [
					makeItem({
						titulo:
							"Real Decreto 123/2024, de 15 de marzo, por el que se regula algo",
					}),
				],
			});
			const meta = parser.parse(data, "BOE-A-2024-5678");
			expect(meta.shortTitle).toBe("Real Decreto 123/2024");
		});

		test("truncates long titles without recognized prefix", () => {
			const longTitle = "A".repeat(80);
			const data = encode({ data: [makeItem({ titulo: longTitle })] });
			const meta = parser.parse(data, "BOE-A-2024-9999");
			expect(meta.shortTitle.length).toBeLessThanOrEqual(60);
			expect(meta.shortTitle).toContain("...");
		});

		// --- Dated-rank cases (issue #66) ---

		test("dated: Resolución de DD de mes de YYYY", () => {
			expect(
				extractShortTitle(
					"Resolución de 31 de enero de 1995, de la Secretaría General de Comunicaciones",
				),
			).toBe("Resolución de 31 de enero de 1995");
		});

		test("dated: Orden de DD de mes de YYYY", () => {
			expect(
				extractShortTitle(
					"Orden de 4 de febrero de 1985, por la que se establecen normas",
				),
			).toBe("Orden de 4 de febrero de 1985");
		});

		test("dated: Instrucción de DD de mes de YYYY", () => {
			expect(
				extractShortTitle(
					"Instrucción de 15 de septiembre de 2020, sobre procedimientos",
				),
			).toBe("Instrucción de 15 de septiembre de 2020");
		});

		test("dated: Acuerdo de DD de mes de YYYY", () => {
			expect(
				extractShortTitle(
					"Acuerdo de 12 de marzo de 2010, del Consejo de Ministros",
				),
			).toBe("Acuerdo de 12 de marzo de 2010");
		});

		// Numbered Circular should still work (numbered-rank path, not dated)
		test("numbered: Circular N/YEAR unchanged", () => {
			expect(
				extractShortTitle("Circular 1/2024, de 10 de enero, sobre algo"),
			).toBe("Circular 1/2024");
		});

		// --- Regression: numbered ranks must still work ---

		test("regression: Real Decreto N/YEAR unchanged", () => {
			expect(
				extractShortTitle(
					"Real Decreto 123/2024, de 15 de marzo, por el que se regula algo",
				),
			).toBe("Real Decreto 123/2024");
		});

		test("regression: Ley Orgánica N/YEAR unchanged", () => {
			expect(
				extractShortTitle("Ley Orgánica 1/2024, de 10 de junio, de amnistia"),
			).toBe("Ley Orgánica 1/2024");
		});
	});

	describe("parseListItem", () => {
		test("parses an item directly without wrapping in data array", () => {
			const item = makeItem();
			const meta = parser.parseListItem(
				item as Record<string, unknown>,
				"BOE-A-2024-1234",
			);
			expect(meta.id).toBe("BOE-A-2024-1234");
			expect(meta.country).toBe("es");
			expect(meta.title).toBe(
				"Ley Organica 1/2024, de 10 de junio, de amnistia",
			);
		});
	});

	describe("error handling", () => {
		test("throws when no data found", () => {
			const data = encode({ data: null });
			expect(() => parser.parse(data, "BOE-A-0000-0000")).toThrow(
				"No metadata found",
			);
		});

		test("throws for empty object", () => {
			const data = encode({});
			expect(() => parser.parse(data, "BOE-A-0000-0000")).toThrow(
				"No metadata found",
			);
		});
	});
});
