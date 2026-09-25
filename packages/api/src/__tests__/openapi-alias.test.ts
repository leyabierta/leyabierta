/**
 * `/openapi.json` alias for the swagger plugin's `/swagger/json` document
 * (agent-readiness fix: scanners look for /openapi.json specifically).
 */

import { describe, expect, it } from "bun:test";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { createOpenApiDoc } from "../services/openapi-doc.ts";
import { enrichOpenApiDoc } from "../services/openapi-schemas.ts";
import { createRateLimiter, getClientIp } from "../services/rate-limiter.ts";

interface OpenApiDoc {
	openapi: string;
	servers?: { url: string; description?: string }[];
	paths: Record<string, unknown>;
}

const RATE_LIMIT_EXEMPT_PATHS = new Set([
	"/health",
	"/openapi.json",
	"/swagger",
	"/swagger/json",
]);

/** Mirrors the real wiring in index.ts: a global per-path rate limiter (the
 *  same one that produced the PR #209 review bug) plus the memoized
 *  /openapi.json handler, on the same Elysia instance. */
function buildApp() {
	const limiter = createRateLimiter(60, 60_000);
	const app = new Elysia()
		.onBeforeHandle(({ request, set, path }) => {
			if (RATE_LIMIT_EXEMPT_PATHS.has(path)) return;
			if (limiter.isLimited(getClientIp(request))) {
				set.status = 429;
				return { error: "Too many requests" };
			}
		})
		.use(
			swagger({
				documentation: {
					info: { title: "Test API", version: "0.1.0" },
					servers: [
						{ url: "https://api.leyabierta.es", description: "Producción" },
					],
				},
			}),
		);

	const openApiDoc = createOpenApiDoc(() =>
		app.handle(new Request("http://internal.leyabierta/swagger/json")),
	);

	app
		.get("/health", () => ({ status: "ok" }))
		.get(
			"/openapi.json",
			async ({ set }) => {
				const { status, body } = await openApiDoc.get();
				set.status = status;
				return body;
			},
			{ detail: { hide: true } },
		);

	return app;
}

describe("/openapi.json alias", () => {
	it("serves the same document as /swagger/json, enriched with response schemas, as JSON", async () => {
		const app = buildApp();
		const [aliasRes, specRes] = await Promise.all([
			app.handle(new Request("http://localhost/openapi.json")),
			app.handle(new Request("http://localhost/swagger/json")),
		]);
		expect(aliasRes.status).toBe(200);
		expect(aliasRes.headers.get("content-type")).toContain("application/json");
		const [alias, spec] = await Promise.all([aliasRes.json(), specRes.json()]);
		// The alias isn't byte-identical to /swagger/json any more: build()
		// (openapi-doc.ts) runs the fetched document through enrichOpenApiDoc
		// (openapi-schemas.ts) to add the shared ErrorResponse component and
		// per-operation response schemas before caching it. That's the whole
		// point of the alias existing as its own route rather than a plain
		// redirect to /swagger/json — assert it's the same document, enriched.
		expect(alias).toEqual(enrichOpenApiDoc(spec));
	});

	it("points servers at the production API host", async () => {
		const app = buildApp();
		const res = await app.handle(new Request("http://localhost/openapi.json"));
		const body = (await res.json()) as OpenApiDoc;
		expect(body.servers).toEqual([
			{ url: "https://api.leyabierta.es", description: "Producción" },
		]);
		expect(body.openapi).toBe("3.0.3");
	});

	it("does not appear as a documented path in its own spec (hidden)", async () => {
		const app = buildApp();
		const res = await app.handle(new Request("http://localhost/openapi.json"));
		const body = (await res.json()) as OpenApiDoc;
		expect(body.paths["/openapi.json"]).toBeUndefined();
		expect(body.paths["/health"]).toBeDefined();
	});

	// PR #209 review, HIGH: the self-call into /swagger/json used to run on
	// every request, through the SAME global rate limiter as real traffic —
	// and the synthetic internal request has no CF-Connecting-IP, so it
	// always landed in one shared "unknown" bucket. After 60 requests to
	// /openapi.json from ANY real IPs, the limiter would 429 the internal
	// call, and the outer handler returned that 429 body under a 200 status.
	it("more than 60 requests from many different real IPs all still return 200 + the real spec", async () => {
		const app = buildApp();
		for (let i = 0; i < 200; i++) {
			const res = await app.handle(
				new Request("http://localhost/openapi.json", {
					headers: { "cf-connecting-ip": `203.0.113.${i % 255}` },
				}),
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as OpenApiDoc;
			expect(body.openapi).toBe("3.0.3");
		}
	});

	it("/openapi.json itself is exempt from the rate limiter, even from one real IP", async () => {
		const app = buildApp();
		for (let i = 0; i < 200; i++) {
			const res = await app.handle(
				new Request("http://localhost/openapi.json", {
					headers: { "cf-connecting-ip": "203.0.113.9" },
				}),
			);
			expect(res.status).toBe(200);
		}
	});

	it("a real rate-limited route is unaffected by the exemption (still 429s)", async () => {
		const app = buildApp();
		app.get("/v1/laws", () => ({ ok: true }));
		let sawLimited = false;
		for (let i = 0; i < 70; i++) {
			const res = await app.handle(
				new Request("http://localhost/v1/laws", {
					headers: { "cf-connecting-ip": "198.51.100.1" },
				}),
			);
			if (res.status === 429) sawLimited = true;
		}
		expect(sawLimited).toBe(true);
	});
});
