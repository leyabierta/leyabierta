/**
 * Reranker — rescores candidate articles by relevance to the query.
 *
 * Supports two backends:
 * 1. Cohere Rerank 3.5 (if COHERE_API_KEY is set) — fast, cheap, purpose-built
 * 2. LLM-based reranking via OpenRouter (fallback) — uses existing API key
 *
 * The reranker takes top-N candidates from retrieval (e.g. RRF output)
 * and returns a reranked top-K with relevance scores.
 */

const COHERE_RERANK_URL = "https://api.cohere.com/v2/rerank";
const COHERE_MODEL = "rerank-v3.5";

export interface RerankerCandidate {
	key: string; // "normId:blockId"
	text: string; // article text (will be truncated)
	title: string; // article title
}

export interface RerankerResult {
	key: string;
	relevanceScore: number;
	rank: number;
}

interface RerankerConfig {
	cohereApiKey?: string;
	openrouterApiKey?: string;
	openrouterModel?: string;
}

/**
 * Rerank candidates by relevance to the query.
 * Picks the best available backend automatically.
 *
 * @param query - The user's question
 * @param candidates - Articles to rerank (already retrieved)
 * @param topK - How many to return
 * @param config - API keys
 * @returns Reranked top-K with relevance scores
 */
export async function rerank(
	query: string,
	candidates: RerankerCandidate[],
	topK: number = 8,
	config: RerankerConfig,
): Promise<{ results: RerankerResult[]; backend: string; cost: number }> {
	if (candidates.length === 0) {
		return { results: [], backend: "none", cost: 0 };
	}

	// If fewer candidates than topK, just return them all
	if (candidates.length <= topK) {
		return {
			results: candidates.map((c, i) => ({
				key: c.key,
				relevanceScore: 1 - i * 0.01,
				rank: i + 1,
			})),
			backend: "passthrough",
			cost: 0,
		};
	}

	if (config.cohereApiKey) {
		return rerankWithCohere(query, candidates, topK, config.cohereApiKey);
	}

	if (config.openrouterApiKey) {
		return rerankWithLLM(
			query,
			candidates,
			topK,
			config.openrouterApiKey,
			config.openrouterModel ?? "google/gemini-2.5-flash-lite",
		);
	}

	// No API keys — return candidates as-is (no reranking)
	return {
		results: candidates.slice(0, topK).map((c, i) => ({
			key: c.key,
			relevanceScore: 1 - i * 0.01,
			rank: i + 1,
		})),
		backend: "none",
		cost: 0,
	};
}

// ── Cohere Rerank ──

async function rerankWithCohere(
	query: string,
	candidates: RerankerCandidate[],
	topK: number,
	apiKey: string,
): Promise<{ results: RerankerResult[]; backend: string; cost: number }> {
	const documents = candidates.map((c) => ({
		text: `${c.title}\n\n${c.text.slice(0, 1500)}`,
	}));

	const response = await fetch(COHERE_RERANK_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: COHERE_MODEL,
			query,
			documents,
			top_n: topK,
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`Cohere Rerank error ${response.status}: ${err.slice(0, 200)}`);
	}

	const data = (await response.json()) as {
		results: Array<{ index: number; relevance_score: number }>;
	};

	const results: RerankerResult[] = data.results.map((r, rank) => ({
		key: candidates[r.index]!.key,
		relevanceScore: r.relevance_score,
		rank: rank + 1,
	}));

	// Cohere costs ~$0.001 per 1000 search units (1 search unit = 1 doc × 1 query)
	const cost = (candidates.length / 1000) * 0.001;

	return { results, backend: "cohere-rerank-v3.5", cost };
}

// ── LLM-based reranker (fallback) ──

async function rerankWithLLM(
	query: string,
	candidates: RerankerCandidate[],
	topK: number,
	apiKey: string,
	model: string,
): Promise<{ results: RerankerResult[]; backend: string; cost: number }> {
	// Build a numbered list of candidate snippets
	const snippets = candidates
		.map(
			(c, i) =>
				`[${i}] ${c.title}\n${c.text.slice(0, 300)}`,
		)
		.join("\n\n");

	const response = await fetch(
		"https://openrouter.ai/api/v1/chat/completions",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://leyabierta.es",
				"X-Title": "Ley Abierta RAG Reranker",
			},
			body: JSON.stringify({
				model,
				temperature: 0,
				max_tokens: 300,
				response_format: { type: "json_object" },
				messages: [
					{
						role: "system",
						content: `Eres un reranker de documentos legales. Dada una pregunta y una lista de artículos legislativos numerados, devuelve los ${topK} más relevantes ordenados por relevancia descendente.

Responde SOLO con JSON: {"ranking": [{"index": N, "score": 0.0-1.0}, ...]}
- "index" es el número del artículo en la lista
- "score" es la relevancia (1.0 = perfectamente relevante, 0.0 = irrelevante)
- Devuelve exactamente ${topK} resultados (o menos si hay menos candidatos relevantes)`,
					},
					{
						role: "user",
						content: `PREGUNTA: ${query}\n\nARTÍCULOS:\n${snippets}`,
					},
				],
			}),
		},
	);

	if (!response.ok) {
		const err = await response.text();
		throw new Error(
			`LLM reranker error ${response.status}: ${err.slice(0, 200)}`,
		);
	}

	const data = (await response.json()) as {
		usage?: { cost?: number };
		choices?: Array<{ message?: { content?: string } }>;
	};
	const usage = data.usage ?? {};
	const cost = usage.cost ?? 0;

	let ranking: Array<{ index: number; score: number }>;
	try {
		const content = data.choices?.[0]?.message?.content ?? "{}";
		const parsed = JSON.parse(content) as { ranking?: Array<{ index: number; score: number }> };
		ranking = parsed.ranking ?? [];
	} catch {
		// If LLM fails to produce valid JSON, return candidates as-is
		return {
			results: candidates.slice(0, topK).map((c, i) => ({
				key: c.key,
				relevanceScore: 1 - i * 0.01,
				rank: i + 1,
			})),
			backend: `llm-reranker-${model}-failed`,
			cost,
		};
	}

	const results: RerankerResult[] = ranking
		.filter((r) => r.index >= 0 && r.index < candidates.length)
		.slice(0, topK)
		.map((r, rank) => ({
			key: candidates[r.index]!.key,
			relevanceScore: r.score,
			rank: rank + 1,
		}));

	return { results, backend: `llm-reranker-${model}`, cost };
}
