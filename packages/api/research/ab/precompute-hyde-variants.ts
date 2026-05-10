/**
 * Pre-compute alternative HyDE rewrites for the eval set.
 *
 * Variants saved:
 *   hyde-cache-gemma4.json   — gemma4 (NaN), same prompt as qwen3.6 baseline
 *   hyde-cache-short.json    — qwen3.6, prompt asks for ONE sentence
 *   hyde-cache-keywords.json — qwen3.6, prompt asks for legal keywords list (BM25-friendly)
 */

import { join } from "node:path";

const apiKey = process.env.HERMES_API_KEY;
if (!apiKey) {
	console.error("HERMES_API_KEY required");
	process.exit(1);
}
const NAN_CHAT_URL = "https://api.nan.builders/v1/chat/completions";

const repoRoot = join(import.meta.dir, "../../../../");
const evalPath = join(
	repoRoot,
	"packages/api/research/datasets/citizen-queries.json",
);
const outDir = join(repoRoot, "data/ab-results");

const evalData = (await Bun.file(evalPath).json()) as {
	results: Array<{ id: number; question: string; expectedNorms?: string[] }>;
};
const questions = evalData.results.filter(
	(r) => (r.expectedNorms?.length ?? 0) > 0,
);

interface ChatResponse {
	choices: Array<{ message: { content: string } }>;
}

async function chat(
	model: string,
	system: string,
	user: string,
	maxTokens = 280,
): Promise<string> {
	const body = JSON.stringify({
		model,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		max_tokens: maxTokens,
		temperature: 0.2,
		chat_template_kwargs: { enable_thinking: false },
	});
	let attempts = 0;
	while (attempts < 5) {
		try {
			const res = await fetch(NAN_CHAT_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body,
				signal: AbortSignal.timeout(60_000),
			});
			if (res.status === 429 || res.status >= 500) {
				attempts++;
				await new Promise((r) => setTimeout(r, 2000 * attempts));
				continue;
			}
			if (!res.ok)
				throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
			const data = (await res.json()) as ChatResponse;
			return data.choices?.[0]?.message?.content?.trim() ?? "";
		} catch (err) {
			attempts++;
			if (attempts >= 5) throw err;
			await new Promise((r) => setTimeout(r, 2000 * attempts));
		}
	}
	throw new Error("max retries");
}

const SYSTEM_BASE = `Eres un asistente jurídico experto. Reescribe la pregunta de un ciudadano como si fuera un fragmento de texto legal extraído de un artículo del BOE: usa terminología jurídica formal, conceptos del derecho español, y referencias a institutos legales relevantes (sin inventar artículos concretos).

Reglas:
- Devuelve SOLO el texto reescrito (2-4 frases), sin explicación ni preámbulo
- Usa vocabulario del BOE: "arrendamiento", "inmisiones", "derecho de propiedad", "obligación", "responsabilidad civil", etc.
- No inventes números de artículos ni citas concretas
- Mantén el español de España, formal, registro alto
- Si la pregunta apunta a varias áreas (civil, penal, laboral...), incluye términos de TODAS las áreas relevantes`;

const SYSTEM_SHORT = `Eres un asistente jurídico. Reescribe la pregunta del ciudadano como UNA SOLA FRASE en español jurídico formal, usando terminología del BOE. NO inventes artículos. SOLO la frase, sin explicaciones.`;

const SYSTEM_KEYWORDS = `Eres un asistente jurídico. Para la pregunta del ciudadano, devuelve EXCLUSIVAMENTE una lista separada por comas de 8-12 términos jurídicos formales (instituciones legales, conceptos, áreas de derecho) que aparecerían en los artículos del BOE relevantes. Sin frases, sin explicación, solo términos separados por comas.

Ejemplo:
Pregunta: "el casero me echa de mi casa"
Términos: arrendamiento, arrendatario, arrendador, desahucio, extinción contrato arrendamiento, vivienda habitual, prórroga forzosa, cláusula resolutoria, falta de pago, necesidad de uso propio, requerimiento de pago`;

interface CacheTask {
	model: string;
	system: string;
	maxTokens: number;
	outFile: string;
	label: string;
}

const tasks: CacheTask[] = [
	{
		model: "gemma4",
		system: SYSTEM_BASE,
		maxTokens: 280,
		outFile: join(outDir, "hyde-cache-gemma4.json"),
		label: "gemma4 (same prompt)",
	},
	{
		model: "qwen3.6",
		system: SYSTEM_SHORT,
		maxTokens: 120,
		outFile: join(outDir, "hyde-cache-short.json"),
		label: "qwen3.6 short (1 sentence)",
	},
	{
		model: "qwen3.6",
		system: SYSTEM_KEYWORDS,
		maxTokens: 200,
		outFile: join(outDir, "hyde-cache-keywords.json"),
		label: "qwen3.6 keywords list",
	},
];

for (const task of tasks) {
	console.log(`\n=== ${task.label} → ${task.outFile} ===`);
	let cache: Record<string, string> = {};
	const f = Bun.file(task.outFile);
	if (await f.exists()) {
		cache = (await f.json()) as Record<string, string>;
	}
	const startedAt = Date.now();
	let done = 0;
	for (const q of questions) {
		if (cache[q.question]) {
			done++;
			continue;
		}
		try {
			const rewrite = await chat(task.model, task.system, q.question, task.maxTokens);
			if (rewrite) cache[q.question] = rewrite;
			done++;
			if (done % 5 === 0) {
				const elapsed = (Date.now() - startedAt) / 1000;
				const rate = done / Math.max(elapsed, 0.1);
				process.stdout.write(`\r  ${done}/${questions.length} — ${rate.toFixed(2)}/s   `);
				await Bun.write(task.outFile, JSON.stringify(cache, null, 2));
			}
		} catch (err) {
			console.warn(
				`\n  q${q.id} failed: ${err instanceof Error ? err.message : err}`,
			);
		}
	}
	await Bun.write(task.outFile, JSON.stringify(cache, null, 2));
	console.log(`\n  ✅ ${Object.keys(cache).length} cached`);
}
