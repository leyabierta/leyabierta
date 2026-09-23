/**
 * Backend resolution for the RAG LLM and rerank stages.
 *
 * OpenRouter is the default. The legacy NaN opt-ins must never be selected
 * without a NaN key (the provider was cancelled; a stale flag must not route
 * traffic to it and fail).
 */

import { describe, expect, it } from "bun:test";
import {
	resolveLlmBackend,
	resolveRerankBackend,
	resolveSynthesisReasoning,
} from "../services/rag/backends.ts";

describe("resolveLlmBackend", () => {
	it("defaults to openrouter when unset", () => {
		expect(resolveLlmBackend({})).toBe("openrouter");
	});

	it("honours explicit openrouter", () => {
		expect(resolveLlmBackend({ LLM_BACKEND: "openrouter" })).toBe("openrouter");
	});

	it("falls back to openrouter when nan is requested without NAN_API_KEY", () => {
		expect(resolveLlmBackend({ LLM_BACKEND: "nan" })).toBe("openrouter");
	});

	it("allows the nan opt-in only with NAN_API_KEY", () => {
		expect(resolveLlmBackend({ LLM_BACKEND: "nan", NAN_API_KEY: "k" })).toBe(
			"nan",
		);
	});

	it("treats unknown values as openrouter", () => {
		expect(resolveLlmBackend({ LLM_BACKEND: "gemini" })).toBe("openrouter");
	});
});

describe("resolveRerankBackend", () => {
	it("defaults to the ZDR-compatible llm rerank when unset", () => {
		expect(resolveRerankBackend({})).toBe("llm");
	});

	it("honours none and the cohere-or opt-in", () => {
		expect(resolveRerankBackend({ RERANK_BACKEND: "none" })).toBe("none");
		expect(resolveRerankBackend({ RERANK_BACKEND: "cohere-or" })).toBe(
			"cohere-or",
		);
		expect(resolveRerankBackend({ RERANK_BACKEND: " LLM " })).toBe("llm");
	});

	it("falls back to llm when qwen-llm is requested without NAN_API_KEY", () => {
		expect(resolveRerankBackend({ RERANK_BACKEND: "qwen-llm" })).toBe("llm");
	});

	it("allows the qwen-llm opt-in only with NAN_API_KEY", () => {
		expect(
			resolveRerankBackend({ RERANK_BACKEND: "qwen-llm", NAN_API_KEY: "k" }),
		).toBe("qwen-llm");
	});

	it("treats unknown values as llm", () => {
		expect(resolveRerankBackend({ RERANK_BACKEND: "voyage" })).toBe("llm");
	});
});

describe("resolveSynthesisReasoning", () => {
	it("uses minimal effort for OpenAI reasoning models by default", () => {
		expect(resolveSynthesisReasoning("openai/gpt-6-luna", {})).toEqual({
			effort: "minimal",
		});
	});

	it("sends nothing for other models (e.g. Gemini keeps its default)", () => {
		expect(
			resolveSynthesisReasoning("google/gemini-2.5-flash-lite", {}),
		).toBeUndefined();
	});

	it("honours an explicit effort and 'none'", () => {
		expect(
			resolveSynthesisReasoning("openai/gpt-6-luna", {
				OPENROUTER_SYNTHESIS_REASONING: "low",
			}),
		).toEqual({ effort: "low" });
		expect(
			resolveSynthesisReasoning("openai/gpt-6-luna", {
				OPENROUTER_SYNTHESIS_REASONING: "none",
			}),
		).toBeUndefined();
	});

	it("falls back to the model default on unknown values", () => {
		expect(
			resolveSynthesisReasoning("openai/gpt-6-luna", {
				OPENROUTER_SYNTHESIS_REASONING: "max",
			}),
		).toEqual({ effort: "minimal" });
	});
});
