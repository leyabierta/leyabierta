/**
 * Tests for the build manifest loader.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We need to reset the cached manifest between tests.
// The module caches _manifest as a module-level variable, so we
// re-import fresh each test by clearing the module from the require cache.
let loadManifest: typeof import("../lib/manifest.ts").loadManifest;

const TEST_DIR = join(tmpdir(), `manifest-test-${process.pid}`);
const MANIFEST_PATH = join(TEST_DIR, "manifest.json");

const VALID_MANIFEST = {
	citizens: {
		"BOE-A-2024-001": {
			summary: "This law affects taxes",
			tags: ["autonomo", "empresario"],
		},
	},
	omnibus: {
		"BOE-A-2024-002": [
			{
				topic_label: "Fiscal reform",
				article_count: 5,
				headline: "Test headline",
				summary: "Test summary",
				is_sneaked: 0,
				block_ids: ["art1", "art2"],
			},
		],
	},
};

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	// Clear module cache to reset the _manifest singleton
	delete require.cache[require.resolve("../lib/manifest.ts")];
	const mod = require("../lib/manifest.ts");
	loadManifest = mod.loadManifest;
});

afterEach(() => {
	delete process.env.BUILD_MANIFEST_PATH;
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true });
	}
});

describe("loadManifest()", () => {
	it("returns null when BUILD_MANIFEST_PATH is not set", () => {
		delete process.env.BUILD_MANIFEST_PATH;
		expect(loadManifest()).toBeNull();
	});

	it("returns parsed manifest when file exists with valid JSON", () => {
		writeFileSync(MANIFEST_PATH, JSON.stringify(VALID_MANIFEST));
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;

		const result = loadManifest();
		expect(result).not.toBeNull();
		expect(result!.citizens["BOE-A-2024-001"].summary).toBe(
			"This law affects taxes",
		);
		expect(result!.citizens["BOE-A-2024-001"].tags).toEqual([
			"autonomo",
			"empresario",
		]);
		expect(result!.omnibus["BOE-A-2024-002"]).toHaveLength(1);
	});

	it("returns null when file doesn't exist", () => {
		process.env.BUILD_MANIFEST_PATH = join(TEST_DIR, "nonexistent.json");
		expect(loadManifest()).toBeNull();
	});

	it("returns null when file contains malformed JSON", () => {
		writeFileSync(MANIFEST_PATH, "{ broken json");
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;
		expect(loadManifest()).toBeNull();
	});

	it("caches result on second call", () => {
		writeFileSync(MANIFEST_PATH, JSON.stringify(VALID_MANIFEST));
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;

		const first = loadManifest();
		// Modify the file — should still return cached result
		writeFileSync(MANIFEST_PATH, JSON.stringify({ citizens: {}, omnibus: {} }));
		const second = loadManifest();

		expect(first).toBe(second); // same reference (cached)
		expect(second!.citizens["BOE-A-2024-001"].summary).toBe(
			"This law affects taxes",
		);
	});

	it("handles manifest with empty citizens/omnibus objects", () => {
		writeFileSync(MANIFEST_PATH, JSON.stringify({ citizens: {}, omnibus: {} }));
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;

		const result = loadManifest();
		expect(result).not.toBeNull();
		expect(result!.citizens).toEqual({});
		expect(result!.omnibus).toEqual({});
	});

	it("returns null when manifest has invalid shape (missing citizens)", () => {
		writeFileSync(MANIFEST_PATH, JSON.stringify({ omnibus: {} }));
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;
		expect(loadManifest()).toBeNull();
	});

	it("returns null when manifest has invalid shape (missing omnibus)", () => {
		writeFileSync(MANIFEST_PATH, JSON.stringify({ citizens: {} }));
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;
		expect(loadManifest()).toBeNull();
	});

	it("returns null when manifest is a JSON array instead of object", () => {
		writeFileSync(MANIFEST_PATH, JSON.stringify([1, 2, 3]));
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;
		expect(loadManifest()).toBeNull();
	});
});
