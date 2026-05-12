/**
 * Reranker — rescores candidate articles by relevance to the query.
 *
 * Backend: qwen3.6 LLM rerank via NaN. Phase 5 A/B showed +18 pp R@1
 * over cohere/rerank-4-pro on this Spanish-legal corpus, with $0 cost.
 */

import { getNanApiKey } from "../nan-api-key.ts";
import { qwenLLMRerank } from "./qwen-llm-rerank.ts";

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

	// Default: qwen3.6 LLM rerank via NaN. Resolve via getNanApiKey() when the
	// caller didn't pass one — same pattern as embeddings/analyzer.
	const nanKey = config.nanApiKey ?? getNanApiKey();
	if (nanKey) {
		return rerankWithNanLLM(query, candidates, topK, nanKey);
	}

	// No key → passthrough (preserves order from RRF).
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

// ── NaN qwen3.6 LLM rerank (Phase 5 default) ──

async function rerankWithNanLLM(
	query: string,
	candidates: RerankerCandidate[],
	topK: number,
	nanApiKey: string,
): Promise<{ results: RerankerResult[]; backend: string; cost: number }> {
	return qwenLLMRerank(nanApiKey, query, candidates, topK);
}
