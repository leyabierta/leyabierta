/**
 * Unit tests for StateStore.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/utils/state-store.ts";

let tempDir: string;
let filePath: string;

beforeEach(() => {
	tempDir = join(
		tmpdir(),
		`state-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDir, { recursive: true });
	filePath = join(tempDir, "state.json");
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("StateStore", () => {
	describe("isProcessed", () => {
		test("returns false for unknown norms", () => {
			const store = new StateStore(filePath, "es");
			expect(store.isProcessed("BOE-A-1234")).toBe(false);
		});

		test("returns true for done norms", () => {
			const store = new StateStore(filePath, "es");
			store.markDone("BOE-A-1234", 3, "abc123");
			expect(store.isProcessed("BOE-A-1234")).toBe(true);
		});

		test("returns true for skipped norms", () => {
			const store = new StateStore(filePath, "es");
			store.markSkipped("BOE-A-5678");
			expect(store.isProcessed("BOE-A-5678")).toBe(true);
		});

		test("returns false for error norms (errors should be retried)", () => {
			const store = new StateStore(filePath, "es");
			store.markError("BOE-A-9999", "Network timeout");
			expect(store.isProcessed("BOE-A-9999")).toBe(false);
		});
	});

	describe("markDone", () => {
		test("sets status and commits count", () => {
			const store = new StateStore(filePath, "es");
			store.markDone("BOE-A-1234", 5, "sha256abc");
			expect(store.isProcessed("BOE-A-1234")).toBe(true);
			expect(store.stats.done).toBe(1);
		});
	});

	describe("markSkipped", () => {
		test("sets status to skipped", () => {
			const store = new StateStore(filePath, "es");
			store.markSkipped("BOE-A-1234");
			expect(store.isProcessed("BOE-A-1234")).toBe(true);
			expect(store.stats.skipped).toBe(1);
		});
	});

	describe("markError", () => {
		test("sets status and error message", () => {
			const store = new StateStore(filePath, "es");
			store.markError("BOE-A-1234", "Parse failed");
			expect(store.isProcessed("BOE-A-1234")).toBe(false);
			expect(store.stats.errors).toBe(1);
		});
	});

	describe("stats", () => {
		test("returns correct counts", () => {
			const store = new StateStore(filePath, "es");
			store.markDone("A", 1);
			store.markDone("B", 2);
			store.markSkipped("C");
			store.markError("D", "fail");
			store.markError("E", "fail");

			const stats = store.stats;
			expect(stats.done).toBe(2);
			expect(stats.skipped).toBe(1);
			expect(stats.errors).toBe(2);
			expect(stats.total).toBe(5);
		});

		test("returns zeros for empty store", () => {
			const store = new StateStore(filePath, "es");
			const stats = store.stats;
			expect(stats.done).toBe(0);
			expect(stats.errors).toBe(0);
			expect(stats.skipped).toBe(0);
			expect(stats.total).toBe(0);
		});
	});

	describe("save and load", () => {
		test("persists to disk and loads correctly", async () => {
			const store1 = new StateStore(filePath, "es");
			store1.markDone("BOE-A-1234", 3, "sha1");
			store1.markSkipped("BOE-A-5678");
			store1.markError("BOE-A-9999", "oops");
			await store1.save();

			const store2 = new StateStore(filePath, "es");
			await store2.load();

			expect(store2.isProcessed("BOE-A-1234")).toBe(true);
			expect(store2.isProcessed("BOE-A-5678")).toBe(true);
			expect(store2.isProcessed("BOE-A-9999")).toBe(false);
			expect(store2.stats.done).toBe(1);
			expect(store2.stats.skipped).toBe(1);
			expect(store2.stats.errors).toBe(1);
		});

		test("save is a no-op when nothing changed", async () => {
			const store = new StateStore(filePath, "es");
			await store.save();
			// File should not exist since nothing was marked
			const file = Bun.file(filePath);
			expect(await file.exists()).toBe(false);
		});
	});

	describe("lastBoeUpdate watermark", () => {
		test("returns undefined when no watermark set", () => {
			const store = new StateStore(filePath, "es");
			expect(store.lastBoeUpdate).toBeUndefined();
		});

		test("stores and retrieves watermark", () => {
			const store = new StateStore(filePath, "es");
			store.setLastBoeUpdate("20260408T080417Z");
			expect(store.lastBoeUpdate).toBe("20260408T080417Z");
		});

		test("persists watermark across save/load", async () => {
			const store1 = new StateStore(filePath, "es");
			store1.setLastBoeUpdate("20260408T080417Z");
			await store1.save();

			const store2 = new StateStore(filePath, "es");
			await store2.load();
			expect(store2.lastBoeUpdate).toBe("20260408T080417Z");
		});
	});

	describe("fechaActualizacion on markDone", () => {
		test("stores fechaActualizacion when provided", async () => {
			const store = new StateStore(filePath, "es");
			store.markDone("BOE-A-1234", 3, "sha1", "20260408T080417Z");
			await store.save();

			const store2 = new StateStore(filePath, "es");
			await store2.load();
			const raw = await Bun.file(filePath).json();
			expect(raw.norms["BOE-A-1234"].fechaActualizacion).toBe(
				"20260408T080417Z",
			);
		});

		test("fechaActualizacion is optional (backward compat)", () => {
			const store = new StateStore(filePath, "es");
			store.markDone("BOE-A-1234", 3);
			expect(store.isProcessed("BOE-A-1234")).toBe(true);
		});
	});

	describe("getErrorNormIds", () => {
		test("returns IDs of norms in error state", () => {
			const store = new StateStore(filePath, "es");
			store.markDone("A", 1);
			store.markError("B", "network timeout");
			store.markSkipped("C");
			store.markError("D", "parse failed");
			expect(store.getErrorNormIds().sort()).toEqual(["B", "D"]);
		});

		test("returns empty array when no errors", () => {
			const store = new StateStore(filePath, "es");
			store.markDone("A", 1);
			expect(store.getErrorNormIds()).toEqual([]);
		});
	});

	describe("loading corrupt/missing file", () => {
		test("starts fresh when file does not exist", async () => {
			const store = new StateStore(join(tempDir, "nonexistent.json"), "es");
			await store.load();
			expect(store.stats.total).toBe(0);
		});

		test("starts fresh when file contains invalid JSON", async () => {
			await Bun.write(filePath, "not valid json {{{");
			const store = new StateStore(filePath, "es");
			await store.load();
			expect(store.stats.total).toBe(0);
		});
	});
});
