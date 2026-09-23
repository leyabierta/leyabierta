/**
 * LLM listwise reranker over any OpenAI-compatible chat endpoint.
 *
 * The model receives the question plus a numbered list of candidate articles
 * (title + first 600 chars) and returns the TOP_K most relevant ids as JSON.
 * One chat call per query — slower than a cross-encoder, but it works with any
 * chat model, which matters under OpenRouter Zero Data Retention: the
 * dedicated rerank models (Cohere, Voyage) have no ZDR endpoint.
 *
 * Callers:
 *   - `llmRerank()` — generic (OpenRouter by default).
 *   - `qwenLLMRerank()` — legacy NaN (qwen3.6) wrapper, kept for research
 *     harnesses (RERANK_BACKEND=qwen-llm).
 *
 * Any failure (HTTP error, timeout, unparseable JSON) degrades to passthrough
 * — the fused order is kept — so a rerank problem never fails the answer.
 */

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const NAN_CHAT_URL = "https://api.nan.builders/v1/chat/completions";

/** Characters of article text shown to the model per candidate. */
export const LLM_RERANK_SNIPPET_CHARS = 600;

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

export interface LLMRerankOutput {
	results: LLMRerankResult[];
	backend: string;
	cost: number;
}

export interface LLMRerankOptions {
	/** Chat model id (default: google/gemini-2.5-flash-lite). */
	model?: string;
	/** Chat completions URL (default: OpenRouter). */
	url?: string;
	/** Per-attempt timeout in ms (default: 20s). */
	timeoutMs?: number;
	/** Total attempts, including the first (default: 2). */
	maxAttempts?: number;
	/** Base backoff between attempts in ms, multiplied by the attempt (default: 1000). */
	retryDelayMs?: number;
	/** Extra request-body fields (provider routing, reasoning, …). */
	extraBody?: Record<string, unknown>;
	/** Label used in `backend` and logs (default: "llm-rerank"). */
	label?: string;
	/** Injectable fetch (tests). */
	fetchFn?: typeof fetch;
}

export const LLM_RERANK_SYSTEM_PROMPT = `Eres un experto en derecho español. Dada una pregunta de un ciudadano y una lista numerada de fragmentos de artículos legales, devuelve los TOP_K artículos más relevantes ordenados de mayor a menor relevancia.

Reglas estrictas:
- Devuelve SOLO un JSON con la forma: {"ranked": [{"id": <numero>, "score": <0..1>}, ...]}.
- "id" es el número del fragmento en la lista (1-based).
- "score" es la relevancia (1.0 = muy relevante, 0.0 = irrelevante).
- Devuelve exactamente TOP_K elementos.
- No expliques nada, no añadas comentarios.
- Prioriza artículos de leyes vigentes y de rango superior (constitución > LO > ley > RD).`;

/** Build the user message (exported for tests and cost estimation). */
export function buildLlmRerankUserMessage(
	query: string,
	candidates: LLMCandidate[],
	topK: number,
): string {
	const numbered = candidates
		.map(
			(c, i) =>
				`${i + 1}. ${c.title}\n${c.text.slice(0, LLM_RERANK_SNIPPET_CHARS)}`,
		)
		.join("\n\n");
	return `Pregunta: ${query}\n\nFragmentos:\n${numbered}\n\nDevuelve los ${topK} más relevantes.`;
}

/**
 * Parse the model output into ranked results. Unknown / duplicate ids are
 * dropped; if the model returns fewer than topK valid ids, the remaining
 * slots are filled with the fused order so the synthesis step always gets
 * topK candidates.
 */
export function parseLlmRerankResponse(
	raw: string,
	candidates: LLMCandidate[],
	topK: number,
): LLMRerankResult[] | null {
	let parsed: { ranked?: Array<{ id: number; score?: number }> };
	try {
		parsed = JSON.parse(raw);
	} catch {
		const m = raw.match(/\{[\s\S]*\}/);
		if (!m) return null;
		try {
			parsed = JSON.parse(m[0]);
		} catch {
			return null;
		}
	}
	if (!Array.isArray(parsed.ranked)) return null;

	const seen = new Set<number>();
	const picked: Array<{ idx: number; score: number }> = [];
	for (const r of parsed.ranked) {
		const id = Number(r?.id);
		if (!Number.isInteger(id) || id < 1 || id > candidates.length) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		picked.push({
			idx: id - 1,
			score: typeof r.score === "number" ? r.score : 1 - picked.length * 0.01,
		});
		if (picked.length >= topK) break;
	}
	if (picked.length === 0) return null;
	for (let i = 0; i < candidates.length && picked.length < topK; i++) {
		if (!seen.has(i + 1)) {
			seen.add(i + 1);
			picked.push({ idx: i, score: 0 });
		}
	}
	return picked.map((p, i) => ({
		key: candidates[p.idx]!.key,
		relevanceScore: p.score,
		rank: i + 1,
	}));
}

function passthrough(
	candidates: LLMCandidate[],
	topK: number,
	backend: string,
	cost = 0,
): LLMRerankOutput {
	return {
		results: candidates.slice(0, topK).map((c, i) => ({
			key: c.key,
			relevanceScore: 1 - i * 0.01,
			rank: i + 1,
		})),
		backend,
		cost,
	};
}

interface ChatResponse {
	choices?: Array<{ message?: { content?: string | null } }>;
	usage?: { cost?: number };
}

export async function llmRerank(
	apiKey: string,
	query: string,
	candidates: LLMCandidate[],
	topK = 15,
	opts: LLMRerankOptions = {},
): Promise<LLMRerankOutput> {
	const label = opts.label ?? "llm-rerank";
	if (candidates.length === 0) {
		return { results: [], backend: `${label}-empty`, cost: 0 };
	}
	if (candidates.length <= topK) {
		return passthrough(candidates, topK, `${label}-passthrough`);
	}
	if (!apiKey) return passthrough(candidates, topK, `${label}-no-key`);

	const body = JSON.stringify({
		model: opts.model ?? "google/gemini-2.5-flash-lite",
		messages: [
			{
				role: "system",
				content: LLM_RERANK_SYSTEM_PROMPT.replace(/TOP_K/g, String(topK)),
			},
			{
				role: "user",
				content: buildLlmRerankUserMessage(query, candidates, topK),
			},
		],
		max_tokens: 1500,
		temperature: 0.1,
		response_format: { type: "json_object" },
		...opts.extraBody,
	});

	const doFetch = opts.fetchFn ?? fetch;
	const maxAttempts = opts.maxAttempts ?? 2;
	let cost = 0;
	let lastError = "unknown";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const res = await doFetch(opts.url ?? OPENROUTER_CHAT_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://leyabierta.es",
					"X-Title": "Ley Abierta",
				},
				body,
				signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
			});
			if (!res.ok) {
				lastError = `${res.status}: ${(await res.text()).slice(0, 200)}`;
				// 4xx other than 429 will not get better on retry.
				if (res.status !== 429 && res.status < 500) break;
			} else {
				const data = (await res.json()) as ChatResponse;
				cost += data.usage?.cost ?? 0;
				const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
				const results = parseLlmRerankResponse(raw, candidates, topK);
				if (results) return { results, backend: label, cost };
				lastError = `unparseable response: ${raw.slice(0, 120)}`;
			}
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		const delay = (opts.retryDelayMs ?? 1000) * attempt;
		if (attempt < maxAttempts && delay > 0) {
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	console.warn(`[${label}] failed (${lastError}); passthrough`);
	return passthrough(candidates, topK, `${label}-failed`, cost);
}

/** Legacy NaN (qwen3.6) variant — research harnesses only. */
export function qwenLLMRerank(
	apiKey: string,
	query: string,
	candidates: LLMCandidate[],
	topK = 8,
	opts: { model?: string; timeoutMs?: number } = {},
): Promise<LLMRerankOutput> {
	return llmRerank(apiKey, query, candidates, topK, {
		url: NAN_CHAT_URL,
		model: opts.model ?? "qwen3.6",
		timeoutMs: opts.timeoutMs ?? 90_000,
		maxAttempts: 4,
		extraBody: { chat_template_kwargs: { enable_thinking: false } },
		label: "qwen-llm-rerank",
	});
}
