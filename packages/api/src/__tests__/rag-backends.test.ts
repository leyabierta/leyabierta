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
	it("defaults to cohere-or when unset", () => {
		expect(resolveRerankBackend({})).toBe("cohere-or");
	});

	it("falls back to cohere-or when qwen-llm is requested without NAN_API_KEY", () => {
		expect(resolveRerankBackend({ RERANK_BACKEND: "qwen-llm" })).toBe(
			"cohere-or",
		);
	});

	it("allows the qwen-llm opt-in only with NAN_API_KEY", () => {
		expect(
			resolveRerankBackend({ RERANK_BACKEND: "qwen-llm", NAN_API_KEY: "k" }),
		).toBe("qwen-llm");
	});
});
