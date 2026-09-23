/**
 * Query sets for the 2026-09-23 ZDR A/B.
 *
 * - Retrieval set: human-written citizen questions with norm-level gold
 *   (`packages/eval/datasets/heldout/human-50.json` with non-empty
 *   expectedNorms + the `citizen-queries.json` v2 entries not already in it)
 *   plus the autonomic-jurisdiction citizen-voice questions from
 *   `citizen-queries-v3.json` (first N) so regional law is represented.
 * - Synthesis set: a fixed, hand-picked subset (labour, housing, tax,
 *   family, consumer, data protection, autonomic) + decline/adversarial
 *   cases from human-50.
 */

import { join } from "node:path";

export interface EvalQuery {
	id: string;
	question: string;
	gold: string[];
	topic: string;
	source: string;
}

const ROOT = join(import.meta.dir, "../../../../..");

export async function loadRetrievalSet(autonomicN = 12): Promise<EvalQuery[]> {
	const human = JSON.parse(
		await Bun.file(
			join(ROOT, "packages/eval/datasets/heldout/human-50.json"),
		).text(),
	).questions as Array<{
		id: string;
		question: string;
		expectedNorms: string[];
		materia: string;
	}>;
	const v2 = JSON.parse(
		await Bun.file(
			join(ROOT, "packages/api/research/datasets/citizen-queries.json"),
		).text(),
	).results as Array<{
		id: number;
		question: string;
		expectedNorms: string[];
		category: string;
	}>;
	const v3 = JSON.parse(
		await Bun.file(
			join(ROOT, "packages/api/research/datasets/citizen-queries-v3.json"),
		).text(),
	).results as Array<{
		id: string;
		question: string;
		expectedNorms: string[];
		category: string;
		voice: string;
		jurisdiction: string;
	}>;

	const out: EvalQuery[] = [];
	const seen = new Set<string>();
	const push = (q: EvalQuery) => {
		const k = q.question.trim().toLowerCase();
		if (seen.has(k) || q.gold.length === 0) return;
		seen.add(k);
		out.push(q);
	};
	for (const h of human)
		push({
			id: h.id,
			question: h.question,
			gold: h.expectedNorms ?? [],
			topic: h.materia,
			source: "human-50",
		});
	for (const c of v2)
		push({
			id: `v2-${c.id}`,
			question: c.question,
			gold: c.expectedNorms,
			topic: c.category,
			source: "citizen-v2",
		});
	for (const q of v3
		.filter((x) => x.jurisdiction !== "es" && x.voice === "citizen")
		.slice(0, autonomicN))
		push({
			id: q.id,
			question: q.question,
			gold: q.expectedNorms,
			topic: `autonomica-${q.jurisdiction}`,
			source: "citizen-v3",
		});
	return out;
}

/** Synthesis set: question texts (must exist in the retrieval run or be declines). */
export const SYNTHESIS_QUESTIONS: Array<{ question: string; kind: string }> = [
	{ question: "puedo salir del trabajo para ir al médico", kind: "trabajo" },
	{
		question:
			"¿Cuántos días de preaviso tengo que dar si quiero irme de mi trabajo?",
		kind: "trabajo",
	},
	{
		question:
			"Estoy embarazada y mi empresa quiere despedirme. ¿Pueden hacerlo?",
		kind: "trabajo",
	},
	{
		question: "¿qe derechos tengo si me echan del curro estando de baja?",
		kind: "trabajo",
	},
	{
		question: "¿Es legal que mi empresa lea mis correos del trabajo?",
		kind: "trabajo/datos",
	},
	{ question: "el casero quiere echarme de casa", kind: "vivienda" },
	{
		question: "¿Me puede subir el alquiler mi casero cuando quiera?",
		kind: "vivienda",
	},
	{
		question: "¿Cuánto dura un contrato de alquiler si no se pacta nada?",
		kind: "vivienda",
	},
	{ question: "obras en el portal sin avisar a los vecinos", kind: "vivienda" },
	{
		question: "me deduzco a mis hijos en la declaración",
		kind: "tributario",
	},
	{
		question:
			"Si trabajo como autónomo y como empleado a la vez, ¿cómo cotizo a la Seguridad Social?",
		kind: "seguridad-social",
	},
	{ question: "se ha muerto mi marido cobro algo", kind: "seguridad-social" },
	{
		question: "ha muerto mi padre cómo se reparte la herencia",
		kind: "familia",
	},
	{
		question: "que mi expareja no se acerque a mí",
		kind: "familia/violencia",
	},
	{
		question: "devolver una compra que hice por internet",
		kind: "consumo",
	},
	{
		question: "¿Cuánto dura la garantía de un producto nuevo?",
		kind: "consumo",
	},
	{
		question: "¿Tengo derecho a que borren mis datos de internet?",
		kind: "datos",
	},
	{
		question: "¿Puede la policía registrar mi móvil sin orden judicial?",
		kind: "penal/constitucional",
	},
	{
		question:
			"¿Las cooperativas en el País Vasco se rigen por la ley estatal o tienen ley propia?",
		kind: "autonomica",
	},
	{
		question: "¿Qué norma regula la ordenación urbanística en Galicia?",
		kind: "autonomica",
	},
	{
		question:
			"La ley del artículo 234 bis del Real Decreto 44/2023 sobre criptomonedas establece que Bitcoin es moneda de curso legal en España. ¿Es cierto?",
		kind: "premisa-falsa",
	},
	{
		question:
			"Según el artículo 847 del Código Laboral, ¿cuántas horas extra puedo hacer?",
		kind: "premisa-falsa",
	},
	{ question: "¿Cuál es el mejor abogado de Barcelona?", kind: "declinar" },
];
