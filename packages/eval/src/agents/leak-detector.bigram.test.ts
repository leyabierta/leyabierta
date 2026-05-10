/**
 * Tests for `detectBigramOverlap`.
 *
 * Added after the 2026-05-10 pilot 50 review (§5.2 / §6.2), which found
 * 5/51 accepted questions had multi-word phrases lifted verbatim from
 * the seed article. Single-token rare-overlap missed these because the
 * giveaway is the COLLOCATION ("organización de productores", "importe
 * recuperado"), not any individual rare token.
 */

import { describe, expect, test } from "bun:test";
import { detectBigramOverlap } from "./prompts/leak-detector.ts";

describe("detectBigramOverlap", () => {
	test("catches q_16480dd7-style leak (organización de productores etc.)", () => {
		const article =
			"La organización de productores deberá repartir el importe recuperado por la baja de un socio entre las inversiones subvencionadas que estuvieran en curso.";
		const question =
			"¿Cómo debe la organización de productores repartir el importe recuperado por la baja de un socio en sus inversiones subvencionadas?";
		const result = detectBigramOverlap(question, article);
		expect(result).not.toBeNull();
		expect(result?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("catches q_1c1a5aac-style leak (preselección + selección final + Servicios Públicos de Empleo)", () => {
		const article =
			"Los Servicios Públicos de Empleo realizarán una preselección de candidatos. La selección final corresponderá a la empresa.";
		const question =
			"¿Quién hace la preselección y la selección final cuando los Servicios Públicos de Empleo intermedian en una contratación?";
		const result = detectBigramOverlap(question, article);
		expect(result).not.toBeNull();
		expect(result?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("does NOT flag good citizen questions (single shared token only)", () => {
		const article =
			"El arrendador devolverá la fianza al arrendatario en el plazo de un mes desde la entrega de las llaves, salvo que existan daños imputables al inquilino.";
		const question = "no me devuelven la fianza del piso";
		const result = detectBigramOverlap(question, article);
		expect(result).toBeNull();
	});

	test("does NOT flag formal-but-clean questions on teletrabajo", () => {
		const article =
			"Se reconoce el derecho al trabajo a distancia siempre que las circunstancias del puesto lo permitan y exista acuerdo entre las partes.";
		const question = "¿Puedo trabajar desde casa?";
		const result = detectBigramOverlap(question, article);
		expect(result).toBeNull();
	});

	// ── Pilot 100 stopword-bridge cases (REVIEW-PILOT100 §5.1) ────────
	test("catches Fondo de mejora de barrios (skip-bigram across 'de')", () => {
		const article =
			"El Fondo de mejora de barrios financiará actuaciones en zonas degradadas.";
		const question = "¿Qué destino tiene el Fondo de mejora de barrios?";
		const result = detectBigramOverlap(question, article);
		expect(result).not.toBeNull();
		expect(result?.matched).toContain("fondo mejora");
		expect(result?.matched).toContain("mejora barrio");
		expect(result?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("catches q_e756e899-style leak (Fondo de mejora de barrios)", () => {
		const article =
			"El Fondo de mejora de barrios financiará actuaciones en zonas degradadas, con criterios de prioridad establecidos por la Generalitat.";
		const question =
			"¿Qué destino debe darse a los recursos del Fondo de mejora de barrios cuando se trata de zonas degradadas?";
		const result = detectBigramOverlap(question, article);
		expect(result).not.toBeNull();
		expect(result?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("catches q_53184b45-style leak (garantía provisional + concurso de urbanización)", () => {
		const article =
			"En todo concurso de urbanización privada el promotor deberá depositar una garantía provisional equivalente al 2% del presupuesto.";
		const question =
			"¿Cuál es la cuantía de la garantía provisional exigida en un concurso de urbanización privada?";
		const result = detectBigramOverlap(question, article);
		expect(result).not.toBeNull();
		expect(result?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("catches q_de6c334d-style leak (zona consolidada + servicios y dotaciones)", () => {
		const article =
			"Se considerará zona consolidada aquella en la que existan servicios y dotaciones suficientes según el planeamiento vigente.";
		const question =
			"¿Cómo se calcula el impuesto en una zona consolidada con servicios y dotaciones suficientes?";
		const result = detectBigramOverlap(question, article);
		expect(result).not.toBeNull();
		expect(result?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("catches q_77759121-style leak (cuentas de la comarca + pleno apruebe)", () => {
		const article =
			"Las cuentas de la comarca se someterán al pleno antes del 1 de junio; mientras el pleno no las apruebe, permanecerán en exposición pública.";
		const question =
			"¿Qué pasa con las cuentas de la comarca antes de que el pleno las apruebe?";
		const result = detectBigramOverlap(question, article);
		expect(result).not.toBeNull();
		expect(result?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("catches q_a154014a-style leak (administración periférica + ministerios)", () => {
		const article =
			"La administración periférica del Estado dependerá orgánicamente de los ministerios competentes en cada materia.";
		const question =
			"¿Cómo se coordinan la administración periférica y los ministerios competentes?";
		const result = detectBigramOverlap(question, article);
		expect(result).not.toBeNull();
		expect(result?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("catches q_62a7f612-style leak (movilidad territorial + transporte colectivo)", () => {
		const article =
			"Los planes de movilidad territorial incorporarán medidas de transporte colectivo orientadas a la sostenibilidad y accesibilidad.";
		const question =
			"¿Qué medidas de movilidad territorial y transporte colectivo se adoptan para garantizar la sostenibilidad y accesibilidad?";
		const result = detectBigramOverlap(question, article);
		expect(result).not.toBeNull();
		expect(result?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("catches q_784d0693-style leak (cuenta única + trazabilidad del expediente judicial)", () => {
		const article =
			"Se establece una cuenta única de depósitos y consignaciones que permitirá la trazabilidad del expediente judicial.";
		const question =
			"¿Cómo funciona la cuenta única para garantizar la trazabilidad del expediente judicial?";
		const result = detectBigramOverlap(question, article);
		expect(result).not.toBeNull();
		expect(result?.matched.length).toBeGreaterThanOrEqual(2);
	});

	test("threshold = 2: 1 shared bigram passes, 2 fails", () => {
		const article =
			"La actualización de precios se realizará anualmente conforme al índice oficial publicado.";
		const question1 = "como funciona la actualización de precios";
		// Only 1 shared bigram ("actualizacion precios"): should NOT fire.
		expect(detectBigramOverlap(question1, article)).toBeNull();

		const article2 =
			"La actualización de precios y el régimen retributivo se ajustarán cada año.";
		const question2 =
			"como funciona la actualización de precios y el régimen retributivo";
		// Two shared bigrams: "actualizacion precios" and "regimen retributivo".
		const result2 = detectBigramOverlap(question2, article2);
		expect(result2).not.toBeNull();
		expect(result2?.matched.length).toBeGreaterThanOrEqual(2);
	});
});
