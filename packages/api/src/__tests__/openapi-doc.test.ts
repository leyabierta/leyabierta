/**
 * `createOpenApiDoc` memoization (PR #209 review, HIGH).
 *
 * The original `/openapi.json` handler self-called into `/swagger/json` via
 * `app.handle(new Request(...))` on EVERY request. That internal Request has
 * no `CF-Connecting-IP`, so it always landed in the rate limiter's shared
 * "unknown" bucket — every caller of `/openapi.json`, from any real IP, fed
 * the same counter. After 60 such self-calls the limiter's inner response
 * was a 429 body, and the outer handler (which never copied the inner
 * response's status) still answered **200** with that 429 body: call #61+
 * reproduced as `200 {"error":"Too many requests"}`.
 *
 * This tests the fix directly: build the document via a fake `fetchSpec`
 * wired to the SAME kind of limiter, and assert that far more than 60 calls
 * in a row all still return the real spec at 200 — because `fetchSpec` is
 * only ever invoked once.
 */

import { describe, expect, it } from "bun:test";
import { createOpenApiDoc } from "../services/openapi-doc.ts";
import { enrichOpenApiDoc } from "../services/openapi-schemas.ts";

const SPEC = { openapi: "3.0.3", info: { title: "Ley Abierta API" } };
// `build()` runs the fetched spec through `enrichOpenApiDoc` (adds the shared
// ErrorResponse schema + per-operation response schemas) before caching it —
// see services/openapi-doc.ts. The cached/returned body is the enriched
// document, not the raw one `fetchSpec` returned.
const ENRICHED_SPEC = enrichOpenApiDoc(SPEC);

/** Reproduces the historical bug's exact mechanism: a limiter keyed by a
 *  single shared "unknown" bucket (as `getClientIp()` returns for a request
 *  with no `CF-Connecting-IP`), capped at 60 calls, returning a 429 body
 *  after that — with no relation to the *caller's* identity. */
function limitedFetchSpec(limit = 60) {
	let calls = 0;
	return async (): Promise<Response> => {
		calls++;
		if (calls > limit) {
			return new Response(JSON.stringify({ error: "Too many requests" }), {
				status: 429,
			});
		}
		return new Response(JSON.stringify(SPEC), { status: 200 });
	};
}

describe("createOpenApiDoc", () => {
	it("calls fetchSpec only once across many get() calls", async () => {
		let calls = 0;
		const doc = createOpenApiDoc(async () => {
			calls++;
			return new Response(JSON.stringify(SPEC), { status: 200 });
		});

		for (let i = 0; i < 100; i++) {
			const { status, body } = await doc.get();
			expect(status).toBe(200);
			expect(body).toEqual(ENRICHED_SPEC);
		}
		expect(calls).toBe(1);
	});

	it("dedupes concurrent first callers into a single fetchSpec call", async () => {
		let calls = 0;
		const doc = createOpenApiDoc(async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 5));
			return new Response(JSON.stringify(SPEC), { status: 200 });
		});

		const results = await Promise.all(
			Array.from({ length: 20 }, () => doc.get()),
		);
		for (const { status, body } of results) {
			expect(status).toBe(200);
			expect(body).toEqual(ENRICHED_SPEC);
		}
		expect(calls).toBe(1);
	});

	it("more than 60 calls in a row all return 200 with the real spec — never a 200 wrapping a 429 body", async () => {
		const doc = createOpenApiDoc(limitedFetchSpec(60));

		for (let i = 0; i < 200; i++) {
			const { status, body } = await doc.get();
			expect(status).toBe(200);
			expect(body).toEqual(ENRICHED_SPEC);
			// The historical bug's exact shape: a 200 whose body is actually the
			// limiter's 429 error. Guard against it explicitly.
			expect(body).not.toHaveProperty("error");
		}
	});

	it("status is 200 only when the body is the spec; a build failure is a real 5xx, not a lying 200", async () => {
		const doc = createOpenApiDoc(
			async () => new Response("boom", { status: 500 }),
		);
		const { status, body } = await doc.get();
		expect(status).toBe(500);
		expect(status).not.toBe(200);
		expect(body).not.toEqual(ENRICHED_SPEC);
		expect((body as { code?: string }).code).toBe("OPENAPI_BUILD_FAILED");
	});

	it("logs the failure server-side without caching a broken result forever", async () => {
		const logs: string[] = [];
		let attempt = 0;
		const doc = createOpenApiDoc(
			async () => {
				attempt++;
				if (attempt === 1) return new Response("boom", { status: 500 });
				return new Response(JSON.stringify(SPEC), { status: 200 });
			},
			(msg) => logs.push(msg),
		);

		const first = await doc.get();
		expect(first.status).toBe(500);
		expect(logs.length).toBe(1);
		expect(logs[0]).toContain("openapi.json");

		// A later call gets to retry — a transient failure doesn't wedge the
		// endpoint forever.
		const second = await doc.get();
		expect(second.status).toBe(200);
		expect(second.body).toEqual(ENRICHED_SPEC);
	});

	it("a network-level throw from fetchSpec is handled the same way as a bad HTTP status", async () => {
		const doc = createOpenApiDoc(async () => {
			throw new Error("network down");
		});
		const { status, body } = await doc.get();
		expect(status).toBe(500);
		expect((body as { code?: string }).code).toBe("OPENAPI_BUILD_FAILED");
	});
});
