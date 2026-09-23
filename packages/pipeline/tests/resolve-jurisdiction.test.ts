/**
 * Canonical jurisdiction resolution (spain/jurisdictions.ts).
 *
 * Regression: BOE-A-2026-10117 (La Rioja), BOE-A-2026-12186 and
 * BOE-A-2026-13298 (Asturias) were fetched before the BOE assigned their ELI.
 * With no `url_eli` and a `BOE-A` id the old resolvers fell back to `es` and
 * the pipeline wrote them into `es/`.
 */

import { describe, expect, test } from "bun:test";
import type { NormMetadata } from "../src/models.ts";
import { BoeMetadataParser } from "../src/spain/boe-metadata.ts";
import {
	jurisdictionFromDepartment,
	resolveJurisdiction,
	type SpainJurisdiction,
} from "../src/spain/jurisdictions.ts";
import { normToFilepath } from "../src/transform/slug.ts";

const NO_ELI = (id: string) => `https://www.boe.es/buscar/act.php?id=${id}`;

describe("resolveJurisdiction", () => {
	test("ELI URL wins over everything else", () => {
		expect(
			resolveJurisdiction({
				id: "BOE-A-2026-10117",
				source: "https://www.boe.es/eli/es-ri/l/2026/04/28/2",
				department: "Comunidad Autónoma del Principado de Asturias",
				country: "es",
			}),
		).toBe("es-ri");
	});

	test("regional bulletin prefix", () => {
		expect(resolveJurisdiction({ id: "BOJA-b-2024-1", source: "" })).toBe(
			"es-an",
		);
	});

	test("BOE-A autonomic law without ELI resolves by departamento", () => {
		const cases: [string, string, SpainJurisdiction][] = [
			["BOE-A-2026-10117", "Comunidad Autónoma de La Rioja", "es-ri"],
			[
				"BOE-A-2026-12186",
				"Comunidad Autónoma del Principado de Asturias",
				"es-as",
			],
			[
				"BOE-A-2026-13298",
				"Comunidad Autónoma del Principado de Asturias",
				"es-as",
			],
		];
		for (const [id, department, expected] of cases) {
			expect(
				resolveJurisdiction({
					id,
					source: NO_ELI(id),
					department,
					country: "es",
				}),
			).toBe(expected);
		}
	});

	test("departamento matching ignores accents, case and spacing", () => {
		expect(jurisdictionFromDepartment("comunitat  valenciana")).toBe("es-vc");
		expect(jurisdictionFromDepartment("COMUNIDAD DE CASTILLA Y LEON")).toBe(
			"es-cl",
		);
		expect(jurisdictionFromDepartment("Ministerio de Hacienda")).toBeNull();
	});

	test("every autonomous community has at least one departamento", () => {
		const covered = new Set(
			[
				"Comunidad Autónoma de Andalucía",
				"Comunidad Autónoma de Aragón",
				"Comunidad Autónoma del Principado de Asturias",
				"Comunidad Autónoma de Cantabria",
				"Comunidad de Castilla y León",
				"Comunidad Autónoma de Castilla-La Mancha",
				"Comunidad Autónoma de Canarias",
				"Comunidad Autónoma de Cataluña",
				"Comunidad Autónoma de Extremadura",
				"Comunidad Autónoma de Galicia",
				"Comunidad Autónoma de las Illes Balears",
				"Comunidad Autónoma de la Región de Murcia",
				"Comunidad de Madrid",
				"Comunidad Foral de Navarra",
				"Comunidad Autónoma del País Vasco",
				"Comunidad Autónoma de La Rioja",
				"Comunitat Valenciana",
			].map((d) => jurisdictionFromDepartment(d)),
		);
		expect(covered.size).toBe(17);
		expect(covered.has(null)).toBe(false);
	});

	test("an autonomic country already resolved is kept", () => {
		expect(
			resolveJurisdiction({
				id: "BOE-A-2026-1",
				source: NO_ELI("BOE-A-2026-1"),
				department: "",
				country: "es-as",
			}),
		).toBe("es-as");
	});

	test("state body without ELI is es", () => {
		expect(
			resolveJurisdiction({
				id: "BOE-A-1887-4896",
				source: NO_ELI("BOE-A-1887-4896"),
				department: "Ministerio de la Gobernación",
				country: "es",
			}),
		).toBe("es");
	});

	test("autonomic ámbito without a known community throws instead of es", () => {
		expect(() =>
			resolveJurisdiction({
				id: "BOE-A-2026-99999",
				source: NO_ELI("BOE-A-2026-99999"),
				department: "Consejería Desconocida",
				ambitoCode: "2",
			}),
		).toThrow(/Refusing to default to "es"/);
	});

	test("unknown regional departamento throws (Ceuta has no folder)", () => {
		expect(() =>
			resolveJurisdiction({
				id: "BOE-A-2026-99998",
				source: NO_ELI("BOE-A-2026-99998"),
				department: "Ciudad de Ceuta",
				country: "es",
			}),
		).toThrow(/Cannot resolve the jurisdiction/);
	});

	test("unknown ELI jurisdiction throws", () => {
		expect(() =>
			resolveJurisdiction({
				id: "BOE-A-2026-1",
				source: "https://www.boe.es/eli/es-zz/l/2026/01/01/1",
			}),
		).toThrow(/Unknown ELI jurisdiction/);
	});
});

describe("regression: autonomic BOE-A law fetched before its ELI", () => {
	const parser = new BoeMetadataParser();
	// Shape of /metadatos for BOE-A-2026-10117 when first fetched: no url_eli.
	const item = {
		identificador: "BOE-A-2026-10117",
		ambito: { codigo: "2", texto: "Autonómico" },
		departamento: { codigo: "8110", texto: "Comunidad Autónoma de La Rioja" },
		rango: { codigo: "1300", texto: "Ley" },
		titulo:
			"Ley 2/2026, de 28 de abril, de simplificación administrativa, mercado abierto y calidad normativa.",
		fecha_publicacion: "20260511",
		fecha_vigencia: "20260430",
		estatus_derogacion: "N",
		vigencia_agotada: "N",
	};
	const encode = (obj: unknown) =>
		new TextEncoder().encode(JSON.stringify(obj));

	test("metadata.country is es-ri and the file goes to es-ri/", () => {
		const meta = parser.parse(encode({ data: [item] }), "BOE-A-2026-10117");
		expect(meta.source).toBe(NO_ELI("BOE-A-2026-10117"));
		expect(meta.country).toBe("es-ri");
		expect(normToFilepath(meta)).toBe("es-ri/BOE-A-2026-10117.md");
	});

	test("a stale cache entry with country es still lands in es-ri/", () => {
		const meta = {
			id: "BOE-A-2026-10117",
			source: NO_ELI("BOE-A-2026-10117"),
			department: "Comunidad Autónoma de La Rioja",
			country: "es",
		} as NormMetadata;
		expect(normToFilepath(meta)).toBe("es-ri/BOE-A-2026-10117.md");
	});

	test("an autonomic ámbito with an unknown departamento fails loudly", () => {
		const data = encode({
			data: [
				{ ...item, departamento: { codigo: "0", texto: "Organismo nuevo" } },
			],
		});
		expect(() => parser.parse(data, "BOE-A-2026-10117")).toThrow(
			/Cannot resolve the jurisdiction/,
		);
	});
});
