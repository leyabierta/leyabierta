/**
 * Stage 4 — blind cross-family judge with the local Claude CLI (`claude -p`,
 * subscription; no OpenRouter spend).
 *
 * One judge call per question: the judge sees the question, the exact
 * evidence the models received, and the N answers under shuffled labels
 * (A, B, C, …). It scores each answer 0–2 on five criteria. The label →
 * model mapping is stored locally and never shown to the judge.
 *
 * Usage:
 *   bun .../judge.ts --context llm_google_gemini-2.5-flash-lite [--judge sonnet]
 */

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, REPO_ROOT } from "./shared.ts";

const { buildEvidence } = await import(
	"../../../src/services/rag/synthesis.ts"
);
type Article =
	import("../../../src/services/rag/retrieval.ts").RetrievedArticle;

const args = process.argv.slice(2);
const argVal = (k: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1] : undefined;
};
const CONTEXT = argVal("--context") ?? "none";
const JUDGE = argVal("--judge") ?? "sonnet";
const DATA_DIR = process.env.DATA_DIR ?? join(REPO_ROOT, "data");
const db = new Database(join(DATA_DIR, "leyabierta.db"), { readonly: true });

export const JUDGE_SYSTEM = `Eres un evaluador experto en derecho español y en comunicación con la ciudadanía. Evalúas respuestas de un asistente que explica leyes españolas a ciudadanos sin formación jurídica. El asistente SOLO puede usar los artículos proporcionados como fuente.

Para cada respuesta, puntúa de 0 a 2 cada criterio:

1. fidelidad (fidelidad legal): 2 = todo lo que afirma está respaldado por los artículos proporcionados y las citas [ID, Artículo N] apoyan de verdad la afirmación a la que acompañan; 1 = algún detalle no respaldado o una cita que no encaja, sin error grave; 0 = inventa datos, cifras, plazos o normas, o contradice los artículos.
2. completitud: 2 = responde a la pregunta de fondo con los matices relevantes que SÍ están en los artículos; 1 = responde pero omite algo importante que estaba disponible; 0 = no responde a lo que se pregunta.
3. claridad (lenguaje llano): 2 = empieza por la respuesta directa y se entiende sin saber derecho; 1 = correcto pero con jerga sin explicar o rodeos; 0 = difícil de entender para un ciudadano.
4. ortografia: 2 = español correcto, con tildes, ñ y signos de apertura (¿ ¡); 1 = algún error menor; 0 = errores frecuentes o falta sistemática de tildes.
5. declinar: 2 = comportamiento adecuado (responde si los artículos lo permiten; si la premisa es falsa la corrige; declina solo si los artículos no responden o la pregunta no es jurídica); 1 = discutible; 0 = declina cuando podía responder, o responde inventando cuando debía declinar.

Sé estricto con la fidelidad: comprueba las cifras y plazos contra el texto de los artículos.

Devuelve SOLO un JSON con esta forma exacta, sin texto adicional:
{"scores": {"A": {"fidelidad": n, "completitud": n, "claridad": n, "ortografia": n, "declinar": n, "nota": "máx. 25 palabras"}, "B": {...}, ...}}`;

const rows = readFileSync(join(OUT_DIR, `stage3-${CONTEXT}.jsonl`), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l)) as Array<Record<string, unknown>>;
const stage1 = readFileSync(
	join(OUT_DIR, "stage1-google_gemini-2.5-flash-lite.jsonl"),
	"utf8",
)
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l)) as Array<{
	id: string;
	useTemporal?: boolean;
	pool?: Article[];
}>;

const outPath = join(OUT_DIR, `judge-${CONTEXT}-${JUDGE}.jsonl`);
const done = new Set(
	existsSync(outPath)
		? readFileSync(outPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l).id as string)
		: [],
);

const byQ = new Map<string, Array<Record<string, unknown>>>();
for (const r of rows) {
	if (r.early || r.error) continue;
	const list = byQ.get(r.id as string) ?? [];
	list.push(r);
	byQ.set(r.id as string, list);
}

// Deterministic shuffle per question (seeded by id) — reproducible and blind.
function seededShuffle<T>(xs: T[], seed: string): T[] {
	let h = 2166136261;
	for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
	const a = [...xs];
	for (let i = a.length - 1; i > 0; i--) {
		h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
		const j = h % (i + 1);
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a;
}

for (const [id, answers] of byQ) {
	if (done.has(id)) continue;
	const s1 = stage1.find((r) => r.id === id)!;
	const keys = answers[0]!.contextKeys as string[];
	const byKey = new Map(s1.pool!.map((a) => [`${a.normId}:${a.blockId}`, a]));
	const articles = keys.map((k) => byKey.get(k)).filter(Boolean) as Article[];
	const { evidenceText } = buildEvidence({
		db,
		articles,
		useTemporal: !!s1.useTemporal,
		streaming: false,
	});
	const shuffled = seededShuffle(answers, id);
	const labels = "ABCDEFGH".split("");
	const mapping: Record<string, string> = {};
	const blocks = shuffled.map((a, i) => {
		mapping[labels[i]!] = a.model as string;
		return `### Respuesta ${labels[i]}\n(declined=${a.declined})\n${a.answer}`;
	});
	const user = `PREGUNTA DEL CIUDADANO: ${answers[0]!.question}\n\nARTÍCULOS PROPORCIONADOS AL ASISTENTE:\n\n${evidenceText}\n\n---\n\nRESPUESTAS A EVALUAR:\n\n${blocks.join("\n\n")}`;
	const t0 = Date.now();
	let parsed: {
		scores: Record<string, Record<string, number | string>>;
	} | null = null;
	let raw = "";
	for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
		try {
			const out = execFileSync(
				"claude",
				[
					"-p",
					"--output-format",
					"json",
					"--model",
					JUDGE,
					"--append-system-prompt",
					JUDGE_SYSTEM,
				],
				{ input: user, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
			);
			raw = (JSON.parse(out) as { result?: string }).result ?? "";
			const m = raw.match(/\{[\s\S]*\}/);
			parsed = m ? JSON.parse(m[0]) : null;
		} catch (err) {
			raw = err instanceof Error ? err.message : String(err);
		}
	}
	if (!parsed) {
		console.warn(`[judge] ${id} failed: ${raw.slice(0, 200)}`);
		continue;
	}
	const perModel: Record<string, unknown> = {};
	for (const [label, model] of Object.entries(mapping))
		perModel[model] = parsed.scores[label];
	appendFileSync(
		outPath,
		`${JSON.stringify({ id, question: answers[0]!.question, mapping, scores: perModel, ms: Date.now() - t0 })}\n`,
	);
	console.log(`[judge] ${id} done in ${Date.now() - t0}ms`);
}
db.close();
