/**
 * Unit tests for the vector-index-singleton circuit breaker (Issue #57).
 *
 * Uses dependency injection (the `loader` parameter) to simulate
 * persistent ensureVectorIndex failures without touching the filesystem.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
	_resetSharedVectorIndexForTests,
	getSharedVectorIndex,
} from "../services/rag/vector-index-singleton.ts";

// Minimal stub DB — the loader never actually queries it in these tests.
const stubDb = new Database(":memory:");

afterEach(() => {
	_resetSharedVectorIndexForTests();
});

describe("vector index singleton — circuit breaker", () => {
	it("returns the index on first successful load", async () => {
		const fakeIndex = { meta: [], vectors: {} as never, dims: 4096 };
		const loader = async () => fakeIndex;

		const result = await getSharedVectorIndex(
			stubDb,
			"qwen3-nan",
			"./data",
			loader,
		);
		expect(result).toBe(fakeIndex);
	});

	it("caches the index after a successful load (loader called once)", async () => {
		let calls = 0;
		const fakeIndex = { meta: [], vectors: {} as never, dims: 4096 };
		const loader = async () => {
			calls++;
			return fakeIndex;
		};

		await getSharedVectorIndex(stubDb, "qwen3-nan", "./data", loader);
		await getSharedVectorIndex(stubDb, "qwen3-nan", "./data", loader);
		await getSharedVectorIndex(stubDb, "qwen3-nan", "./data", loader);

		expect(calls).toBe(1);
	});

	it("retries on each call while below MAX_FAILURES", async () => {
		let calls = 0;
		const loader = async () => {
			calls++;
			throw new Error("file not found");
		};

		// First two failures — circuit still closed, each retry goes through.
		for (let i = 0; i < 2; i++) {
			await expect(
				getSharedVectorIndex(stubDb, "qwen3-nan", "./data", loader),
			).rejects.toThrow("file not found");
		}

		expect(calls).toBe(2);
	});

	it("opens the circuit after MAX_FAILURES and returns null without calling the loader", async () => {
		let calls = 0;
		const loader = async () => {
			calls++;
			throw new Error("disk error");
		};

		// Exhaust MAX_FAILURES (3).
		for (let i = 0; i < 3; i++) {
			await expect(
				getSharedVectorIndex(stubDb, "qwen3-nan", "./data", loader),
			).rejects.toThrow();
		}

		const callsAfterOpen = calls;

		// Circuit is now open — subsequent calls return null without hitting the loader.
		const result = await getSharedVectorIndex(
			stubDb,
			"qwen3-nan",
			"./data",
			loader,
		);
		expect(result).toBeNull();
		expect(calls).toBe(callsAfterOpen); // loader not called again
	});

	it("resets failure count and closes the circuit on success", async () => {
		let shouldFail = true;
		const fakeIndex = { meta: [], vectors: {} as never, dims: 4096 };
		const loader = async () => {
			if (shouldFail) throw new Error("transient error");
			return fakeIndex;
		};

		// Two failures — below the MAX_FAILURES threshold.
		for (let i = 0; i < 2; i++) {
			await expect(
				getSharedVectorIndex(stubDb, "qwen3-nan", "./data", loader),
			).rejects.toThrow();
		}

		// Recover on the third attempt.
		shouldFail = false;
		const result = await getSharedVectorIndex(
			stubDb,
			"qwen3-nan",
			"./data",
			loader,
		);
		expect(result).toBe(fakeIndex);

		// After success the index is cached — loader should not be called again.
		const result2 = await getSharedVectorIndex(
			stubDb,
			"qwen3-nan",
			"./data",
			loader,
		);
		expect(result2).toBe(fakeIndex);
	});
});
