// Worker tests for the agent-readiness fixes:
//  - /openapi.json proxied to the API, same-origin, no cross-domain redirect
//  - Accept: text/markdown on a missing path -> 404 in Markdown, not HTML
import { afterEach, describe, expect, test } from "bun:test";
import worker, { type Env } from "../worker/index.ts";

const NOT_FOUND_HTML = "<!DOCTYPE html><html><body>404</body></html>";

/** ASSETS binding: 200 for "/", 404 (like a real Workers static 404) for
 *  anything else, mirroring what the site actually serves. */
const assets = {
	fetch: async (input: RequestInfo) => {
		const req = input instanceof Request ? input : new Request(input);
		const pathname = new URL(req.url).pathname;
		if (pathname === "/") {
			return new Response("<!DOCTYPE html><html><body>home</body></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		}
		return new Response(NOT_FOUND_HTML, {
			status: 404,
			headers: { "content-type": "text/html" },
		});
	},
} as unknown as Fetcher;

const env: Env = { ASSETS: assets, PUBLIC_API_URL: "https://api.test" };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const get = (path: string, headers?: HeadersInit) =>
	worker.fetch(new Request(`https://leyabierta.es${path}`, { headers }), env);

describe("worker /openapi.json proxy", () => {
	test("proxies the API's spec as JSON on the web origin", async () => {
		const spec = { openapi: "3.0.3", info: { title: "Ley Abierta API" } };
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			expect(String(input)).toBe("https://api.test/openapi.json");
			return new Response(JSON.stringify(spec), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const res = await get("/openapi.json");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual(spec);
	});

	test("returns a structured JSON error when the API is unreachable", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;

		const res = await get("/openapi.json");
		expect(res.status).toBe(502);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = await res.json();
		expect(body.code).toBe("OPENAPI_UNAVAILABLE");
	});

	test("returns a structured JSON error when the API responds with an error status", async () => {
		globalThis.fetch = (async () =>
			new Response("boom", { status: 500 })) as unknown as typeof fetch;

		const res = await get("/openapi.json");
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.code).toBe("OPENAPI_UNAVAILABLE");
	});
});

describe("worker agent-friendly 404", () => {
	test("Accept: text/markdown on a missing path -> 404 Markdown with links back into the site", async () => {
		const res = await get("/esto-no-existe/", {
			Accept: "text/markdown",
		});
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("text/markdown");
		const body = await res.text();
		expect(body.length).toBeGreaterThanOrEqual(20);
		expect(body).toContain("/llms.txt");
		expect(body).toContain("/sitemap.xml");
		expect(body).toContain("/openapi.json");
	});

	test("a normal browser request for a missing path still gets the HTML 404", async () => {
		const res = await get("/esto-no-existe/", {
			Accept: "text/html,application/xhtml+xml",
		});
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("text/html");
	});

	test("Accept: text/markdown on an existing page is unaffected (falls through normally)", async () => {
		const res = await get("/", { Accept: "text/markdown" });
		// Homepage markdown comes from llms.txt via ASSETS — our stub 404s
		// unknown ASSETS paths, so this exercises the "no md, fall through"
		// path rather than a 404: it must NOT be our agent-404 (no code:
		// OPENAPI_UNAVAILABLE-style JSON, no markdownNotFound body).
		const body = await res.text();
		expect(body).not.toContain("no corresponde a ninguna página");
	});
});
