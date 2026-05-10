import { describe, expect, test } from "bun:test";
import { makeDedupAgent } from "./dedup.ts";

describe("dedup agent — bigram-Jaccard surface similarity", () => {
	test("flags near-identical surface text as duplicate", async () => {
		const dedup = makeDedupAgent();
		const q1 = "¿Cuánto tiempo de baja por paternidad me corresponde?";
		const q2 = "¿Cuánto tiempo de baja por paternidad me corresponde hoy?";
		await dedup.add(q1);
		expect(await dedup.isDuplicate(q2)).toBe(true);
	});

	test("does not flag surface-different questions when no primary given", async () => {
		const dedup = makeDedupAgent();
		await dedup.add("¿Qué pasa si mi casero no me devuelve la fianza?");
		expect(
			await dedup.isDuplicate(
				"Tengo un cliente que no me paga desde hace meses, ¿qué hago?",
			),
		).toBe(false);
	});
});

describe("dedup agent — (norm, article) fingerprint cap", () => {
	test("two surface-different questions on the same (norm, article) → second flagged", async () => {
		const dedup = makeDedupAgent();
		const primary = { norm: "BOE-A-2010-10213", article: "a10" };
		const q1 = "¿Qué obligaciones hay sobre programas infantiles en TV?";
		const q2 =
			"¿Las cadenas tienen que ofrecer contenidos accesibles para diversidad funcional?";
		expect(await dedup.isDuplicate(q1, primary)).toBe(false);
		await dedup.add(q1, primary);
		expect(await dedup.isDuplicate(q2, primary)).toBe(true);
	});

	test("same norm but different articles → both pass", async () => {
		const dedup = makeDedupAgent();
		const a = { norm: "BOE-A-2010-10213", article: "a10" };
		const b = { norm: "BOE-A-2010-10213", article: "a11" };
		const q1 = "¿Qué obligaciones hay sobre programas infantiles en TV?";
		const q2 =
			"¿Cómo se regula la publicidad encubierta en servicios audiovisuales?";
		expect(await dedup.isDuplicate(q1, a)).toBe(false);
		await dedup.add(q1, a);
		expect(await dedup.isDuplicate(q2, b)).toBe(false);
		await dedup.add(q2, b);
	});

	test("maxQuestionsPerArticle=2 allows two, blocks the third", async () => {
		const dedup = makeDedupAgent({ maxQuestionsPerArticle: 2 });
		const primary = { norm: "BOE-A-2010-10213", article: "a10" };
		const q1 = "Pregunta uno totalmente distinta sobre el artículo.";
		const q2 = "Otra cuestión bastante diferente acerca del mismo tema.";
		const q3 = "Tercera consulta con palabras nuevas y específicas.";
		expect(await dedup.isDuplicate(q1, primary)).toBe(false);
		await dedup.add(q1, primary);
		expect(await dedup.isDuplicate(q2, primary)).toBe(false);
		await dedup.add(q2, primary);
		expect(await dedup.isDuplicate(q3, primary)).toBe(true);
	});
});
