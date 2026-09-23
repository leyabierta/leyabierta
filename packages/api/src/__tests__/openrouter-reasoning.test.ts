/**
 * The OpenRouter client forwards `reasoning` (synthesis on openai/gpt-6-luna
 * uses { effort: "minimal" }) on both the JSON and the streaming path, and
 * omits it when unset. No network: global fetch is stubbed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	callOpenRouter,
	callOpenRouterStream,
	OpenRouterError,
} from "../services/openrouter.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function capture(response: () => Response): Array<Record<string, unknown>> {
	const bodies: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return response();
	}) as unknown as typeof fetch;
	return bodies;
}

const jsonOk = () =>
	new Response(
		JSON.stringify({
			choices: [{ message: { content: '{"ok":true}' } }],
			usage: { cost: 0.001, prompt_tokens: 10, completion_tokens: 2 },
		}),
		{ status: 200 },
	);

const sseOk = () =>
	new Response(
		'data: {"choices":[{"delta":{"content":"Sí."}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":0.0001}}\n\ndata: [DONE]\n\n',
		{ status: 200 },
	);

const messages = [{ role: "user" as const, content: "hola" }];

describe("OpenRouter reasoning passthrough", () => {
	it("JSON path sends reasoning when set", async () => {
		const bodies = capture(jsonOk);
		await callOpenRouter("k", {
			model: "openai/gpt-6-luna",
			messages,
			reasoning: { effort: "minimal" },
		});
		expect(bodies[0]?.reasoning).toEqual({ effort: "minimal" });
		expect(bodies[0]?.model).toBe("openai/gpt-6-luna");
	});

	it("JSON path omits reasoning when unset", async () => {
		const bodies = capture(jsonOk);
		await callOpenRouter("k", {
			model: "google/gemini-2.5-flash-lite",
			messages,
		});
		expect("reasoning" in (bodies[0] ?? {})).toBe(false);
	});

	it("streaming path sends reasoning and still yields content", async () => {
		const bodies = capture(sseOk);
		let text = "";
		for await (const ev of callOpenRouterStream("k", {
			model: "openai/gpt-6-luna",
			messages,
			reasoning: { effort: "minimal" },
		})) {
			if (ev.type === "delta") text += ev.text;
		}
		expect(bodies[0]?.reasoning).toEqual({ effort: "minimal" });
		expect(bodies[0]?.stream).toBe(true);
		expect(text).toBe("Sí.");
	});

	it("streaming never yields reasoning deltas as answer text", async () => {
		capture(
			() =>
				new Response(
					'data: {"choices":[{"delta":{"reasoning":"PENSANDO en secreto","reasoning_details":[{"type":"reasoning.text","text":"PENSANDO"}]}}]}\n\n' +
						'data: {"choices":[{"delta":{"content":"Respuesta."}}]}\n\n' +
						"data: [DONE]\n\n",
					{ status: 200 },
				),
		);
		let text = "";
		for await (const ev of callOpenRouterStream("k", {
			model: "openai/gpt-6-luna",
			messages,
		})) {
			if (ev.type === "delta") text += ev.text;
		}
		expect(text).toBe("Respuesta.");
	});

	it("streaming throws on a mid-stream error event instead of ending as if complete", async () => {
		capture(
			() =>
				new Response(
					'data: {"choices":[{"delta":{"content":"Según"}}]}\n\n' +
						'data: {"error":{"code":429,"message":"openai/gpt-6-luna is temporarily rate-limited upstream"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}\n\n' +
						"data: [DONE]\n\n",
					{ status: 200 },
				),
		);
		const seen: string[] = [];
		let caught: unknown = null;
		try {
			for await (const ev of callOpenRouterStream("k", {
				model: "openai/gpt-6-luna",
				messages,
			})) {
				seen.push(ev.type === "delta" ? ev.text : "<done>");
			}
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(OpenRouterError);
		expect((caught as OpenRouterError).code).toBe("stream_error");
		expect(seen).toEqual(["Según"]);
	});
});

describe("errors inside a 200 response", () => {
	it("a 429 in the body is retried and named rate_limit", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response(
				JSON.stringify({
					error: { code: 429, message: "temporarily rate-limited upstream" },
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;
		const err = await callOpenRouter("k", {
			model: "qwen/qwen3.8-27b",
			messages,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(OpenRouterError);
		expect((err as OpenRouterError).code).toBe("rate_limit");
		expect(calls).toBe(3);
	}, 15_000);

	it("succeeds when a retry returns content", async () => {
		let calls = 0;
		globalThis.fetch = (async () =>
			++calls === 1
				? new Response(JSON.stringify({ error: { code: 429 } }), {
						status: 200,
					})
				: jsonOk()) as unknown as typeof fetch;
		const res = await callOpenRouter<{ ok: boolean }>("k", {
			model: "qwen/qwen3.8-27b",
			messages,
		});
		expect(res.data).toEqual({ ok: true });
	}, 15_000);
});
