/**
 * Reranker — rescores candidate articles by relevance to the query.
 *
 * Default backend: Cohere Rerank via OpenRouter (cohere/rerank-4-fast,
 * RERANK_BACKEND=cohere-or). Legacy opt-in: qwen3.6 LLM rerank via NaN
 * (RERANK_BACKEND=qwen-llm, only honoured when NAN_API_KEY is set).
 *
 * Backend routing is delegated to `backends.ts` via `getRerankCaller()`.
 * Opik span name "rerank" is emitted regardless of backend by the caller
 * in retrieval.ts — this file does NOT emit spans directly.
 */

import { getNanApiKey } from "../nan-api-key.ts";
import { getRerankCaller, RERANK_BACKEND } from "./backends.ts";

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
	nanApiKey?: string;
}

/**
 * Rerank candidates by relevance to the query.
 * Routes to the backend selected by the RERANK_BACKEND env var
 * (default: "cohere-or" — Cohere via OpenRouter; legacy opt-in: "qwen-llm").
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

	// For cohere-or backend: OPENROUTER_API_KEY is read inside getRerankCaller().
	// For qwen-llm backend: nanKey is passed to the qwenLLMRerank call.
	const nanKey = config.nanApiKey ?? getNanApiKey();

	// getRerankCaller() is safe to call per-request — it resolves env vars once
	// at first call but the cost is negligible (object creation, no I/O).
	const caller = getRerankCaller(nanKey ?? undefined);

	// qwen-llm opt-in without a NaN key: passthrough instead of a doomed call.
	// (resolveRerankBackend already demotes qwen-llm when NAN_API_KEY is unset,
	// so this only triggers if the key disappears between resolution and use.)
	if (RERANK_BACKEND === "qwen-llm" && !nanKey) {
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

	return caller(query, candidates, topK);
}
