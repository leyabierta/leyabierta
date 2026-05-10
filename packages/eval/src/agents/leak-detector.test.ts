/**
 * Smoke tests for `detectRareTermOverlap`.
 *
 * These are deterministic tests for the TF-IDF style leak check we added
 * after the 2026-05-10 pilot review (sections 5.2 / 5.3). They validate:
 *
 * 1. Two or more shared rare tokens between question and article fire.
 * 2. Common everyday tokens ("trabajo", "casa", "tiempo") never fire,
 *    even when they appear in both texts.
 * 3. The two real pilot leaks (q_d93cadb1 and q_5fab92fc) would now be
 *    caught by the rare-overlap layer.
 */

import { describe, expect, test } from "bun:test";
import { detectRareTermOverlap } from "./prompts/leak-detector.ts";

function freqMap(entries: Record<string, number>): Map<string, number> {
	return new Map(Object.entries(entries));
}

describe("detectRareTermOverlap", () => {
	test("flags 2+ rare shared tokens between question and article", () => {
		const article =
			"Las inversiones en biocombustibles avanzados y mejora genetica de cultivos energeticos quedan exentas.";
		const question =
			"que ayudas hay para biocombustibles y mejora genetica en cultivos";
		const freq = freqMap({
			biocombustibles: 0.001, // rare
			genetica: 0.002, // rare
			mejora: 0.06, // common
			cultivos: 0.04, // common
			ayudas: 0.05, // common
			energeticos: 0.01, // borderline
		});
		const result = detectRareTermOverlap(question, article, freq);
		expect(result).not.toBeNull();
		expect(result?.matched).toContain("biocombustibles");
		expect(result?.matched).toContain("genetica");
	});

	test("does NOT flag common everyday tokens", () => {
		const article =
			"En el ambito del trabajo, la persona pasa tiempo en su casa cuidando de su familia y de la casa.";
		const question =
			"cuanto tiempo puedo estar de baja en el trabajo si cuido a un familiar en casa";
		const freq = freqMap({
			trabajo: 0.4,
			tiempo: 0.5,
			casa: 0.3,
			familiar: 0.2,
			cuido: 0.05,
			familia: 0.25,
			persona: 0.6,
		});
		const result = detectRareTermOverlap(question, article, freq);
		expect(result).toBeNull();
	});

	test("does NOT flag a single rare overlap (default minRareCooccurrence=2)", () => {
		const article =
			"El colchon de capital se exigira a las entidades sistemicas conforme al manual.";
		const question = "como se calcula el colchon que pide el banco central";
		const freq = freqMap({
			colchon: 0.001,
			calcula: 0.2,
			banco: 0.1,
			central: 0.1,
		});
		const result = detectRareTermOverlap(question, article, freq);
		expect(result).toBeNull();
	});

	test("would have caught pilot q_d93cadb1 (biocombustibles + mejora genetica)", () => {
		const article =
			"Se incentivan los biocombustibles avanzados y la mejora genetica de variedades vegetales destinadas a la produccion energetica sostenible.";
		const question =
			"biocombustibles y mejora genetica que subvenciones hay para empresas";
		const freq = freqMap({
			biocombustibles: 0.0008,
			genetica: 0.0015,
			mejora: 0.08, // common
			subvenciones: 0.05,
			empresas: 0.3,
			que: 0.99,
			hay: 0.99,
			para: 0.99,
		});
		const result = detectRareTermOverlap(question, article, freq);
		expect(result).not.toBeNull();
		expect(result?.matched.sort()).toEqual(["biocombustibles", "genetica"]);
	});

	test("would have caught pilot q_5fab92fc (colchón de capital)", () => {
		// Lowercased, no diacritics: "colchon" + "capital" + "anticiclico"
		// all appear literally in the source article.
		const article =
			"Las entidades constituiran un colchon de capital anticiclico especifico aplicable a las exposiciones crediticias relevantes.";
		const question =
			"como se calcula el colchon de capital anticiclico para una entidad de credito";
		const freq = freqMap({
			colchon: 0.0009,
			capital: 0.08, // common-ish in legal corpus
			anticiclico: 0.0005,
			calcula: 0.2,
			entidad: 0.15,
			credito: 0.12,
		});
		const result = detectRareTermOverlap(question, article, freq);
		expect(result).not.toBeNull();
		expect(result?.matched).toContain("colchon");
		expect(result?.matched).toContain("anticiclico");
	});

	test("treats unseen tokens as extremely rare (freq=0)", () => {
		const article =
			"el documento describe un xenomorfico zorblax y un quetzalcoatlus dorado en el contexto regulatorio.";
		const question =
			"que es un xenomorfico zorblax y como se relaciona con el quetzalcoatlus dorado";
		const freq = freqMap({}); // empty: every token is "unseen" → freq 0
		const result = detectRareTermOverlap(question, article, freq);
		expect(result).not.toBeNull();
		// At least the three exotic tokens should appear.
		expect(result?.matched.length).toBeGreaterThanOrEqual(3);
	});
});
