/**
 * HyDE (Hypothetical Document Embeddings) for legal queries.
 *
 * Citizen queries use colloquial Spanish ("el vecino hace ruido por la noche")
 * but the BOE uses formal legal jargon ("inmisiones acústicas en propiedad
 * horizontal"). The embedding bridge between the two is weak, especially for
 * pre-1980 laws.
 *
 * HyDE: rewrite the query into a hypothetical legal-text passage *before*
 * embedding it. The rewrite shifts the vector toward the language of the BOE,
 * improving recall on ancient laws.
 *
 * We use qwen3.6 via NaN (free, unlimited) — no OpenRouter, no paid models.
 */

const NAN_CHAT_URL = "https://api.nan.builders/v1/chat/completions";

const HYDE_SYSTEM_PROMPT = `Eres un asistente jurídico experto. Reescribe la pregunta de un ciudadano como si fuera un fragmento de texto legal extraído de un artículo del BOE: usa terminología jurídica formal, conceptos del derecho español, y referencias a institutos legales relevantes (sin inventar artículos concretos).

Reglas:
- Devuelve SOLO el texto reescrito (2-4 frases), sin explicación ni preámbulo
- Usa vocabulario del BOE: "arrendamiento", "inmisiones", "derecho de propiedad", "obligación", "responsabilidad civil", etc.
- No inventes números de artículos ni citas concretas
- Mantén el español de España, formal, registro alto
- Si la pregunta apunta a varias áreas (civil, penal, laboral...), incluye términos de TODAS las áreas relevantes`;

interface ChatResponse {
	choices: Array<{ message: { content: string } }>;
}

export async function hydeRewrite(
	apiKey: string,
	query: string,
	opts: { model?: string; timeoutMs?: number } = {},
): Promise<string> {
	const model = opts.model ?? "qwen3.6";
	const body = JSON.stringify({
		model,
		messages: [
			{ role: "system", content: HYDE_SYSTEM_PROMPT },
			{ role: "user", content: query },
		],
		max_tokens: 280,
		temperature: 0.2,
		// Disable thinking on qwen3.6 — we want fast, deterministic rewrite
		chat_template_kwargs: { enable_thinking: false },
	});

	let attempts = 0;
	const MAX_ATTEMPTS = 5;
	while (attempts < MAX_ATTEMPTS) {
		try {
			const res = await fetch(NAN_CHAT_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body,
				signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
			});
			if (res.status === 429 || res.status >= 500) {
				attempts++;
				await new Promise((r) => setTimeout(r, 2000 * attempts));
				continue;
			}
			if (!res.ok) {
				const errText = await res.text();
				throw new Error(`NaN chat ${res.status}: ${errText.slice(0, 200)}`);
			}
			const data = (await res.json()) as ChatResponse;
			const content = data.choices?.[0]?.message?.content?.trim() ?? "";
			if (!content) {
				attempts++;
				continue;
			}
			return content;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`  HyDE attempt ${attempts + 1}/${MAX_ATTEMPTS}: ${msg.slice(0, 200)}`);
			attempts++;
			if (attempts >= MAX_ATTEMPTS) throw err;
			await new Promise((r) => setTimeout(r, 2000 * attempts));
		}
	}
	throw new Error("HyDE rewrite failed after max retries");
}

/**
 * Compose the HyDE-augmented query: original + rewrite. Both languages help —
 * keep colloquial keywords for BM25, add legal jargon for vector retrieval.
 */
export function composeHydeQuery(original: string, rewrite: string): string {
	return `${original}\n\n${rewrite}`;
}
