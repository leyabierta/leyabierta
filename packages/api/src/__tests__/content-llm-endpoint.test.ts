/**
 * Opt-in OpenAI-compatible endpoint for generated content (CONTENT_LLM_BASE_URL,
 * e.g. a local Ollama). Default stays OpenRouter. No network: fetch is stubbed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { parseBatchContent } from "../scripts/citizen-summary-backfill-prompt.ts";
import {
	callOpenRouter,
	contentLlmEndpoint,
	stripThinking,
} from "../services/openrouter.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function capture(content: string) {
	const calls: Array<{
		url: string;
		headers: Record<string, string>;
		body: Record<string, unknown>;
	}> = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({
			url,
			headers: init?.headers as Record<string, string>,
			body: JSON.parse(String(init?.body)),
		});
		return new Response(
			JSON.stringify({
				choices: [{ message: { content } }],
				usage: { prompt_tokens: 10, completion_tokens: 2 },
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
	return calls;
}

const messages = [{ role: "user" as const, content: "hola" }];
const schema = { name: "x", schema: { type: "object" } };

describe("contentLlmEndpoint", () => {
	it("defaults to OpenRouter with the production model", () => {
		const ep = contentLlmEndpoint({ OPENROUTER_API_KEY: "k" });
		expect(ep.baseUrl).toBeUndefined();
		expect(ep.apiKey).toBe("k");
		expect(ep.model).toBe("google/gemini-2.5-flash-lite");
		expect(ep.extraBody).toEqual({});
	});

	it("local endpoint: trims the URL, disables reasoning, needs no key", () => {
		const ep = contentLlmEndpoint({
			CONTENT_LLM_BASE_URL: "http://localhost:11434/v1/",
			CONTENT_LLM_MODEL: "qwen3.8:27b-mlx",
			OPENROUTER_API_KEY: "must-not-leak",
		});
		expect(ep.baseUrl).toBe("http://localhost:11434/v1");
		expect(ep.apiKey).toBeUndefined();
		expect(ep.extraBody).toEqual({
			reasoning_effort: "none",
			chat_template_kwargs: { enable_thinking: false },
		});
		expect(ep.timeoutMs).toBe(300_000);
	});

	it("local endpoint requires an explicit model", () => {
		expect(() =>
			contentLlmEndpoint({ CONTENT_LLM_BASE_URL: "http://localhost:11434/v1" }),
		).toThrow();
	});

	it("empty CONTENT_LLM_REASONING_EFFORT omits the field but keeps thinking off (old vLLM)", () => {
		const ep = contentLlmEndpoint({
			CONTENT_LLM_BASE_URL: "http://x/v1",
			CONTENT_LLM_MODEL: "m",
			CONTENT_LLM_REASONING_EFFORT: "",
		});
		expect(ep.extraBody).toEqual({
			chat_template_kwargs: { enable_thinking: false },
		});
	});

	it("an explicit effort level leaves the chat template alone", () => {
		const ep = contentLlmEndpoint({
			CONTENT_LLM_BASE_URL: "http://x/v1",
			CONTENT_LLM_MODEL: "m",
			CONTENT_LLM_REASONING_EFFORT: "low",
		});
		expect(ep.extraBody).toEqual({ reasoning_effort: "low" });
	});
});

describe("callOpenRouter with baseUrl", () => {
	it("posts to the local endpoint without auth or OpenRouter plugins", async () => {
		const calls = capture('{"ok":true}');
		const res = await callOpenRouter<{ ok: boolean }>("", {
			model: "qwen3.8:27b-mlx",
			messages,
			jsonSchema: schema,
			baseUrl: "http://localhost:11434/v1",
			extraBody: { reasoning_effort: "none" },
		});
		expect(res.data.ok).toBe(true);
		expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
		expect(calls[0]?.headers.Authorization).toBeUndefined();
		expect("plugins" in (calls[0]?.body ?? {})).toBe(false);
		expect(calls[0]?.body.reasoning_effort).toBe("none");
	});

	it("default path is unchanged: OpenRouter URL, bearer key, response-healing", async () => {
		const calls = capture('{"ok":true}');
		await callOpenRouter("k", { model: "m", messages, jsonSchema: schema });
		expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(calls[0]?.headers.Authorization).toBe("Bearer k");
		expect(calls[0]?.body.plugins).toEqual([{ id: "response-healing" }]);
		expect("reasoning_effort" in (calls[0]?.body ?? {})).toBe(false);
	});

	it("never forwards OPENROUTER_API_KEY to a custom endpoint", async () => {
		for (const [extra, auth] of [
			[{}, undefined],
			[{ CONTENT_LLM_API_KEY: "vllm-key" }, "Bearer vllm-key"],
		] as const) {
			const ep = contentLlmEndpoint({
				CONTENT_LLM_BASE_URL: "https://gpu.example/v1",
				CONTENT_LLM_MODEL: "m",
				OPENROUTER_API_KEY: "sk-or-secret",
				...extra,
			});
			const calls = capture('{"ok":true}');
			await callOpenRouter(ep.apiKey ?? "", {
				model: ep.model,
				messages,
				jsonSchema: schema,
				baseUrl: ep.baseUrl,
				extraBody: ep.extraBody,
				timeoutMs: ep.timeoutMs,
			});
			expect(calls[0]?.headers.Authorization).toBe(auth);
			expect(JSON.stringify(calls)).not.toContain("sk-or-secret");
			expect("provider" in (calls[0]?.body ?? {})).toBe(false);
		}
	});

	it("reports zero cost (not NaN) when the endpoint sends no usage", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
			)) as unknown as typeof fetch;
		const res = await callOpenRouter("", {
			model: "m",
			messages,
			baseUrl: "http://localhost:11434/v1",
		});
		expect(res.cost).toBe(0);
		expect(res.tokensIn).toBe(0);
		expect(res.tokensOut).toBe(0);
	});

	it("strips inline <think> blocks before parsing", async () => {
		capture('<think>razonando…</think>\n{"ok":true}');
		const res = await callOpenRouter<{ ok: boolean }>("", {
			model: "m",
			messages,
			jsonSchema: schema,
			baseUrl: "http://localhost:11434/v1",
		});
		expect(res.data.ok).toBe(true);
	});
});

describe("stripThinking / parseBatchContent", () => {
	it("stripThinking leaves normal content alone", () => {
		expect(stripThinking(' {"a":1} ')).toBe('{"a":1}');
	});

	it("maps batch items by ARTÍCULO_n and reports dropped ones as null", () => {
		const r = parseBatchContent(
			JSON.stringify({
				articles: [
					{ article_id: "ARTÍCULO_2", citizen_summary: "s2", citizen_tags: [] },
				],
			}),
			2,
		);
		expect("outputs" in r && r.outputs[0]).toBeNull();
		expect("outputs" in r && r.outputs[1]?.citizen_summary).toBe("s2");
	});

	it("returns an error for unparseable content", () => {
		expect("error" in parseBatchContent("no json here", 1)).toBe(true);
	});
});
