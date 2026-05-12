/**
 * Tests for `pickMostRelevantMateria` — opt-in materia relevance scorer.
 *
 * Background: the v3-50 audit (2026-05-11) found ~40% materia mislabels
 * because the legacy assignment picks the first materia from the BOE's
 * norm-level list that happens to be in the corpus top-set. The
 * relevance-based picker scores each candidate materia against the
 * article text via simple token overlap.
 *
 * Behavior off by default (EVAL_MATERIA_RELEVANCE=1 to enable in toSeed).
 */

import { describe, expect, test } from "bun:test";
import { pickMostRelevantMateria } from "./strata.ts";

describe("pickMostRelevantMateria", () => {
	test("picks the materia whose tokens overlap the article text", () => {
		const materias = ["Autorizaciones", "Pesca", "Comercio interior"];
		const articleText =
			"Para realizar actividades de pesca en aguas costeras se requerirá la previa habilitación del buque ante la capitanía marítima.";
		const topSet = new Set(materias);
		// "Pesca" → token "pesca" appears in article → wins.
		expect(pickMostRelevantMateria(materias, articleText, topSet)).toBe(
			"Pesca",
		);
	});

	test("falls back to legacy first-in-top-set when nothing scores", () => {
		// Article doesn't mention any of the materia keywords.
		const materias = ["Aviación civil", "Telecomunicaciones"];
		const articleText =
			"La administración llevará un registro centralizado de los expedientes que se tramiten.";
		const topSet = new Set(["Telecomunicaciones"]);
		// Legacy fallback: "Telecomunicaciones" is in top-set (Aviación civil is not).
		expect(pickMostRelevantMateria(materias, articleText, topSet)).toBe(
			"Telecomunicaciones",
		);
	});

	test("single-materia input returns it directly", () => {
		expect(
			pickMostRelevantMateria(
				["Función pública"],
				"Cualquier funcionario podrá solicitar el reingreso.",
				new Set(),
			),
		).toBe("Función pública");
	});

	test("empty input returns _unclassified", () => {
		expect(pickMostRelevantMateria([], "texto cualquiera", new Set())).toBe(
			"_unclassified",
		);
	});

	test("handles diacritics correctly (carpintería → carpinteria)", () => {
		// Article is about FP curriculum for carpentry. The right materia is
		// "Formación profesional", not "Carpintería" (which is the trade, not
		// the legal subject).
		const materias = ["Carpintería", "Formación profesional", "Educación"];
		const articleText =
			"Los alumnos de formación profesional básica cursarán contenidos prácticos en el taller designado por el centro educativo.";
		const topSet = new Set(materias);
		// "formacion" + "profesional" both appear → score 2.
		// "carpinteria" → 0 (not in this article body).
		// "educacion" → "educativo" doesn't match (stem mismatch); 0.
		expect(pickMostRelevantMateria(materias, articleText, topSet)).toBe(
			"Formación profesional",
		);
	});

	test("tiebreaker: top-set membership wins on equal scores", () => {
		// Both materias score 0 against the article → legacy fallback applies.
		const materias = ["X random", "Y random"];
		const articleText = "lorem ipsum dolor sit amet";
		const topSet = new Set(["Y random"]);
		expect(pickMostRelevantMateria(materias, articleText, topSet)).toBe(
			"Y random",
		);
	});

	test("documented bug case: SICAV question would prefer 'IIC' over 'Autorizaciones'", () => {
		// Audit example q_b2dcf0a9: SICAV recompra acciones, labeled
		// "Autorizaciones" but should be "IIC".
		const materias = [
			"Autorizaciones",
			"Instituciones de inversión colectiva",
			"Banca",
		];
		const articleText =
			"Las sociedades de inversión colectiva podrán recomprar sus propias acciones siempre que se respete el patrimonio mínimo legal.";
		const topSet = new Set(materias);
		// "inversion" + "colectiva" appear → score 2.
		// "autorizaciones" → 0 in this snippet.
		// "banca" → 0.
		expect(pickMostRelevantMateria(materias, articleText, topSet)).toBe(
			"Instituciones de inversión colectiva",
		);
	});
});
