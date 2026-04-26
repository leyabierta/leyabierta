/**
 * Unit tests for normalizePeriodicTitle — periodic norm family detection.
 *
 * Annual decrees on the same topic (SMI, IPREM) should normalize to the
 * same family key so we can detect them and prefer the most recent one.
 * Different types of norms (regulatory frameworks vs annual decrees) should
 * NOT match each other.
 */

import { describe, expect, test } from "bun:test";
import { normalizePeriodicTitle } from "../services/rag/pipeline.ts";

describe("normalizePeriodicTitle", () => {
	test("annual SMI decrees normalize to same family", () => {
		const smi2026 = normalizePeriodicTitle(
			"Real Decreto 126/2026, de 18 de febrero, por el que se fija el salario mínimo interprofesional para 2026",
		);
		const smi2025 = normalizePeriodicTitle(
			"Real Decreto 87/2025, de 11 de febrero, por el que se fija el salario mínimo interprofesional para 2025",
		);
		const smi2024 = normalizePeriodicTitle(
			"Real Decreto 145/2024, de 6 de febrero, por el que se fija el salario mínimo interprofesional para 2024",
		);

		expect(smi2026).toBe(smi2025);
		expect(smi2025).toBe(smi2024);
		expect(smi2026).not.toBeNull();
	});

	test("SMI regulatory framework does NOT match annual SMI decrees", () => {
		const rdl2004 = normalizePeriodicTitle(
			"Real Decreto-ley 3/2004, de 25 de junio, para la racionalización de la regulación del salario mínimo interprofesional y para el incremento de su cuantía",
		);
		const smi2026 = normalizePeriodicTitle(
			"Real Decreto 126/2026, de 18 de febrero, por el que se fija el salario mínimo interprofesional para 2026",
		);

		expect(rdl2004).not.toBe(smi2026);
	});

	test("fundamental laws do not match each other", () => {
		const et = normalizePeriodicTitle(
			"Ley del Estatuto de los Trabajadores, texto refundido aprobado por Real Decreto Legislativo 2/2015, de 23 de octubre",
		);
		const ce = normalizePeriodicTitle("Constitución Española");

		// These should not be null (they're long enough) but should be different
		expect(et).not.toBe(ce);
	});

	test("short titles return null", () => {
		expect(normalizePeriodicTitle("Ley corta")).toBeNull();
		expect(normalizePeriodicTitle("")).toBeNull();
	});

	test("annual housing decrees normalize to same family", () => {
		const v2024 = normalizePeriodicTitle(
			"Decreto-ley 1/2024, de 19 de febrero, de medidas urgentes en materia de vivienda",
		);
		const v2025 = normalizePeriodicTitle(
			"Decreto-ley 1/2025, de 24 de febrero, de medidas urgentes en materia de vivienda",
		);

		expect(v2024).toBe(v2025);
		expect(v2024).not.toBeNull();
	});

	test("different regulatory topics do NOT match", () => {
		const smi = normalizePeriodicTitle(
			"Real Decreto 126/2026, de 18 de febrero, por el que se fija el salario mínimo interprofesional para 2026",
		);
		const peajes = normalizePeriodicTitle(
			"Orden ETU/1282/2017, de 22 de diciembre, por la que se establecen los peajes de acceso de energía eléctrica",
		);

		expect(smi).not.toBe(peajes);
	});
});
