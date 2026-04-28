/**
 * Unit tests for the heuristic eval-v2 register tagger. The classifier is
 * deterministic and operates on a single question string, so tests cover
 * representative queries from each register plus the borderline cases
 * the heuristic is most likely to mis-call.
 */

import { describe, expect, test } from "bun:test";
import { classifyRegister } from "../../research/tag-eval-register-heuristic.ts";

describe("classifyRegister", () => {
	test("procedural: ¿dónde / ¿cómo / ¿cuándo with action verb", () => {
		expect(classifyRegister("¿Dónde puedo presentar el modelo 100?")).toBe(
			"procedural",
		);
		expect(classifyRegister("¿Cómo solicito el certificado de penales?")).toBe(
			"procedural",
		);
		expect(
			classifyRegister("¿Cuándo puedo recurrir una multa de tráfico?"),
		).toBe("procedural");
	});

	test("procedural: anchor verbs without opener", () => {
		expect(classifyRegister("plazo para recurrir una multa")).toBe(
			"procedural",
		);
		expect(classifyRegister("trámite cambio situación administrativa")).toBe(
			"procedural",
		);
	});

	test("formal: ¿cómo regula X la Y? is conceptual, not procedural", () => {
		expect(
			classifyRegister(
				"¿Cómo regula Cataluña las sucesiones y herencias en su código civil?",
			),
		).toBe("formal");
	});

	test("informal: lowercase Google-style", () => {
		expect(classifyRegister("cuanto tarda hacienda en reclamar")).toBe(
			"informal",
		);
		expect(classifyRegister("baja maternidad cuantos meses")).toBe("informal");
		expect(classifyRegister("despido improcedente indemnizacion")).toBe(
			"informal",
		);
	});

	test("informal: first-person casual self-reference, short", () => {
		expect(
			classifyRegister("¿Me puede subir el alquiler mi casero cuando quiera?"),
		).toBe("informal");
		expect(classifyRegister("¿Me deja mi jefe trabajar sin contrato?")).toBe(
			"informal",
		);
	});

	test("formal: long bureaucratic question with ¿", () => {
		expect(
			classifyRegister(
				"¿Cuál es el plazo de prescripción de los delitos contra la Hacienda Pública?",
			),
		).toBe("formal");
		expect(
			classifyRegister(
				"¿Qué naturaleza jurídica tienen las cofradías de pescadores en Galicia?",
			),
		).toBe("formal");
	});

	test("formal: bureaucratic question without first-person, despite ¿Cuánto", () => {
		expect(
			classifyRegister("¿Cuánto es el salario mínimo interprofesional?"),
		).toBe("formal");
	});

	test("informal: accentless question word at start", () => {
		expect(classifyRegister("cuanto cobro de paro si me despiden")).toBe(
			"informal",
		);
	});

	test("never returns an unknown register", () => {
		const samples = ["", "...", "   ", "qué", "a", "x".repeat(500)];
		for (const s of samples) {
			const r = classifyRegister(s);
			expect(["formal", "informal", "procedural"]).toContain(r);
		}
	});
});
