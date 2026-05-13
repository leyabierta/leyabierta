/**
 * Smoke tests for the rag-gemini-legacy retriever module.
 *
 * These tests verify that the module imports cleanly (no side-effect crashes)
 * and that construction-time errors are raised with clear messages.
 * A full instantiation test is skipped because it requires:
 *   - data/vectors-gemini.bin (~5.7 GB, produced by export-gemini-vectors.ts)
 *   - OPENROUTER_API_KEY (external, never set in CI)
 *
 * See packages/eval/README.md § "Gemini legacy stack (for A/B only)" for
 * instructions on running the full A/B eval.
 */

import { describe, expect, test } from "bun:test";

// ── Module import (no side-effects) ───────────────────────────────────────────

describe("rag-gemini-legacy module", () => {
	test("imports without side-effect crashes", async () => {
		// Dynamic import: the module should load cleanly without touching the FS
		// or network (all I/O is deferred to initGeminiLegacy).
		const mod = await import("../src/retrievers/rag-gemini-legacy.ts");
		expect(typeof mod.initGeminiLegacy).toBe("function");
		expect(typeof mod.closeGeminiLegacy).toBe("function");
		expect(typeof mod.makeGeminiLegacyRetriever).toBe("function");
	});

	test("makeGeminiLegacyRetriever throws if not initialised", async () => {
		const { makeGeminiLegacyRetriever, closeGeminiLegacy } = await import(
			"../src/retrievers/rag-gemini-legacy.ts"
		);
		// Ensure no leftover state from a previous test.
		closeGeminiLegacy();
		const retrieve = makeGeminiLegacyRetriever(10);
		await expect(
			retrieve("¿Cuál es el plazo de prescripción?"),
		).rejects.toThrow("initGeminiLegacy()");
	});
});

// ── CohereReranker module ─────────────────────────────────────────────────────

describe("CohereReranker", () => {
	test("imports without side-effect crashes", async () => {
		const mod = await import("../../api/src/services/rag/rerankers/cohere.ts");
		expect(typeof mod.CohereReranker).toBe("function");
	});

	test("throws at construction when no API keys are set", () => {
		// Temporarily remove keys from env.
		const savedCohere = process.env.COHERE_API_KEY;
		const savedOR = process.env.OPENROUTER_API_KEY;
		// biome-ignore lint/performance/noDelete: need to truly unset env vars for this test
		delete process.env.COHERE_API_KEY;
		// biome-ignore lint/performance/noDelete: need to truly unset env vars for this test
		delete process.env.OPENROUTER_API_KEY;

		try {
			const { CohereReranker } =
				require("../../api/src/services/rag/rerankers/cohere.ts") as typeof import("../../api/src/services/rag/rerankers/cohere.ts");
			expect(() => new CohereReranker()).toThrow("COHERE_API_KEY");
		} finally {
			// Restore env.
			if (savedCohere !== undefined) process.env.COHERE_API_KEY = savedCohere;
			if (savedOR !== undefined) process.env.OPENROUTER_API_KEY = savedOR;
		}
	});

	test("prefers direct Cohere over OpenRouter when both keys set", async () => {
		const { CohereReranker } = await import(
			"../../api/src/services/rag/rerankers/cohere.ts"
		);
		const r = new CohereReranker({
			cohereApiKey: "test-cohere-key",
			openrouterApiKey: "test-or-key",
		});
		expect(r.backend).toBe("cohere-direct");
	});

	test("falls back to OpenRouter when only OPENROUTER_API_KEY is set", async () => {
		const { CohereReranker } = await import(
			"../../api/src/services/rag/rerankers/cohere.ts"
		);
		const r = new CohereReranker({ openrouterApiKey: "test-or-key" });
		expect(r.backend).toBe("cohere-openrouter");
	});

	test("rerank returns passthrough when candidates <= topK", async () => {
		const { CohereReranker } = await import(
			"../../api/src/services/rag/rerankers/cohere.ts"
		);
		const r = new CohereReranker({ cohereApiKey: "fake-key" });
		const candidates = [
			{ key: "BOE-A-2024-1:a1", title: "Art. 1", text: "Texto 1" },
			{ key: "BOE-A-2024-1:a2", title: "Art. 2", text: "Texto 2" },
		];
		// topK >= candidates.length → passthrough, no network call
		const result = await r.rerank("test query", candidates, 5);
		expect(result.backend).toContain("passthrough");
		expect(result.results).toHaveLength(2);
		expect(result.results[0]!.rank).toBe(1);
		expect(result.results[1]!.rank).toBe(2);
	});
});

// ── gemini-embedding-2 in EMBEDDING_MODELS ────────────────────────────────────

describe("EMBEDDING_MODELS gemini-embedding-2", () => {
	test("model is registered with correct dimensions", async () => {
		const { EMBEDDING_MODELS } = await import(
			"../../api/src/services/rag/embeddings.ts"
		);
		const model = EMBEDDING_MODELS["gemini-embedding-2"];
		expect(model).toBeDefined();
		expect(model!.dimensions).toBe(3072);
		expect(model!.id).toBe("google/gemini-embedding-2-preview");
		expect(model!.provider).toBe("openrouter");
	});

	test("qwen3-nan is unchanged (prod default not affected)", async () => {
		const { EMBEDDING_MODELS } = await import(
			"../../api/src/services/rag/embeddings.ts"
		);
		const model = EMBEDDING_MODELS["qwen3-nan"];
		expect(model).toBeDefined();
		expect(model!.dimensions).toBe(4096);
		expect(model!.provider).toBe("nan");
	});
});
