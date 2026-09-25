import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
	defaultCacheControl,
	NO_STORE,
	NOT_FOUND_CACHE_CONTROL,
	SUCCESS_CACHE_CONTROL,
	toStatusCode,
} from "../services/cache-control.ts";

describe("defaultCacheControl", () => {
	test("caches successful responses for an hour at the edge", () => {
		expect(defaultCacheControl("/v1/laws/BOE-A-1978-31229", 200)).toBe(
			SUCCESS_CACHE_CONTROL,
		);
		expect(defaultCacheControl("/v1/laws", undefined)).toBe(
			SUCCESS_CACHE_CONTROL,
		);
	});

	test("404s get a short TTL, not the hour (Ley 8/2026 regression)", () => {
		const header = defaultCacheControl("/v1/laws/BOE-A-2026-17836", 404);
		expect(header).toBe(NOT_FOUND_CACHE_CONTROL);
		expect(header).not.toContain("s-maxage=3600");
	});

	test("rate limits and server errors are never stored", () => {
		expect(defaultCacheControl("/v1/laws", 429)).toBe(NO_STORE);
		expect(defaultCacheControl("/v1/laws", 500)).toBe(NO_STORE);
		expect(defaultCacheControl("/v1/laws", 503)).toBe(NO_STORE);
		expect(defaultCacheControl("/v1/laws", 400)).toBe(NO_STORE);
	});

	test("unknown status names are not cached (fallback is 500, not 200)", () => {
		expect(toStatusCode("Totally Made Up")).toBe(500);
		expect(defaultCacheControl("/v1/laws", "Totally Made Up")).toBe(NO_STORE);
	});

	test("skips health", () => {
		expect(defaultCacheControl("/health", 200)).toBeUndefined();
	});

	test("accepts Elysia status names", () => {
		expect(toStatusCode("Not Found")).toBe(404);
		expect(toStatusCode("Too Many Requests")).toBe(429);
		expect(toStatusCode(undefined)).toBe(200);
		expect(defaultCacheControl("/v1/laws/X", "Not Found")).toBe(
			NOT_FOUND_CACHE_CONTROL,
		);
	});
});

describe("onAfterHandle wiring (same pattern as index.ts)", () => {
	const app = new Elysia()
		.onAfterHandle(({ set, path }) => {
			if (!set.headers["Cache-Control"]) {
				const cacheControl = defaultCacheControl(path, set.status);
				if (cacheControl) set.headers["Cache-Control"] = cacheControl;
			}
		})
		.get("/v1/laws/:id", ({ params, set }) => {
			if (params.id !== "BOE-A-1978-31229") {
				set.status = 404;
				return { error: "Law not found" };
			}
			return { id: params.id };
		});

	test("a route that sets 404 is not cached for an hour", async () => {
		const res = await app.handle(
			new Request("http://localhost/v1/laws/BOE-A-2026-17836"),
		);
		expect(res.status).toBe(404);
		expect(res.headers.get("Cache-Control")).toBe(NOT_FOUND_CACHE_CONTROL);
	});

	test("a found law keeps the hour-long edge cache", async () => {
		const res = await app.handle(
			new Request("http://localhost/v1/laws/BOE-A-1978-31229"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe(SUCCESS_CACHE_CONTROL);
	});
});
