/**
 * `/openapi.json` alias for the swagger plugin's `/swagger/json` document
 * (agent-readiness fix: scanners look for /openapi.json specifically).
 */

import { describe, expect, it } from "bun:test";
import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";

interface OpenApiDoc {
	openapi: string;
	servers?: { url: string; description?: string }[];
	paths: Record<string, unknown>;
}

function buildApp() {
	const app = new Elysia().use(
		swagger({
			documentation: {
				info: { title: "Test API", version: "0.1.0" },
				servers: [
					{ url: "https://api.leyabierta.es", description: "Producción" },
				],
			},
		}),
	);

	app
		.get("/health", () => ({ status: "ok" }))
		.get(
			"/openapi.json",
			async () => {
				const res = await app.handle(
					new Request("http://internal.leyabierta/swagger/json"),
				);
				return res.json();
			},
			{ detail: { hide: true } },
		);

	return app;
}

describe("/openapi.json alias", () => {
	it("serves the same document as /swagger/json, as JSON", async () => {
		const app = buildApp();
		const [aliasRes, specRes] = await Promise.all([
			app.handle(new Request("http://localhost/openapi.json")),
			app.handle(new Request("http://localhost/swagger/json")),
		]);
		expect(aliasRes.status).toBe(200);
		expect(aliasRes.headers.get("content-type")).toContain("application/json");
		const [alias, spec] = await Promise.all([aliasRes.json(), specRes.json()]);
		expect(alias).toEqual(spec);
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
});
