/**
 * Benchmark synthesis models for the RAG pipeline.
 *
 * Tests each model on key questions to compare:
 * - Factual accuracy (does it use the correct number from context?)
 * - Latency
 * - Cost
 * - Quality of citizen-friendly explanation
 *
 * Uses the RAG pipeline directly (not the API) to swap models easily.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/research/benchmark-synthesis-models.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import { callOpenRouter } from "../src/services/openrouter.ts";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
	console.error("Set OPENROUTER_API_KEY");
	process.exit(1);
}

// ── Models to benchmark ──
const MODELS = [
	"google/gemini-2.5-flash-lite",
	"google/gemini-3.1-flash-lite-preview",
	"google/gemini-2.0-flash-001",
	"qwen/qwen3-vl-32b-instruct",
	"mistralai/ministral-8b-2512",
	"google/gemma-4-31b-it",
	"qwen/qwen3-next-80b-a3b-instruct",
	"mistralai/mistral-small-2603",
	"openai/gpt-4o-mini",
];

// ── Fixed evidence text (pre-extracted from the pipeline for Q2) ──
// This ensures all models see EXACTLY the same input.

const repoRoot = join(import.meta.dir, "../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// Get the actual article text for ET art.48
const etArt48 = db
	.query<{ current_text: string }, [string, string]>(
		"SELECT current_text FROM blocks WHERE norm_id = ? AND block_id = ?",
	)
	.get("BOE-A-2015-11430", "a48");

// Get ET art.38 (vacaciones)
const etArt38 = db
	.query<{ current_text: string }, [string, string]>(
		"SELECT current_text FROM blocks WHERE norm_id = ? AND block_id = ?",
	)
	.get("BOE-A-2015-11430", "a38");

// Extract apartado 4 from art.48 (the paternity section)
const fullText48 = etArt48?.current_text ?? "";
const apt4Start = fullText48.indexOf("4. El nacimiento");
const apt5Start = fullText48.indexOf("5. En los supuestos de adopción");
const apt4Text =
	apt4Start >= 0 && apt5Start > apt4Start
		? fullText48.slice(apt4Start, apt5Start).trim()
		: fullText48.slice(apt4Start, apt4Start + 2000).trim();

// Convert "diecinueve" to "19" as our pipeline does
const apt4Digits = apt4Text
	.replace(/\bdiecinueve\s+semanas/gi, "19 semanas")
	.replace(/\btreinta y dos\s+semanas/gi, "32 semanas")
	.replace(/\bseis\s+semanas/gi, "6 semanas")
	.replace(/\bonce\s+semanas/gi, "11 semanas")
	.replace(/\bveintidós\s+semanas/gi, "22 semanas")
	.replace(/\bdos\s+semanas/gi, "2 semanas")
	.replace(/\bocho\s+años/gi, "8 años");

const EVIDENCE_Q2 = `[BOE-A-2015-11430, Artículo 48.4] (Ley estatal: Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores)
[TEXTO CONSOLIDADO | Última actualización: 2025-07-30]
${apt4Digits}`;

const EVIDENCE_Q1 = `[BOE-A-2015-11430, Artículo 38] (Ley estatal: Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores)
[TEXTO CONSOLIDADO | Última actualización: 2025-07-30]
${etArt38?.current_text ?? ""}`;

const SYSTEM_PROMPT = `Eres un asistente legal informativo. Ayudas a ciudadanos a entender la legislación española usando los artículos proporcionados.

REGLAS:
1. Basa tu respuesta SOLO en los artículos proporcionados.
2. NUNCA inventes artículos ni cites normas que no estén en la lista.
3. CIFRAS LITERALES: Cuando el texto de un artículo dice un número, plazo, porcentaje o cantidad, CÓPIALO EXACTAMENTE. No uses cifras de tu memoria. Los artículos proporcionados son textos consolidados actualizados a hoy — pueden contener reformas MÁS RECIENTES que tus datos de entrenamiento.
4. CITAS INLINE: Inserta [norm_id, Artículo N] justo después de cada afirmación.
5. Habla como si se lo explicaras a tu madre. Nada de jerga legal.
6. Empieza con la respuesta directa.

Responde con JSON: {"answer": "texto", "citations": [{"norm_id": "...", "article_title": "..."}], "declined": false}`;

const QUESTIONS = [
	{
		id: "Q2",
		question: "¿Cuánto dura la baja por paternidad?",
		evidence: EVIDENCE_Q2,
		correctAnswer: "19 semanas",
		checkPattern: /19\s*semanas/i,
		wrongPattern: /16\s*semanas/i,
	},
	{
		id: "Q1",
		question: "¿Cuántos días de vacaciones me corresponden al año?",
		evidence: EVIDENCE_Q1,
		correctAnswer: "30 días naturales",
		checkPattern: /30\s*días/i,
		wrongPattern: /22\s*días/i,
	},
];

// ── Run benchmark ──

console.log(`\n╔═══════════════════════════════════════════════════╗`);
console.log(`║  Synthesis Model Benchmark                         ║`);
console.log(`╚═══════════════════════════════════════════════════╝`);
console.log(`  Models: ${MODELS.length}`);
console.log(`  Questions: ${QUESTIONS.length} (× 3 runs each)`);
console.log(`  Total calls: ${MODELS.length * QUESTIONS.length * 3}\n`);

type Result = {
	model: string;
	question: string;
	answer: string;
	correct: boolean;
	wrong: boolean;
	latencyMs: number;
	tokens: { prompt: number; completion: number };
};

const results: Result[] = [];
const RUNS = 3;

for (const model of MODELS) {
	console.log(`\n── ${model} ──`);

	for (const q of QUESTIONS) {
		const runs: Result[] = [];

		for (let i = 0; i < RUNS; i++) {
			const start = Date.now();
			try {
				const res = await callOpenRouter<{
					answer: string;
					citations: Array<{ norm_id: string; article_title: string }>;
					declined: boolean;
				}>(apiKey, {
					model,
					messages: [
						{ role: "system", content: SYSTEM_PROMPT },
						{
							role: "user",
							content: `ARTÍCULOS DISPONIBLES:\n\n${q.evidence}\n\nIMPORTANTE: Los artículos anteriores son textos consolidados oficiales del BOE actualizados a fecha de hoy. Si una cifra del artículo NO coincide con lo que recuerdas de tu entrenamiento, USA LA CIFRA DEL ARTÍCULO — la ley ha sido reformada recientemente.\n\nPREGUNTA: ${q.question}`,
						},
					],
					temperature: 0,
					maxTokens: 800,
					jsonSchema: {
						name: "legal_answer",
						schema: {
							type: "object",
							properties: {
								answer: { type: "string" },
								citations: {
									type: "array",
									items: {
										type: "object",
										properties: {
											norm_id: { type: "string" },
											article_title: { type: "string" },
										},
										required: ["norm_id", "article_title"],
									},
								},
								declined: { type: "boolean" },
							},
							required: ["answer", "citations", "declined"],
						},
					},
				});

				const latencyMs = Date.now() - start;
				const answer = res.data.answer;
				const correct = q.checkPattern.test(answer);
				const wrong = q.wrongPattern.test(answer);

				const r: Result = {
					model,
					question: q.id,
					answer: answer.slice(0, 150),
					correct,
					wrong,
					latencyMs,
					tokens: {
						prompt: res.usage?.prompt_tokens ?? 0,
						completion: res.usage?.completion_tokens ?? 0,
					},
				};
				runs.push(r);
				results.push(r);
			} catch (err) {
				const latencyMs = Date.now() - start;
				console.log(
					`    ${q.id} run ${i + 1}: ERROR — ${err instanceof Error ? err.message.slice(0, 100) : "unknown"}`,
				);
				results.push({
					model,
					question: q.id,
					answer: `ERROR: ${err instanceof Error ? err.message.slice(0, 80) : "unknown"}`,
					correct: false,
					wrong: false,
					latencyMs,
					tokens: { prompt: 0, completion: 0 },
				});
			}

			await new Promise((r) => setTimeout(r, 500));
		}

		const correctCount = runs.filter((r) => r.correct).length;
		const wrongCount = runs.filter((r) => r.wrong).length;
		const avgLatency = runs.length
			? Math.round(runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length)
			: 0;
		const symbol = correctCount === RUNS ? "✅" : wrongCount > 0 ? "❌" : "⚠️";
		console.log(
			`  ${symbol} ${q.id}: ${correctCount}/${RUNS} correct (${q.correctAnswer}), ${wrongCount}/${RUNS} wrong, avg ${avgLatency}ms`,
		);
		if (runs.length > 0) {
			console.log(`     "${runs[0]!.answer.slice(0, 100)}..."`);
		}
	}
}

// ── Summary table ──
console.log(`\n${"=".repeat(90)}`);
console.log("SUMMARY");
console.log("=".repeat(90));
console.log(
	`${"Model".padEnd(45)} Q2(19sem) Q1(30d) Avg ms  Cost/q`,
);
console.log("-".repeat(90));

// Get pricing
const pricingRes = await fetch("https://openrouter.ai/api/v1/models");
const pricingData = (await pricingRes.json()) as {
	data: Array<{
		id: string;
		pricing: { prompt: string; completion: string };
	}>;
};
const pricing = new Map(
	pricingData.data.map((m) => [
		m.id,
		{
			prompt: Number.parseFloat(m.pricing?.prompt ?? "0"),
			completion: Number.parseFloat(m.pricing?.completion ?? "0"),
		},
	]),
);

for (const model of MODELS) {
	const modelResults = results.filter((r) => r.model === model);
	const q2Results = modelResults.filter((r) => r.question === "Q2");
	const q1Results = modelResults.filter((r) => r.question === "Q1");

	const q2Correct = q2Results.filter((r) => r.correct).length;
	const q1Correct = q1Results.filter((r) => r.correct).length;
	const avgLatency = modelResults.length
		? Math.round(
				modelResults.reduce((s, r) => s + r.latencyMs, 0) /
					modelResults.length,
			)
		: 0;

	const p = pricing.get(model);
	const avgPromptTokens =
		modelResults.reduce((s, r) => s + r.tokens.prompt, 0) /
		Math.max(modelResults.length, 1);
	const avgCompTokens =
		modelResults.reduce((s, r) => s + r.tokens.completion, 0) /
		Math.max(modelResults.length, 1);
	const costPerQuery = p
		? avgPromptTokens * p.prompt + avgCompTokens * p.completion
		: 0;

	const q2Symbol = q2Correct === RUNS ? "✅" : q2Correct > 0 ? "⚠️" : "❌";
	const q1Symbol = q1Correct === RUNS ? "✅" : q1Correct > 0 ? "⚠️" : "❌";

	console.log(
		`${model.padEnd(45)} ${q2Symbol} ${q2Correct}/${RUNS}    ${q1Symbol} ${q1Correct}/${RUNS}   ${String(avgLatency).padStart(5)}ms  $${costPerQuery.toFixed(5)}`,
	);
}

db.close();

// Save raw results
const outputPath = join(repoRoot, "data", "benchmark-synthesis-models.json");
await Bun.write(
	outputPath,
	JSON.stringify(
		{ timestamp: new Date().toISOString(), results },
		null,
		2,
	),
);
console.log(`\nRaw results saved to ${outputPath}`);
