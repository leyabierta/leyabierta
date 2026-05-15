/**
 * Pluggable LLM and rerank backend factory.
 *
 * Reads env-var feature flags and returns the right caller for each stage:
 *
 *   LLM_BACKEND=nan (default) | openrouter
 *     Routes query-analyzer, synthesis, post-synthesis (tldr/next_questions),
 *     background citizen-summary generation, and declined-suggestions to either
 *     the NaN qwen3.6 stack (default, $0) or OpenRouter Gemini Flash Lite (paid,
 *     lower-latency).
 *
 *   RERANK_BACKEND=qwen-llm (default) | cohere-or
 *     Routes the reranker to either the NaN qwen3.6 LLM reranker (default) or
 *     Cohere Rerank via OpenRouter (paid, deterministic cross-encoder).
 *
 *   OPENROUTER_LLM_MODEL=google/gemini-2.5-flash-lite (default for openrouter backend)
 *     The OpenRouter chat model used when LLM_BACKEND=openrouter.
 *
 *   OPENROUTER_RERANK_MODEL=cohere/rerank-4-fast (default for cohere-or backend)
 *     The OpenRouter rerank model used when RERANK_BACKEND=cohere-or.
 *
 * DEFAULTS: when no env vars are set, behaviour is identical to the pre-PR
 * code — Qwen NaN everywhere. Flip env vars in .env.prod to activate new paths.
 *
 * Opik span names are preserved across backends:
 *   - "query-analysis" for the analyzer
 *   - "synthesis" for synthesis
 *   - "rerank" for the reranker
 *
 * Embeddings are NOT affected by this module (qwen3-nan, untouched).
 */

import { callNan, callNanStream } from "../nan.ts";
import { getNanApiKey } from "../nan-api-key.ts";
import type {
	OpenRouterOptions,
	OpenRouterResult,
	StreamDelta,
	StreamDone,
} from "../openrouter.ts";
import { callOpenRouter, callOpenRouterStream } from "../openrouter.ts";
import type { LLMCandidate, LLMRerankResult } from "./qwen-llm-rerank.ts";
import { qwenLLMRerank } from "./qwen-llm-rerank.ts";
import { CohereReranker } from "./rerankers/cohere.ts";

// ── Env-var constants ──

/** LLM backend: "nan" (default) or "openrouter" */
export const LLM_BACKEND = (process.env.LLM_BACKEND ?? "nan") as
	| "nan"
	| "openrouter";

/** Rerank backend: "qwen-llm" (default) or "cohere-or" */
export const RERANK_BACKEND = (process.env.RERANK_BACKEND ?? "qwen-llm") as
	| "qwen-llm"
	| "cohere-or";

/** OpenRouter chat model used when LLM_BACKEND=openrouter */
export const OPENROUTER_LLM_MODEL =
	process.env.OPENROUTER_LLM_MODEL ?? "google/gemini-2.5-flash-lite";

/** OpenRouter rerank model used when RERANK_BACKEND=cohere-or */
export const OPENROUTER_RERANK_MODEL =
	process.env.OPENROUTER_RERANK_MODEL ?? "cohere/rerank-4-fast";

// ── LLM caller types (mirrors AnalyzerLlmFn / SynthesisLlmFn) ──

export type LlmCallerOptions = OpenRouterOptions;

export type LlmCaller = <T>(
	apiKey: string,
	options: LlmCallerOptions,
) => Promise<OpenRouterResult<T>>;

export type LlmStreamCaller = (
	apiKey: string,
	options: Omit<LlmCallerOptions, "jsonResponse" | "jsonSchema">,
) => AsyncGenerator<StreamDelta | StreamDone>;

// ── Rerank caller type ──

export type RerankCaller = (
	query: string,
	candidates: LLMCandidate[],
	topK: number,
) => Promise<{ results: LLMRerankResult[]; backend: string; cost: number }>;

// ── Factory functions ──

/**
 * Returns the non-streaming LLM caller based on LLM_BACKEND env var.
 *
 * When LLM_BACKEND=nan (default): uses callNan with qwen3.6 at api.nan.builders.
 * When LLM_BACKEND=openrouter: uses callOpenRouter with OPENROUTER_LLM_MODEL.
 *
 * The returned caller respects the model override from the options parameter —
 * for NaN, it passes through as-is; for OpenRouter, it overrides with
 * OPENROUTER_LLM_MODEL unless the caller explicitly set one.
 */
export function getLlmCaller(): LlmCaller {
	if (LLM_BACKEND === "openrouter") {
		return openRouterLlmCaller;
	}
	// Default: NaN (callNan already handles retries, backoff, and json parsing)
	return callNan as LlmCaller;
}

/**
 * Returns the streaming LLM caller based on LLM_BACKEND env var.
 *
 * When LLM_BACKEND=nan (default): uses callNanStream.
 * When LLM_BACKEND=openrouter: uses callOpenRouterStream with OPENROUTER_LLM_MODEL.
 */
export function getLlmStreamCaller(): LlmStreamCaller {
	if (LLM_BACKEND === "openrouter") {
		return openRouterStreamCaller;
	}
	// Default: NaN streaming
	return callNanStream as LlmStreamCaller;
}

/**
 * Returns the rerank caller based on RERANK_BACKEND env var.
 *
 * When RERANK_BACKEND=qwen-llm (default): uses qwenLLMRerank via NaN.
 * When RERANK_BACKEND=cohere-or: uses CohereReranker via OpenRouter with
 *   OPENROUTER_RERANK_MODEL (default: cohere/rerank-4-fast).
 *
 * The returned function has the same signature as qwenLLMRerank so it drops
 * straight into reranker.ts without changes at the call site.
 */
export function getRerankCaller(nanApiKey?: string): RerankCaller {
	if (RERANK_BACKEND === "cohere-or") {
		const orKey = process.env.OPENROUTER_API_KEY ?? "";
		if (!orKey) {
			console.warn(
				"[backends] RERANK_BACKEND=cohere-or but OPENROUTER_API_KEY is not set — falling back to qwen-llm rerank",
			);
			// Graceful degradation: fall back to qwen-llm so prod doesn't explode if
			// the env var is missing after a partial deploy.
			return makeQwenRerankCaller(nanApiKey);
		}
		return makeCohereOrRerankCaller(orKey);
	}
	// Default: qwen-llm rerank via NaN
	return makeQwenRerankCaller(nanApiKey);
}

// ── Private helpers ──

/**
 * OpenRouter non-streaming caller. Overrides the model to OPENROUTER_LLM_MODEL
 * while preserving all other options (prompts, temperature, jsonSchema, etc.)
 * from the call site. The `apiKey` parameter is used only as a last-resort
 * fallback; OPENROUTER_API_KEY takes precedence.
 */
async function openRouterLlmCaller<T>(
	_apiKey: string,
	options: LlmCallerOptions,
): Promise<OpenRouterResult<T>> {
	const orKey = process.env.OPENROUTER_API_KEY ?? _apiKey;
	return callOpenRouter<T>(orKey, {
		...options,
		model: OPENROUTER_LLM_MODEL,
	});
}

/**
 * OpenRouter streaming caller. Same model override as above, SSE-streamed.
 */
async function* openRouterStreamCaller(
	_apiKey: string,
	options: Omit<LlmCallerOptions, "jsonResponse" | "jsonSchema">,
): AsyncGenerator<StreamDelta | StreamDone> {
	const orKey = process.env.OPENROUTER_API_KEY ?? _apiKey;
	yield* callOpenRouterStream(orKey, {
		...options,
		model: OPENROUTER_LLM_MODEL,
	});
}

/** Build a rerank caller that delegates to qwenLLMRerank via NaN. */
function makeQwenRerankCaller(nanApiKey?: string): RerankCaller {
	return async (query, candidates, topK) => {
		const key = nanApiKey ?? getNanApiKey() ?? "";
		return qwenLLMRerank(key, query, candidates, topK);
	};
}

/** Build a rerank caller that delegates to CohereReranker via OpenRouter. */
function makeCohereOrRerankCaller(orKey: string): RerankCaller {
	// CohereReranker is a class — instantiate once and reuse. The constructor
	// picks the backend from its arguments; we force openrouter path by only
	// providing the openrouterApiKey.
	const reranker = new CohereReranker({ openrouterApiKey: orKey });
	return async (query, candidates, topK) => {
		const result = await reranker.rerank(query, candidates, topK);
		// Return shape matches LLMRerankResult[]
		return {
			results: result.results.map((r) => ({
				key: r.key,
				relevanceScore: r.relevanceScore,
				rank: r.rank,
			})),
			backend: result.backend,
			cost: result.cost,
		};
	};
}
