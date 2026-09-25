// Bing Webmaster Tools flags `<title>` over ~70 characters as "Title too
// long"; Google truncates around 60. The BOE title is the official, legally
// precise name (long, full of subordinate clauses) and is never shortened
// anywhere but here — the `<h1>` and `og:title` keep it in full. See
// seo-title.ts for the full rationale.
import { describe, expect, test } from "bun:test";
import { codePointLength } from "../meta-description.ts";
import {
	composeSeoTitle,
	heuristicSubject,
	lawAbbreviation,
	POPULAR_LAW_NAMES,
	SEO_TITLE_MAX,
	SEO_TITLE_SUFFIX,
	SEO_TITLE_TARGET,
	seoLawPageTitle,
	shortLawTitle,
} from "../seo-title.ts";

describe("lawAbbreviation", () => {
	test("rank + number", () => {
		expect(
			lawAbbreviation(
				"ley",
				"Ley 27/2014, de 27 de noviembre, del Impuesto sobre Sociedades",
			),
		).toBe("L 27/2014");
		expect(
			lawAbbreviation(
				"real_decreto_legislativo",
				"Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores",
			),
		).toBe("RDLeg 2/2015");
	});

	test("no abbreviation for an unmapped rank", () => {
		expect(
			lawAbbreviation("instruccion", "Instrucción 1/2021, de 2 de noviembre"),
		).toBeUndefined();
	});

	test("no number in the title → no abbreviation, even for a mapped rank", () => {
		// The 1882 Ley de Enjuiciamiento Criminal was approved by a dated Real
		// Decreto, not a numbered one.
		expect(
			lawAbbreviation(
				"real_decreto",
				"Real Decreto de 14 de septiembre de 1882 por el que se aprueba la Ley de Enjuiciamiento Criminal",
			),
		).toBeUndefined();
	});
});

describe("heuristicSubject", () => {
	test("strips the date clause and rank+number+connector prefix", () => {
		expect(
			heuristicSubject(
				"Ley 27/2014, de 27 de noviembre, del Impuesto sobre Sociedades",
			),
		).toBe("Impuesto sobre Sociedades");
	});

	test("strips 'texto refundido de la Ley' boilerplate down to the subject", () => {
		expect(
			heuristicSubject(
				"Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores",
			),
		).toBe("Estatuto de los Trabajadores");
	});

	test("keeps a direct 'de' subject when there is no del/de la/sobre connector", () => {
		expect(
			heuristicSubject(
				"Real Decreto Legislativo 1/2007, de 16 de noviembre, por el que se aprueba el texto refundido de la Ley General para la Defensa de los Consumidores y Usuarios y otras leyes complementarias",
			),
		).toBe("General para la Defensa de los Consumidores y Usuarios");
	});

	test("strips a 'sobre' connector", () => {
		expect(
			heuristicSubject(
				"Real Decreto Legislativo 6/2015, de 30 de octubre, por el que se aprueba el texto refundido de la Ley sobre Tráfico, Circulación de Vehículos a Motor y Seguridad Vial",
			),
		).toBe("Tráfico, Circulación de Vehículos a Motor y Seguridad Vial");
	});

	test("keeps a title with no boilerplate unchanged", () => {
		expect(heuristicSubject("Constitución Española")).toBe(
			"Constitución Española",
		);
		expect(heuristicSubject("Código Civil")).toBe("Código Civil");
	});

	test("preserves Spanish orthography (accents, ñ)", () => {
		expect(
			heuristicSubject(
				"Ley Orgánica 3/2018, de 5 de diciembre, de Protección de Datos Personales y garantía de los derechos digitales",
			),
		).toBe(
			"Protección de Datos Personales y garantía de los derechos digitales",
		);
	});
});

describe("shortLawTitle", () => {
	const CASES: { id: string; rango: string; titulo: string }[] = [
		{
			// Not the curated BOE-A-2014-12328 id on purpose: exercises the plain
			// heuristic path (no popular-name override) for this assertion.
			id: "BOE-A-2014-99999",
			rango: "ley",
			titulo: "Ley 27/2014, de 27 de noviembre, del Impuesto sobre Sociedades",
		},
		{
			id: "BOE-A-2018-16673",
			rango: "ley_organica",
			titulo:
				"Ley Orgánica 3/2018, de 5 de diciembre, de Protección de Datos Personales y garantía de los derechos digitales",
		},
		{
			id: "BOE-A-2007-20555",
			rango: "real_decreto_legislativo",
			titulo:
				"Real Decreto Legislativo 1/2007, de 16 de noviembre, por el que se aprueba el texto refundido de la Ley General para la Defensa de los Consumidores y Usuarios y otras leyes complementarias",
		},
		{
			id: "BOE-A-2015-11722",
			rango: "real_decreto_legislativo",
			titulo:
				"Real Decreto Legislativo 6/2015, de 30 de octubre, por el que se aprueba el texto refundido de la Ley sobre Tráfico, Circulación de Vehículos a Motor y Seguridad Vial",
		},
		{
			id: "BOE-A-1978-31229",
			rango: "constitucion",
			titulo: "Constitución Española",
		},
	];

	test("appends the abbreviation in parentheses when it fits", () => {
		expect(shortLawTitle(CASES[0]!)).toBe(
			"Impuesto sobre Sociedades (L 27/2014)",
		);
	});

	test("uses the popular curated name when available", () => {
		expect(POPULAR_LAW_NAMES["BOE-A-2015-11430"]).toBeDefined();
		expect(
			shortLawTitle({
				id: "BOE-A-2015-11430",
				rango: "real_decreto_legislativo",
				titulo:
					"Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores",
			}),
		).toBe("Estatuto de los Trabajadores (RDLeg 2/2015)");
	});

	test("never exceeds the given budget", () => {
		for (const c of CASES) {
			expect(codePointLength(shortLawTitle(c, 40))).toBeLessThanOrEqual(40);
		}
	});

	test("drops the abbreviation before truncating a long subject", () => {
		const long = shortLawTitle(
			{
				id: "x",
				rango: "ley",
				titulo:
					"Ley 1/2005, de 9 de marzo, por la que se regula el régimen del comercio de derechos de emisión de gases de efecto invernadero",
			},
			45,
		);
		expect(long).not.toContain("(L 1/2005)");
		expect(codePointLength(long)).toBeLessThanOrEqual(45);
	});

	test("a title with no boilerplate and no number keeps its name as-is", () => {
		expect(shortLawTitle(CASES[4]!)).toBe("Constitución Española");
	});
});

describe("composeSeoTitle", () => {
	test("appends the suffix when it fits", () => {
		expect(composeSeoTitle("Constitución Española")).toBe(
			`Constitución Española${SEO_TITLE_SUFFIX}`,
		);
	});

	test("drops the suffix rather than truncating the core when it doesn't fit", () => {
		const core =
			"Financiación del sistema de transporte público de Cataluña (L 21/2015)"; // 72 chars
		expect(codePointLength(core)).toBeGreaterThan(
			SEO_TITLE_MAX - SEO_TITLE_SUFFIX.length,
		);
		const result = composeSeoTitle(core);
		expect(result).toBe(core);
		expect(result.endsWith(SEO_TITLE_SUFFIX)).toBe(false);
	});

	test("truncates only as a last resort, when even the bare core overflows max", () => {
		const veryLong = "Ley de ".repeat(20).trim();
		const result = composeSeoTitle(veryLong);
		expect(codePointLength(result)).toBeLessThanOrEqual(SEO_TITLE_MAX);
		expect(result.endsWith("…")).toBe(true);
	});

	test("never produces a dangling connector word right before the ellipsis", () => {
		const veryLong =
			"Por la que se modifican determinados artículos de la Ley 25/1983, de 26 de diciembre, de Incompatibilidades de Altos Cargos";
		const result = composeSeoTitle(veryLong, 40);
		expect(result.endsWith("…")).toBe(true);
		expect(result).not.toMatch(/\s(?:de|del|la|el|los|las|y|o|en|a)…$/i);
	});
});

describe("seoLawPageTitle", () => {
	test("hard cap: never exceeds SEO_TITLE_MAX for any of the flagged laws", () => {
		const flagged: { id: string; rango: string; titulo: string }[] = [
			{
				id: "BOE-A-2014-12328",
				rango: "ley",
				titulo:
					"Ley 27/2014, de 27 de noviembre, del Impuesto sobre Sociedades",
			},
			{
				id: "BOE-A-2015-11430",
				rango: "real_decreto_legislativo",
				titulo:
					"Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores",
			},
			{
				id: "BOE-A-2018-16673",
				rango: "ley_organica",
				titulo:
					"Ley Orgánica 3/2018, de 5 de diciembre, de Protección de Datos Personales y garantía de los derechos digitales",
			},
			{
				id: "BOE-A-2007-20555",
				rango: "real_decreto_legislativo",
				titulo:
					"Real Decreto Legislativo 1/2007, de 16 de noviembre, por el que se aprueba el texto refundido de la Ley General para la Defensa de los Consumidores y Usuarios y otras leyes complementarias",
			},
			{
				id: "BOE-A-2015-11722",
				rango: "real_decreto_legislativo",
				titulo:
					"Real Decreto Legislativo 6/2015, de 30 de octubre, por el que se aprueba el texto refundido de la Ley sobre Tráfico, Circulación de Vehículos a Motor y Seguridad Vial",
			},
		];
		for (const law of flagged) {
			const title = seoLawPageTitle(law);
			expect(codePointLength(title)).toBeLessThanOrEqual(SEO_TITLE_MAX);
			// Sanity: comfortably shorter than the live (buggy) titles it replaces.
			expect(codePointLength(title)).toBeLessThan(codePointLength(law.titulo));
		}
	});

	test("Constitución Española stays short and unmodified in substance", () => {
		expect(
			seoLawPageTitle({
				id: "BOE-A-1978-31229",
				rango: "constitucion",
				titulo: "Constitución Española",
			}),
		).toBe("Constitución Española — Ley Abierta");
	});

	test("target: the curated/short cases land at or under SEO_TITLE_TARGET", () => {
		const title = seoLawPageTitle({
			id: "BOE-A-2015-11430",
			rango: "real_decreto_legislativo",
			titulo:
				"Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores",
		});
		expect(codePointLength(title)).toBeLessThanOrEqual(SEO_TITLE_TARGET);
	});
});
