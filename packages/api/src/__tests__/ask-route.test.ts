/**
 * Tests for the /v1/ask route.
 * Mocks the RagPipeline to test HTTP-level behavior.
 */

import { describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { askRoutes } from "../routes/ask.ts";
import type { AskResponse, RagPipeline } from "../services/rag/pipeline.ts";

const HAPPY_RESPONSE: AskResponse = {
	answer: "Tienes derecho a 30 dias de vacaciones.",
	citations: [
		{
			normId: "BOE-A-1995-7730",
			normTitle: "Estatuto de los Trabajadores",
			articleTitle: "Articulo 38",
			citizenSummary: "Vacaciones pagadas",
		},
	],
	declined: false,
	meta: {
		articlesRetrieved: 3,
		temporalEnriched: false,
		latencyMs: 150,
		model: "google/gemini-2.5-flash-lite",
	},
};

function buildApp(pipeline: RagPipeline | null) {
	return new Elysia().use(askRoutes(pipeline));
}

describe("/v1/ask route", () => {
	test("503 when pipeline is null", async () => {
		const app = buildApp(null);
		const res = await app.handle(
			new Request("http://localhost/v1/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: "Test question" }),
			}),
		);

		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toContain("no est");
	});

	test("400 for question shorter than 3 chars", async () => {
		const mockPipeline = {
			ask: mock(() => Promise.resolve(HAPPY_RESPONSE)),
		} as unknown as RagPipeline;
		const app = buildApp(mockPipeline);

		const res = await app.handle(
			new Request("http://localhost/v1/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: "ab" }),
			}),
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toContain("3 caracteres");
	});

	test("400 for question longer than 1000 chars", async () => {
		const mockPipeline = {
			ask: mock(() => Promise.resolve(HAPPY_RESPONSE)),
		} as unknown as RagPipeline;
		const app = buildApp(mockPipeline);

		const res = await app.handle(
			new Request("http://localhost/v1/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: "x".repeat(1001) }),
			}),
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toContain("1000 caracteres");
	});

	test("400 for whitespace-only question", async () => {
		const mockPipeline = {
			ask: mock(() => Promise.resolve(HAPPY_RESPONSE)),
		} as unknown as RagPipeline;
		const app = buildApp(mockPipeline);

		const res = await app.handle(
			new Request("http://localhost/v1/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: "   " }),
			}),
		);

		expect(res.status).toBe(400);
	});

	test("500 when pipeline.ask() throws", async () => {
		const mockPipeline = {
			ask: mock(() => Promise.reject(new Error("LLM down"))),
		} as unknown as RagPipeline;
		const app = buildApp(mockPipeline);

		const res = await app.handle(
			new Request("http://localhost/v1/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: "Valid question here" }),
			}),
		);

		expect(res.status).toBe(500);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toContain("Error procesando");
	});

	test("happy path returns AskResponse", async () => {
		const mockPipeline = {
			ask: mock(() => Promise.resolve(HAPPY_RESPONSE)),
		} as unknown as RagPipeline;
		const app = buildApp(mockPipeline);

		const res = await app.handle(
			new Request("http://localhost/v1/ask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: "Cuantas vacaciones tengo?" }),
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as AskResponse;
		expect(body.answer).toContain("30 dias");
		expect(body.citations).toHaveLength(1);
		expect(body.citations[0]!.normId).toBe("BOE-A-1995-7730");
		expect(body.declined).toBe(false);
		expect(body.meta.articlesRetrieved).toBe(3);
	});
});
