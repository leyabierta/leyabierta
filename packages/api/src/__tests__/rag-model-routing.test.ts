/**
 * End-to-end model routing through the real backend callers (no llmFn
 * overrides): the OpenRouter caller must send the model each stage asks for —
 * it no longer forces OPENROUTER_LLM_MODEL on every call. Synthesis (JSON and
 * streaming) goes to OPENROUTER_SYNTHESIS_MODEL with SYNTHESIS_REASONING; the
 * analyzer and the auxiliary calls stay on OPENROUTER_LLM_MODEL with no
 * reasoning field. No network: global fetch is stubbed.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { analyzeQuery } from "../services/rag/analyzer.ts";
import {
	LLM_BACKEND,
	OPENROUTER_LLM_MODEL,
	OPENROUTER_SYNTHESIS_MODEL,
	SYNTHESIS_REASONING,
} from "../services/rag/backends.ts";
import {
	generatePostSynthExtras,
	SYNTHESIS_MODEL,
	synthesizeAnswer,
	synthesizeStream,
} from "../services/rag/synthesis.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const JSON_CONTENT = JSON.stringify({
	answer: "Sí [BOE-A-1995-7730, Artículo 38].",
	citations: [],
	declined: false,
	tldr: "Sí.",
	next_questions: [],
	keywords: ["vacaciones"],
	materias: [],
	temporal: false,
	non_legal: false,
	jurisdiction: null,
});

function stub(): Array<Record<string, unknown>> {
	const bodies: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		if (body.stream) {
			return new Response(
				'data: {"choices":[{"delta":{"content":"Sí."}}]}\n\ndata: [DONE]\n\n',
				{ status: 200 },
			);
		}
		return new Response(
			JSON.stringify({
				choices: [{ message: { content: JSON_CONTENT } }],
				usage: { cost: 0, prompt_tokens: 1, completion_tokens: 1 },
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
	return bodies;
}

describe.if(LLM_BACKEND === "openrouter")("RAG model routing", () => {
	it("synthesis defaults to a model distinct from the analyzer", () => {
		expect(SYNTHESIS_MODEL).toBe(OPENROUTER_SYNTHESIS_MODEL);
		if (
			!process.env.OPENROUTER_SYNTHESIS_MODEL &&
			!process.env.OPENROUTER_LLM_MODEL
		) {
			expect(SYNTHESIS_MODEL).toBe("openai/gpt-6-luna");
			expect(OPENROUTER_LLM_MODEL).toBe("google/gemini-2.5-flash-lite");
			expect(SYNTHESIS_REASONING).toEqual({ effort: "minimal" });
		}
	});

	it("JSON synthesis sends the synthesis model + reasoning", async () => {
		const bodies = stub();
		const r = await synthesizeAnswer({
			apiKey: "k",
			question: "¿vacaciones?",
			evidenceText: "…",
			systemPrompt: "sys",
		});
		expect(r.answer).toContain("Sí");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.model).toBe(OPENROUTER_SYNTHESIS_MODEL);
		expect(bodies[0]?.reasoning).toEqual(SYNTHESIS_REASONING);
	});

	it("streaming synthesis sends the synthesis model + reasoning", async () => {
		const bodies = stub();
		let text = "";
		for await (const ev of synthesizeStream({
			apiKey: "k",
			question: "¿vacaciones?",
			evidenceText: "…",
			systemPrompt: "sys",
		})) {
			if (ev.type === "delta") text += ev.text;
		}
		expect(text).toBe("Sí.");
		expect(bodies[0]?.model).toBe(OPENROUTER_SYNTHESIS_MODEL);
		expect(bodies[0]?.stream).toBe(true);
		expect(bodies[0]?.reasoning).toEqual(SYNTHESIS_REASONING);
	});

	it("analyzer and post-synthesis extras use OPENROUTER_LLM_MODEL, no reasoning", async () => {
		const bodies = stub();
		await analyzeQuery("k", "¿Cuántos días de vacaciones tengo?");
		await generatePostSynthExtras({
			apiKey: "k",
			question: "¿vacaciones?",
			answer: "Sí.",
		});
		expect(bodies).toHaveLength(2);
		for (const b of bodies) {
			expect(b.model).toBe(OPENROUTER_LLM_MODEL);
			expect("reasoning" in b).toBe(false);
		}
	});
});
