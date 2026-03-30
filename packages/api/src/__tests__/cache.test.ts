/**
 * Unit tests for LruCache.
 */

import { describe, expect, test } from "bun:test";
import { LruCache } from "../services/cache.ts";

describe("LruCache", () => {
	test("get returns undefined for missing key", () => {
		const cache = new LruCache<string>(10);
		expect(cache.get("missing")).toBeUndefined();
	});

	test("set and get works", () => {
		const cache = new LruCache<number>(10);
		cache.set("a", 1);
		cache.set("b", 2);
		expect(cache.get("a")).toBe(1);
		expect(cache.get("b")).toBe(2);
	});

	test("evicts oldest when capacity reached", () => {
		const cache = new LruCache<string>(3);
		cache.set("a", "1");
		cache.set("b", "2");
		cache.set("c", "3");
		// Adding a 4th should evict "a"
		cache.set("d", "4");

		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe("2");
		expect(cache.get("c")).toBe("3");
		expect(cache.get("d")).toBe("4");
		expect(cache.size).toBe(3);
	});

	test("accessing a key refreshes its position (LRU behavior)", () => {
		const cache = new LruCache<string>(3);
		cache.set("a", "1");
		cache.set("b", "2");
		cache.set("c", "3");

		// Access "a" to refresh it — now "b" is the oldest
		cache.get("a");

		// Adding "d" should evict "b" (oldest unused), not "a"
		cache.set("d", "4");

		expect(cache.get("a")).toBe("1"); // still present, was refreshed
		expect(cache.get("b")).toBeUndefined(); // evicted
		expect(cache.get("c")).toBe("3");
		expect(cache.get("d")).toBe("4");
	});

	test("works with capacity of 1", () => {
		const cache = new LruCache<number>(1);
		cache.set("a", 1);
		expect(cache.get("a")).toBe(1);
		expect(cache.size).toBe(1);

		cache.set("b", 2);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);
		expect(cache.size).toBe(1);
	});

	test("updating an existing key does not increase size", () => {
		const cache = new LruCache<string>(3);
		cache.set("a", "v1");
		cache.set("b", "v2");
		cache.set("a", "v3");
		expect(cache.size).toBe(2);
		expect(cache.get("a")).toBe("v3");
	});
});
