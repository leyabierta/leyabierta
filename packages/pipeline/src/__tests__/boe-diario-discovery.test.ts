import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sumario } from "../spain/boe-diario-client.ts";
import { BoeDiarioDiscovery } from "../spain/boe-diario-discovery.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

function loadSumario(): Sumario {
	const raw = readFileSync(
		join(FIXTURES_DIR, "sumario-20260723.json"),
		"utf-8",
	);
	return JSON.parse(raw).data.sumario as Sumario;
}

describe("BoeDiarioDiscovery", () => {
	test("yields Sección I items from the real sumario fixture", () => {
		const discovery = new BoeDiarioDiscovery();
		const items = [...discovery.discover(loadSumario())];

		expect(items).toHaveLength(10);
		expect(items.every((i) => i.section === "1")).toBe(true);
		expect(items.map((i) => i.id)).toContain("BOE-A-2026-16010");

		const rd609 = items.find((i) => i.id === "BOE-A-2026-16010")!;
		expect(rd609.titulo).toContain("Programa Auto+");
		expect(rd609.urlXml).toBe(
			"https://www.boe.es/diario_boe/xml.php?id=BOE-A-2026-16010",
		);
	});

	test("respects a custom section filter", () => {
		const discovery = new BoeDiarioDiscovery();
		const items = [...discovery.discover(loadSumario(), ["3"])];

		expect(items.length).toBeGreaterThan(0);
		expect(items.every((i) => i.section === "3")).toBe(true);
	});

	test("handles a department with a single item as a bare object, not an array", () => {
		// The real BOE API collapses single-element lists to a bare object.
		// This synthetic sumario exercises that shape at every level:
		// seccion, departamento, epigrafe, and item are all single objects.
		const sumario = {
			diario: {
				seccion: {
					codigo: "1",
					nombre: "I. Disposiciones generales",
					departamento: {
						codigo: "9591",
						nombre: "MINISTERIO DE EJEMPLO",
						epigrafe: {
							nombre: "Ejemplo",
							item: {
								identificador: "BOE-A-2026-99999",
								titulo: "Norma de ejemplo.",
								url_xml:
									"https://www.boe.es/diario_boe/xml.php?id=BOE-A-2026-99999",
							},
						},
					},
				},
			},
		};

		const discovery = new BoeDiarioDiscovery();
		const items = [...discovery.discover(sumario)];

		expect(items).toEqual([
			{
				id: "BOE-A-2026-99999",
				section: "1",
				titulo: "Norma de ejemplo.",
				urlXml: "https://www.boe.es/diario_boe/xml.php?id=BOE-A-2026-99999",
			},
		]);
	});

	test("handles a department with item nested directly (no epigrafe level)", () => {
		// Sección V (anuncios) in the real API goes straight from
		// departamento to item, with no intermediate epigrafe.
		const sumario = {
			diario: [
				{
					seccion: [
						{
							codigo: "5A",
							departamento: [
								{
									nombre: "MINISTERIO DE EJEMPLO",
									item: [
										{
											identificador: "BOE-B-2026-1",
											titulo: "Anuncio.",
											url_xml:
												"https://www.boe.es/diario_boe/xml.php?id=BOE-B-2026-1",
										},
									],
								},
							],
						},
					],
				},
			],
		};

		const discovery = new BoeDiarioDiscovery();
		const items = [...discovery.discover(sumario, ["5A"])];

		expect(items).toHaveLength(1);
		expect(items[0]!.id).toBe("BOE-B-2026-1");
	});

	test("returns nothing for an empty sumario", () => {
		const discovery = new BoeDiarioDiscovery();
		expect([...discovery.discover({})]).toEqual([]);
	});
});
