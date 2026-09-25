/**
 * Structured JSON error responses (agent-readiness fix).
 *
 * Elysia's built-in errors (unmatched route, schema validation, unhandled
 * throw) are plain text by default. `structuredError` normalizes them to
 * `{ error, code, hint }` JSON via `app.onError`.
 */

import { describe, expect, it } from "bun:test";
import { Elysia, t } from "elysia";
import { errorResponse, structuredError } from "../services/api-errors.ts";

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

/**
 * PR #209 review, MEDIUM: `onAfterHandle` never runs for an onError-produced
 * response (Elysia only runs it on the success path), so a 404/422/500
 * previously shipped without the security headers, the `Link:
 * rel="service-desc"` header, or a request-log line. Mirrors the real
 * wiring in index.ts (mapResponse instead of onAfterHandle) to prove errors
 * get the same treatment as success responses.
 */
function buildAppWithHeadersAndLogging(onLog: (line: string) => void) {
	return new Elysia()
		.onError(({ code, error, path, set }) => {
			const { status, body } = structuredError(code, error, path);
			set.status = status;
			if (status >= 500) {
				onLog(
					`ERROR ${JSON.stringify({
						path,
						code,
						status,
						message: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					})}`,
				);
			}
			return body;
		})
		.mapResponse(({ set, path }) => {
			set.headers["X-Content-Type-Options"] = "nosniff";
			set.headers["X-Frame-Options"] = "DENY";
			set.headers["X-Robots-Tag"] = "noindex";
			set.headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
			set.headers.Link = '</openapi.json>; rel="service-desc"';
			onLog(`LOG ${JSON.stringify({ path, status: set.status ?? 200 })}`);
		})
		.get("/health", () => ({ status: "ok" }))
		.get("/boom", () => {
			throw new Error("kaboom, with secrets: sk-do-not-leak-this");
		});
}

describe("errors get the same headers and logging as success responses", () => {
	it("a 404 (unmatched route) carries the security headers and service-desc Link", async () => {
		const app = buildAppWithHeadersAndLogging(() => {});
		const res = await app.handle(new Request("http://localhost/v1/nope"));
		expect(res.status).toBe(404);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("x-robots-tag")).toBe("noindex");
		expect(res.headers.get("referrer-policy")).toBe(
			"strict-origin-when-cross-origin",
		);
		expect(res.headers.get("link")).toContain('rel="service-desc"');
	});

	it("a 500 (unhandled throw) also carries the security headers", async () => {
		const app = buildAppWithHeadersAndLogging(() => {});
		const res = await app.handle(new Request("http://localhost/boom"));
		expect(res.status).toBe(500);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("link")).toContain('rel="service-desc"');
	});

	it("logs a request line for an error response, same as for success", async () => {
		const lines: string[] = [];
		const app = buildAppWithHeadersAndLogging((l) => lines.push(l));
		await app.handle(new Request("http://localhost/v1/nope"));
		const logLine = lines.find((l) => l.startsWith("LOG"));
		expect(logLine).toContain('"path":"/v1/nope"');
		expect(logLine).toContain('"status":404');
	});

	it("500s are logged server-side with the real message/stack, never sent to the client", async () => {
		const lines: string[] = [];
		const app = buildAppWithHeadersAndLogging((l) => lines.push(l));
		const res = await app.handle(new Request("http://localhost/boom"));

		const body = (await res.json()) as ErrorBody;
		expect(body.error).not.toContain("sk-do-not-leak-this");
		expect(JSON.stringify(body)).not.toContain("kaboom");

		const errorLine = lines.find((l) => l.startsWith("ERROR"));
		expect(errorLine).toBeDefined();
		expect(errorLine).toContain("sk-do-not-leak-this");
		expect(errorLine).toContain('"path":"/boom"');
	});

	it("a 2xx response is not logged twice and is unaffected", async () => {
		const lines: string[] = [];
		const app = buildAppWithHeadersAndLogging((l) => lines.push(l));
		const res = await app.handle(new Request("http://localhost/health"));
		expect(res.status).toBe(200);
		expect(lines.filter((l) => l.startsWith("LOG"))).toHaveLength(1);
		expect(lines.some((l) => l.startsWith("ERROR"))).toBe(false);
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

// Regression (prod 2026-09-25): with a mapResponse hook registered — as in
// index.ts — Elysia 1.4 dropped the object returned from onError for
// NOT_FOUND and answered 404 with an empty body. index.ts returns
// errorResponse(); this app mirrors that wiring.
describe("onError with a mapResponse hook", () => {
	function buildAppWithMapResponse() {
		return new Elysia()
			.onError(({ code, error, path, set }) => {
				const { status, body } = structuredError(code, error, path);
				set.status = status;
				set.headers["X-Frame-Options"] = "DENY";
				return errorResponse(status, body, set.headers);
			})
			.mapResponse(({ set }) => {
				set.headers["X-Frame-Options"] = "DENY";
			})
			.get("/health", () => ({ status: "ok" }))
			.get("/boom", () => {
				throw new Error("kaboom");
			});
	}

	it("keeps the JSON body and headers on an unmatched route (404)", async () => {
		const res = await buildAppWithMapResponse().handle(
			new Request("http://localhost/v1/nope"),
		);
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		const body = (await res.json()) as ErrorBody;
		expect(body.code).toBe("NOT_FOUND");
		expect(body.hint).toContain("openapi.json");
	});

	it("keeps the JSON body on an unhandled throw (500) without leaking it", async () => {
		const res = await buildAppWithMapResponse().handle(
			new Request("http://localhost/boom"),
		);
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(text.length).toBeGreaterThan(0);
		expect(text).not.toContain("kaboom");
	});
});
