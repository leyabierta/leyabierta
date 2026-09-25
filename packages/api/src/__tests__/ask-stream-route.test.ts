/**
 * Regression test for POST /v1/ask/stream response shape.
 *
 * Before this fix the route was an `async function*` generator. Elysia's
 * default SSE headers use lowercase keys (`content-type`, `cache-control`)
 * and only skip them when it sees that key already set — but the route wrote
 * capitalized keys (`Content-Type`, `Cache-Control`), a different object key,
 * so both landed in the `Headers` object and got joined:
 * `Content-Type: text/event-stream, text/plain` and
 * `Cache-Control: no-cache, no-transform, no-cache`. Separately, `set.status`
 * assigned inside the generator body never reached the app-level
 * `mapResponse` hook used for the structured request log, so a 503 response
 * was logged as 200 (verified manually against a running server — see the PR
 * description; not reproducible in-process because the duplicate-header /
 * log-line bug lived in Elysia's generator+mapResponse interaction, not in
 * anything `app.handle()` alone exercises without the full `index.ts`
 * request pipeline).
 *
 * The route now returns a plain `Response` wrapping a `ReadableStream`
 * instead of a generator. This test locks in the two observable, in-process
 * checks: exactly one `Content-Type` / `Cache-Control` value each, and the
 * streamed body still carries the expected SSE `event: error` payload with
 * the right status when the pipeline is unavailable.
 */

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { askRoutes } from "../routes/ask.ts";

function buildApp() {
	// No RagPipeline (simulates missing OPENROUTER_API_KEY) and no quota —
	// the route must answer 503 without ever touching either.
	return new Elysia().use(askRoutes(null, {}));
}

describe("POST /v1/ask/stream", () => {
	test("503 when the pipeline is unavailable: single Content-Type/Cache-Control, correct status", async () => {
		const app = buildApp();
		const res = await app.handle(
			new Request("http://localhost/v1/ask/stream", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: "¿Qué dice la Constitución?" }),
			}),
		);

		expect(res.status).toBe(503);

		// getSetCookie-style multi-value headers aside, a single logical header
		// must appear once — Headers.get() returns the comma-joined value if
		// two entries landed under case-different keys, which is exactly the
		// regression this guards against.
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");

		const body = await res.text();
		expect(body).toContain("event: error");
		expect(body).toContain("El servicio de preguntas no está disponible");
	});
});
