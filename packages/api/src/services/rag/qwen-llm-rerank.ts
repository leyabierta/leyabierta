/**
 * NaN-only LLM reranker via qwen3.6.
 *
 * Drop-in replacement for `cohere/rerank-4-pro` (which goes via OpenRouter,
 * paid). Used for end-to-end NaN-only stack evaluation. Returns top-K
 * candidates ordered by qwen3.6 relevance scoring.
 *
 * Note: this is materially slower than a cross-encoder rerank (1 LLM call per
 * batch instead of vectorized matmul), but gives a fair NaN-only comparison.
 */

const NAN_CHAT_URL = "https://api.nan.builders/v1/chat/completions";

export interface LLMCandidate {
	key: string; // normId:blockId
	title: string; // article title
	text: string; // article snippet
}

export interface LLMRerankResult {
	key: string;
	relevanceScore: number;
	rank: number;
}

const SYSTEM_PROMPT = `Eres un experto en derecho español. Dada una pregunta de un ciudadano y una lista numerada de fragmentos de artículos legales, devuelve los TOP_K artículos más relevantes ordenados de mayor a menor relevancia.

Reglas estrictas:
- Devuelve SOLO un JSON con la forma: {"ranked": [{"id": <numero>, "score": <0..1>}, ...]}.
- "id" es el número del fragmento en la lista (1-based).
- "score" es la relevancia (1.0 = muy relevante, 0.0 = irrelevante).
- Devuelve exactamente TOP_K elementos.
- No expliques nada, no añadas comentarios.
- Prioriza artículos de leyes vigentes y de rango superior (constitución > LO > ley > RD).`;

interface ChatResponse {
	choices: Array<{ message: { content: string } }>;
}

export async function qwenLLMRerank(
	apiKey: string,
	query: string,
	candidates: LLMCandidate[],
	topK: number = 8,
	opts: { model?: string; timeoutMs?: number } = {},
): Promise<{ results: LLMRerankResult[]; backend: string; cost: number }> {
	if (candidates.length === 0) {
		return { results: [], backend: "qwen-llm-empty", cost: 0 };
	}
	if (candidates.length <= topK) {
		return {
			results: candidates.map((c, i) => ({
				key: c.key,
				relevanceScore: 1 - i * 0.01,
				rank: i + 1,
			})),
			backend: "qwen-llm-passthrough",
			cost: 0,
		};
	}

	const numbered = candidates
		.map((c, i) => `${i + 1}. ${c.title}\n${c.text.slice(0, 600)}`)
		.join("\n\n");

	const userMsg = `Pregunta: ${query}\n\nFragmentos:\n${numbered}\n\nDevuelve los ${topK} más relevantes.`;
	const system = SYSTEM_PROMPT.replace(/TOP_K/g, String(topK));

	const body = JSON.stringify({
		model: opts.model ?? "qwen3.6",
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: userMsg },
		],
		max_tokens: 1500,
		temperature: 0.1,
		chat_template_kwargs: { enable_thinking: false },
		response_format: { type: "json_object" },
	});

	const passthrough = (
		backend: string,
	): { results: LLMRerankResult[]; backend: string; cost: number } => ({
		results: candidates.slice(0, topK).map((c, i) => ({
			key: c.key,
			relevanceScore: 1 - i * 0.01,
			rank: i + 1,
		})),
		backend,
		cost: 0,
	});

	let attempts = 0;
	let lastStatus = 0;
	while (attempts < 4) {
		try {
			const res = await fetch(NAN_CHAT_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body,
				signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
			});
			if (res.status === 429 || res.status >= 500) {
				lastStatus = res.status;
				attempts++;
				if (attempts >= 4) {
					console.warn(
						`qwen-llm-rerank rate-limited/5xx (status=${lastStatus}) after ${attempts} attempts; passthrough`,
					);
					return passthrough("qwen-llm-rate-limited");
				}
				await new Promise((r) => setTimeout(r, 2000 * attempts));
				continue;
			}
			if (!res.ok) {
				throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
			}
			const data = (await res.json()) as ChatResponse;
			const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
			let parsed: { ranked?: Array<{ id: number; score: number }> };
			try {
				parsed = JSON.parse(raw);
			} catch {
				// Try to extract JSON object from raw text
				const m = raw.match(/\{[\s\S]*\}/);
				if (!m) throw new Error("No JSON in response");
				parsed = JSON.parse(m[0]);
			}
			const ranked = (parsed.ranked ?? []).slice(0, topK);
			return {
				results: ranked
					.filter((r) => r.id >= 1 && r.id <= candidates.length)
					.map((r, i) => ({
						key: candidates[r.id - 1]!.key,
						relevanceScore: r.score ?? 1 - i * 0.01,
						rank: i + 1,
					})),
				backend: "qwen-llm-rerank",
				cost: 0,
			};
		} catch (err) {
			attempts++;
			if (attempts >= 4) {
				console.warn(
					`qwen-llm-rerank failed after ${attempts} attempts: ${err instanceof Error ? err.message : err}`,
				);
				return passthrough("qwen-llm-failed");
			}
			await new Promise((r) => setTimeout(r, 2000 * attempts));
		}
	}
	return passthrough("qwen-llm-failed");
}
