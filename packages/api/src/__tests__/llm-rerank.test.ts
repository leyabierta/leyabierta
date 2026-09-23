/**
 * LLM listwise reranker (default RAG rerank backend under OpenRouter ZDR).
 * No network: fetch is injected.
 */

import { describe, expect, it } from "bun:test";
import {
	buildLlmRerankUserMessage,
	type LLMCandidate,
	llmRerank,
	parseLlmRerankResponse,
} from "../services/rag/llm-rerank.ts";

const cands: LLMCandidate[] = Array.from({ length: 6 }, (_, i) => ({
	key: `BOE-A-2015-11430:a${i + 1}`,
	title: `Artículo ${i + 1}`,
	text: "x".repeat(1000),
}));

function fakeFetch(
	responses: Array<{ status: number; body: unknown }>,
	calls: { n: number; bodies: string[] },
): typeof fetch {
	return (async (_url: string, init?: RequestInit) => {
		const r = responses[Math.min(calls.n, responses.length - 1)]!;
		calls.n++;
		calls.bodies.push(String(init?.body ?? ""));
		return new Response(JSON.stringify(r.body), { status: r.status });
	}) as unknown as typeof fetch;
}

const ok = (content: string, cost = 0.0012) => ({
	status: 200,
	body: { choices: [{ message: { content } }], usage: { cost } },
});

describe("parseLlmRerankResponse", () => {
	it("maps 1-based ids to keys in model order", () => {
		const r = parseLlmRerankResponse(
			'{"ranked":[{"id":3,"score":0.9},{"id":1,"score":0.5}]}',
			cands,
			2,
		);
		expect(r?.map((x) => x.key)).toEqual([cands[2]!.key, cands[0]!.key]);
		expect(r?.[0]?.rank).toBe(1);
	});

	it("drops out-of-range and duplicate ids and fills up to topK in fused order", () => {
		const r = parseLlmRerankResponse(
			'{"ranked":[{"id":99},{"id":2},{"id":2},{"id":0}]}',
			cands,
			3,
		);
		expect(r?.map((x) => x.key)).toEqual([
			cands[1]!.key,
			cands[0]!.key,
			cands[2]!.key,
		]);
	});

	it("extracts JSON wrapped in prose", () => {
		const r = parseLlmRerankResponse(
			'Aquí va: {"ranked":[{"id":4,"score":1}]} fin',
			cands,
			1,
		);
		expect(r?.[0]?.key).toBe(cands[3]!.key);
	});

	it("returns null for garbage or an empty ranking", () => {
		expect(parseLlmRerankResponse("nope", cands, 3)).toBeNull();
		expect(parseLlmRerankResponse('{"ranked":[]}', cands, 3)).toBeNull();
	});
});

describe("buildLlmRerankUserMessage", () => {
	it("numbers candidates and truncates the snippet", () => {
		const msg = buildLlmRerankUserMessage("¿vacaciones?", cands.slice(0, 2), 1);
		expect(msg).toContain("1. Artículo 1");
		expect(msg).toContain("2. Artículo 2");
		expect(msg).not.toContain("x".repeat(601));
	});
});

describe("llmRerank", () => {
	it("returns the model ranking and reports usage cost", async () => {
		const calls = { n: 0, bodies: [] as string[] };
		const out = await llmRerank("k", "q", cands, 2, {
			model: "google/gemini-2.5-flash-lite",
			fetchFn: fakeFetch([ok('{"ranked":[{"id":5},{"id":6}]}')], calls),
		});
		expect(out.backend).toBe("llm-rerank");
		expect(out.results.map((r) => r.key)).toEqual([
			cands[4]!.key,
			cands[5]!.key,
		]);
		expect(out.cost).toBeCloseTo(0.0012);
		expect(JSON.parse(calls.bodies[0]!).model).toBe(
			"google/gemini-2.5-flash-lite",
		);
	});

	it("does not call the API when there are no more candidates than topK", async () => {
		const calls = { n: 0, bodies: [] as string[] };
		const out = await llmRerank("k", "q", cands.slice(0, 2), 5, {
			fetchFn: fakeFetch([ok("{}")], calls),
		});
		expect(calls.n).toBe(0);
		expect(out.results).toHaveLength(2);
	});

	it("falls back to the fused order without retrying a 404 (e.g. ZDR-blocked model)", async () => {
		const calls = { n: 0, bodies: [] as string[] };
		const out = await llmRerank("k", "q", cands, 3, {
			fetchFn: fakeFetch([{ status: 404, body: { error: "zdr" } }], calls),
		});
		expect(calls.n).toBe(1);
		expect(out.backend).toBe("llm-rerank-failed");
		expect(out.results.map((r) => r.key)).toEqual(
			cands.slice(0, 3).map((c) => c.key),
		);
	});

	it("retries a 5xx once and then succeeds", async () => {
		const calls = { n: 0, bodies: [] as string[] };
		const out = await llmRerank("k", "q", cands, 1, {
			retryDelayMs: 0,
			fetchFn: fakeFetch(
				[{ status: 502, body: {} }, ok('{"ranked":[{"id":2}]}')],
				calls,
			),
		});
		expect(calls.n).toBe(2);
		expect(out.results[0]?.key).toBe(cands[1]!.key);
	});

	it("falls back without calling when there is no API key", async () => {
		const calls = { n: 0, bodies: [] as string[] };
		const out = await llmRerank("", "q", cands, 2, {
			fetchFn: fakeFetch([ok("{}")], calls),
		});
		expect(calls.n).toBe(0);
		expect(out.backend).toBe("llm-rerank-no-key");
	});
});
