/**
 * Pluggable LLM and rerank backend factory.
 *
 * Reads env-var feature flags and returns the right caller for each stage:
 *
 *   LLM_BACKEND=openrouter (default) | nan
 *     Routes query-analyzer, synthesis, post-synthesis (tldr/next_questions)
 *     and declined-suggestions. Default: OpenRouter with OPENROUTER_LLM_MODEL.
 *     "nan" (qwen3.6 on api.nan.builders) is a legacy opt-in kept for research
 *     harnesses. It is only honoured when NAN_API_KEY is set; otherwise we warn
 *     and use OpenRouter instead of failing on a missing key.
 *
 *   RERANK_BACKEND=llm (default) | none | cohere-or | qwen-llm
 *     Routes the reranker.
 *     - "llm": listwise LLM rerank through OpenRouter with
 *       OPENROUTER_RERANK_LLM_MODEL (llm-rerank.ts). Works under OpenRouter
 *       Zero Data Retention, which the account enforces.
 *     - "none": keep the fused (RRF + boosts) order, no extra call.
 *     - "cohere-or": Cohere Rerank via OpenRouter /rerank
 *       (OPENROUTER_RERANK_MODEL). Opt-in only: Cohere has no ZDR endpoint, so
 *       on a ZDR account every call 404s and falls back to the fused order.
 *     - "qwen-llm": legacy qwen3.6 LLM rerank on NaN, honoured only when
 *       NAN_API_KEY is set.
 *     Eval 2026-09-23 (82 citizen queries, packages/eval/results/
 *     2026-09-23-model-zdr.md): llm vs none = Hit@1 67.1% vs 43.9%.
 *
 *   OPENROUTER_LLM_MODEL=google/gemini-2.5-flash-lite (default)
 *     The OpenRouter chat model for the query analyzer and the auxiliary
 *     calls (post-synthesis tldr/next_questions in streaming mode,
 *     declined-suggestions, lazy per-article citizen summaries).
 *
 *   OPENROUTER_SYNTHESIS_MODEL=openai/gpt-6-luna (default)
 *     The OpenRouter chat model that writes the answer (JSON and streaming).
 *     Eval 2026-09-23: judge 9.23 vs 8.41 for flash-lite, 94% vs 78% inline
 *     citation precision, same cost, ~2.5× latency.
 *
 *   OPENROUTER_SYNTHESIS_REASONING=minimal|low|medium|high|none
 *     Reasoning effort sent with synthesis calls. Default: "minimal" for
 *     openai/* models (as evaluated), unset (provider default) otherwise.
 *
 *   OPENROUTER_RERANK_LLM_MODEL=google/gemini-2.5-flash-lite (default)
 *     The chat model used by the "llm" rerank backend.
 *
 *   OPENROUTER_RERANK_MODEL=cohere/rerank-4-fast (default)
 *     The OpenRouter rerank model used by the cohere-or backend.
 *
 * History: the NaN stack was the code default until the NaN subscription was
 * cancelled (2026-08). OpenRouter is now the default so an unset flag can never
 * route traffic to a dead provider.
 *
 * Opik span names are preserved across backends:
 *   - "query-analysis" for the analyzer
 *   - "synthesis" for synthesis
 *   - "rerank" for the reranker
 *
 * Embeddings are NOT affected by this module (see embeddings.ts — they run on
 * OpenRouter qwen/qwen3-embedding-8b).
 */

import { callNan, callNanStream } from "../nan.ts";
import { getNanApiKey } from "../nan-api-key.ts";
import type {
	OpenRouterOptions,
	OpenRouterReasoning,
	OpenRouterResult,
	StreamDelta,
	StreamDone,
} from "../openrouter.ts";
import { callOpenRouter, callOpenRouterStream } from "../openrouter.ts";
import type { LLMCandidate, LLMRerankResult } from "./llm-rerank.ts";
import { llmRerank, qwenLLMRerank } from "./llm-rerank.ts";
import { CohereReranker } from "./rerankers/cohere.ts";

// ── Backend resolution ──

export type LlmBackend = "openrouter" | "nan";
export type RerankBackend = "llm" | "none" | "cohere-or" | "qwen-llm";

/**
 * Resolve the LLM backend from the environment. Pure (env passed in) so it can
 * be unit-tested. The NaN opt-in is only honoured when a NaN key is present.
 */
export function resolveLlmBackend(
	env: Record<string, string | undefined>,
): LlmBackend {
	const requested = (env.LLM_BACKEND ?? "openrouter").trim().toLowerCase();
	if (requested === "nan") {
		if (env.NAN_API_KEY) return "nan";
		console.warn(
			"[backends] LLM_BACKEND=nan but NAN_API_KEY is not set — using OpenRouter",
		);
		return "openrouter";
	}
	if (requested !== "openrouter" && requested !== "") {
		console.warn(
			`[backends] Unknown LLM_BACKEND="${requested}" — using OpenRouter`,
		);
	}
	return "openrouter";
}

/**
 * Same as resolveLlmBackend, for the reranker. Default "llm" (ZDR-compatible
 * LLM rerank on OpenRouter). Unknown values fall back to the default.
 */
export function resolveRerankBackend(
	env: Record<string, string | undefined>,
): RerankBackend {
	const requested = (env.RERANK_BACKEND ?? "llm").trim().toLowerCase();
	if (requested === "" || requested === "llm") return "llm";
	if (requested === "none" || requested === "cohere-or") return requested;
	if (requested === "qwen-llm") {
		if (env.NAN_API_KEY) return "qwen-llm";
		console.warn(
			"[backends] RERANK_BACKEND=qwen-llm but NAN_API_KEY is not set — using llm",
		);
		return "llm";
	}
	console.warn(`[backends] Unknown RERANK_BACKEND="${requested}" — using llm`);
	return "llm";
}

// ── Env-var constants ──

/** Effective LLM backend: "openrouter" (default) or "nan" (legacy opt-in). */
export const LLM_BACKEND: LlmBackend = resolveLlmBackend(process.env);

/** Effective rerank backend (default "llm"). */
export const RERANK_BACKEND: RerankBackend = resolveRerankBackend(process.env);

/** OpenRouter chat model used by the openrouter LLM backend. */
export const OPENROUTER_LLM_MODEL =
	process.env.OPENROUTER_LLM_MODEL || "google/gemini-2.5-flash-lite";

/** OpenRouter chat model used by the "llm" rerank backend. */
export const OPENROUTER_RERANK_LLM_MODEL =
	process.env.OPENROUTER_RERANK_LLM_MODEL || "google/gemini-2.5-flash-lite";

/** OpenRouter rerank model used by the cohere-or backend (opt-in). */
export const OPENROUTER_RERANK_MODEL =
	process.env.OPENROUTER_RERANK_MODEL || "cohere/rerank-4-fast";

/** OpenRouter chat model that writes the answer (distinct from the analyzer). */
export const OPENROUTER_SYNTHESIS_MODEL =
	process.env.OPENROUTER_SYNTHESIS_MODEL || "openai/gpt-6-luna";

/** Model id that serves analyzer + auxiliary calls (for logs/traces). */
export const EFFECTIVE_LLM_MODEL =
	LLM_BACKEND === "openrouter" ? OPENROUTER_LLM_MODEL : "qwen3.6";

/** Model id that serves synthesis (reported as `meta.model`). */
export const EFFECTIVE_SYNTHESIS_MODEL =
	LLM_BACKEND === "openrouter" ? OPENROUTER_SYNTHESIS_MODEL : "qwen3.6";

/**
 * Reasoning setting for synthesis calls. Pure (env passed in) for tests.
 * Explicit OPENROUTER_SYNTHESIS_REASONING wins ("none" → omit the field);
 * otherwise OpenAI reasoning models get { effort: "minimal" } — the setting
 * used in the 2026-09-23 eval — and every other model gets nothing, so e.g.
 * Gemini Flash Lite keeps its non-thinking default.
 */
export function resolveSynthesisReasoning(
	model: string,
	env: Record<string, string | undefined>,
): OpenRouterReasoning | undefined {
	const raw = env.OPENROUTER_SYNTHESIS_REASONING?.trim().toLowerCase();
	if (raw) {
		if (raw === "none" || raw === "off") return undefined;
		if (
			raw === "minimal" ||
			raw === "low" ||
			raw === "medium" ||
			raw === "high"
		)
			return { effort: raw };
		console.warn(
			`[backends] Unknown OPENROUTER_SYNTHESIS_REASONING="${raw}" — using model default`,
		);
	}
	return model.startsWith("openai/") ? { effort: "minimal" } : undefined;
}

/** Effective reasoning setting for synthesis (OpenRouter backend only). */
export const SYNTHESIS_REASONING: OpenRouterReasoning | undefined =
	LLM_BACKEND === "openrouter"
		? resolveSynthesisReasoning(OPENROUTER_SYNTHESIS_MODEL, process.env)
		: undefined;

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
 * Returns the non-streaming LLM caller for the effective LLM_BACKEND.
 *
 * openrouter (default): callOpenRouter with the model given by the call site
 *   (analyzer → EFFECTIVE_LLM_MODEL, synthesis → EFFECTIVE_SYNTHESIS_MODEL);
 *   OPENROUTER_API_KEY is read from the env.
 * nan (opt-in): callNan, model passed through as-is.
 */
export function getLlmCaller(): LlmCaller {
	if (LLM_BACKEND === "nan") return callNan as LlmCaller;
	return openRouterLlmCaller;
}

/** Streaming counterpart of getLlmCaller(). */
export function getLlmStreamCaller(): LlmStreamCaller {
	if (LLM_BACKEND === "nan") return callNanStream as LlmStreamCaller;
	return openRouterStreamCaller;
}

/**
 * Returns the rerank caller for the effective RERANK_BACKEND.
 *
 * llm (default): llmRerank via OpenRouter (OPENROUTER_RERANK_LLM_MODEL).
 * none: passthrough — the fused order, no network call.
 * cohere-or (opt-in): CohereReranker via OpenRouter (OPENROUTER_RERANK_MODEL).
 * qwen-llm (legacy opt-in): qwenLLMRerank via NaN.
 *
 * The OpenRouter backends warn and return passthrough when
 * OPENROUTER_API_KEY is missing, rather than throwing.
 */
export function getRerankCaller(
	nanApiKey?: string,
	backend: RerankBackend = RERANK_BACKEND,
): RerankCaller {
	if (backend === "none") return passthroughRerankCaller;
	if (backend === "qwen-llm") {
		return makeQwenRerankCaller(nanApiKey);
	}
	const orKey = process.env.OPENROUTER_API_KEY ?? "";
	if (!orKey) {
		console.warn(
			"[backends] OPENROUTER_API_KEY is not set — rerank disabled (passthrough)",
		);
		return passthroughRerankCaller;
	}
	if (backend === "cohere-or") return makeCohereOrRerankCaller(orKey);
	return makeLlmRerankCaller(orKey);
}

// ── Private helpers ──

/**
 * OpenRouter non-streaming caller. Uses the model the call site passes
 * (analyzer and synthesis can differ) and preserves all other options.
 * OPENROUTER_API_KEY takes precedence over `apiKey`.
 */
async function openRouterLlmCaller<T>(
	_apiKey: string,
	options: LlmCallerOptions,
): Promise<OpenRouterResult<T>> {
	const orKey = process.env.OPENROUTER_API_KEY ?? _apiKey;
	return callOpenRouter<T>(orKey, options);
}

/** OpenRouter streaming caller (same contract as above, SSE-streamed). */
async function* openRouterStreamCaller(
	_apiKey: string,
	options: Omit<LlmCallerOptions, "jsonResponse" | "jsonSchema">,
): AsyncGenerator<StreamDelta | StreamDone> {
	const orKey = process.env.OPENROUTER_API_KEY ?? _apiKey;
	yield* callOpenRouterStream(orKey, options);
}

/** Keeps the incoming (fused) order. Used when no rerank provider is available. */
const passthroughRerankCaller: RerankCaller = async (
	_query,
	candidates,
	topK,
) => ({
	results: candidates.slice(0, topK).map((c, i) => ({
		key: c.key,
		relevanceScore: 1 - i * 0.01,
		rank: i + 1,
	})),
	backend: "none",
	cost: 0,
});

/** Build a rerank caller that delegates to llmRerank via OpenRouter. */
function makeLlmRerankCaller(orKey: string): RerankCaller {
	return (query, candidates, topK) =>
		llmRerank(orKey, query, candidates, topK, {
			model: OPENROUTER_RERANK_LLM_MODEL,
			label: "llm-rerank",
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
