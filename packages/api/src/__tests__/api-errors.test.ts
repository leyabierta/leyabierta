/**
 * Structured JSON error responses (agent-readiness fix).
 *
 * Elysia's built-in errors (unmatched route, schema validation, unhandled
 * throw) are plain text by default. `structuredError` normalizes them to
 * `{ error, code, hint }` JSON via `app.onError`.
 */

import { describe, expect, it } from "bun:test";
import { Elysia, t } from "elysia";
import { structuredError } from "../services/api-errors.ts";

function buildApp() {
	return new Elysia()
		.onError(({ code, error, path, set }) => {
			const { status, body } = structuredError(code, error, path);
			set.status = status;
			return body;
		})
		.get("/health", () => ({ status: "ok" }))
		.get("/typed", ({ query }) => query, {
			query: t.Object({ n: t.Number() }),
		})
		.get("/boom", () => {
			throw new Error("kaboom");
		})
		.post("/only-post", () => "ok");
}

interface ErrorBody {
	error: string;
	code: string;
	hint?: string;
}

describe("structuredError / onError wiring", () => {
	it("returns structured JSON for an unmatched route (404)", async () => {
		const app = buildApp();
		const res = await app.handle(new Request("http://localhost/v1/nope"));
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as ErrorBody;
		expect(body.code).toBe("NOT_FOUND");
		expect(typeof body.error).toBe("string");
		expect(body.error.length).toBeGreaterThan(0);
		expect(body.hint).toContain("openapi.json");
	});

	it("returns structured JSON for a validation failure", async () => {
		const app = buildApp();
		const res = await app.handle(new Request("http://localhost/typed?n=abc"));
		expect(res.status).toBe(422);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as ErrorBody;
		expect(body.code).toBe("VALIDATION_ERROR");
		expect(typeof body.error).toBe("string");
	});

	it("returns structured JSON for an unhandled throw (500) without leaking internals", async () => {
		const app = buildApp();
		const res = await app.handle(new Request("http://localhost/boom"));
		expect(res.status).toBe(500);
		const body = (await res.json()) as ErrorBody;
		expect(body.code).toBe("UNKNOWN_ERROR");
		expect(body.error).toBe("Internal server error");
		expect(body.error).not.toContain("kaboom");
	});

	it("returns structured JSON for a method mismatch", async () => {
		const app = buildApp();
		const res = await app.handle(
			new Request("http://localhost/only-post", { method: "GET" }),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as ErrorBody;
		expect(body.code).toBe("NOT_FOUND");
	});

	it("a successful route is unaffected", async () => {
		const app = buildApp();
		const res = await app.handle(new Request("http://localhost/health"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("does not touch a handler-set JSON error body (existing shapes stay stable)", async () => {
		const app = new Elysia()
			.onError(({ code, error, path, set }) => {
				const { status, body } = structuredError(code, error, path);
				set.status = status;
				return body;
			})
			.get("/manual-404", ({ set }) => {
				set.status = 404;
				return { error: "Law not found" };
			});
		const res = await app.handle(new Request("http://localhost/manual-404"));
		expect(res.status).toBe(404);
		const body = await res.json();
		// Untouched: no injected `code`/`hint`, existing consumers keep working.
		expect(body).toEqual({ error: "Law not found" });
	});
});

describe("structuredError", () => {
	it("falls back to 500 UNKNOWN_ERROR for an unrecognized code", () => {
		const { status, body } = structuredError(
			"SOME_FUTURE_CODE",
			new Error("x"),
			"/x",
		);
		expect(status).toBe(500);
		expect(body.code).toBe("UNKNOWN_ERROR");
	});

	it("honors error.status for codes it does not special-case", () => {
		const err = Object.assign(new Error("nope"), { status: 401 });
		const { status, body } = structuredError("UNKNOWN", err, "/x");
		expect(status).toBe(401);
		expect(body.code).toBe("UNKNOWN_ERROR");
		expect(body.error).toBe("Request error");
	});
});
