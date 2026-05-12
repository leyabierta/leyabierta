/**
 * Unit tests for getProgressLabel — the dynamic label function for the
 * /pregunta SSE progress stepper.
 */

import { describe, expect, test } from "bun:test";
import {
	getProgressLabel,
	type ProgressMetaAnalyzing,
	type ProgressMetaRanking,
	type ProgressMetaRetrieving,
	type ProgressMetaWriting,
} from "../components/AskChat.tsx";

describe("getProgressLabel — analyzing", () => {
	test("baseline (no meta)", () => {
		expect(getProgressLabel("analyzing")).toBe("Analizando tu pregunta");
	});

	test("with jurisdiction only", () => {
		const meta: ProgressMetaAnalyzing = { jurisdiction: "Cataluña" };
		expect(getProgressLabel("analyzing", meta)).toBe(
			"Analizando tu pregunta · **Cataluña**",
		);
	});

	test("with materia only", () => {
		const meta: ProgressMetaAnalyzing = {
			materias: ["Arrendamientos urbanos"],
		};
		expect(getProgressLabel("analyzing", meta)).toBe(
			"Analizando tu pregunta · **arrendamientos urbanos**",
		);
	});

	test("with jurisdiction + materia", () => {
		const meta: ProgressMetaAnalyzing = {
			jurisdiction: "estatal",
			materias: ["IRPF", "Trabajo"],
		};
		expect(getProgressLabel("analyzing", meta)).toBe(
			"Analizando tu pregunta · estatal · **irpf**",
		);
	});

	test("jurisdiction estatal shows 'estatal'", () => {
		const meta: ProgressMetaAnalyzing = { jurisdiction: "estatal" };
		expect(getProgressLabel("analyzing", meta)).toBe(
			"Analizando tu pregunta · **estatal**",
		);
	});

	test("empty materias array falls back to baseline", () => {
		const meta: ProgressMetaAnalyzing = { materias: [] };
		expect(getProgressLabel("analyzing", meta)).toBe("Analizando tu pregunta");
	});
});

describe("getProgressLabel — retrieving", () => {
	test("baseline (no meta)", () => {
		expect(getProgressLabel("retrieving")).toBe(
			"Buscando artículos relevantes",
		);
	});

	test("with corpusSize only", () => {
		const meta: ProgressMetaRetrieving = { corpusSize: 483983 };
		expect(getProgressLabel("retrieving", meta)).toBe(
			"Buscando entre **483.983 artículos**…",
		);
	});

	test("with corpusSize + candidatesCount", () => {
		const meta: ProgressMetaRetrieving = {
			corpusSize: 312341,
			candidatesCount: 147,
		};
		expect(getProgressLabel("retrieving", meta)).toBe(
			"**147 candidatos encontrados** entre 312.341 artículos",
		);
	});

	test("zero candidatesCount falls back to corpus-only label", () => {
		const meta: ProgressMetaRetrieving = {
			corpusSize: 100000,
			candidatesCount: 0,
		};
		expect(getProgressLabel("retrieving", meta)).toBe(
			"Buscando entre **100.000 artículos**…",
		);
	});

	test("zero corpusSize falls back to baseline", () => {
		const meta: ProgressMetaRetrieving = { corpusSize: 0 };
		expect(getProgressLabel("retrieving", meta)).toBe(
			"Buscando artículos relevantes",
		);
	});
});

describe("getProgressLabel — ranking", () => {
	test("baseline (no meta)", () => {
		expect(getProgressLabel("ranking")).toBe(
			"Seleccionando las fuentes más fiables",
		);
	});

	test("with finalistsCount", () => {
		const meta: ProgressMetaRanking = { finalistsCount: 15 };
		expect(getProgressLabel("ranking", meta)).toBe(
			"Seleccionando las **15 fuentes** más fiables",
		);
	});

	test("zero finalistsCount falls back to baseline", () => {
		const meta: ProgressMetaRanking = { finalistsCount: 0 };
		expect(getProgressLabel("ranking", meta)).toBe(
			"Seleccionando las fuentes más fiables",
		);
	});
});

describe("getProgressLabel — writing", () => {
	test("baseline (no meta)", () => {
		expect(getProgressLabel("writing")).toBe("Redactando la respuesta");
	});

	test("with citationsExpected", () => {
		const meta: ProgressMetaWriting = { citationsExpected: 4 };
		expect(getProgressLabel("writing", meta)).toBe(
			"Redactando la respuesta · citando **4 artículos**",
		);
	});

	test("zero citationsExpected falls back to baseline", () => {
		const meta: ProgressMetaWriting = { citationsExpected: 0 };
		expect(getProgressLabel("writing", meta)).toBe("Redactando la respuesta");
	});
});
