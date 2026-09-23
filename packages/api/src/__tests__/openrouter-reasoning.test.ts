/**
 * The OpenRouter client forwards `reasoning` (synthesis on openai/gpt-6-luna
 * uses { effort: "minimal" }) on both the JSON and the streaming path, and
 * omits it when unset. No network: global fetch is stubbed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	callOpenRouter,
	callOpenRouterStream,
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
});
