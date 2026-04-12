/**
 * Integration tests for the build manifest flow.
 *
 * Verifies that [id].astro's manifest-reading logic works correctly
 * by testing the loadManifest → data lookup → fallback chain.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let loadManifest: typeof import("../lib/manifest.ts").loadManifest;

const TEST_DIR = join(tmpdir(), `manifest-integ-${process.pid}`);
const MANIFEST_PATH = join(TEST_DIR, "manifest.json");

const FULL_MANIFEST = {
	citizens: {
		"BOE-A-1978-31229": {
			summary: "La Constitución establece los derechos fundamentales",
			tags: ["derechos", "constitucional"],
		},
		"BOE-A-2024-001": {
			summary: "Nueva ley fiscal para autónomos",
			tags: ["autonomo", "fiscal"],
		},
	},
	omnibus: {
		"BOE-A-2024-002": [
			{
				topic_label: "Reforma fiscal",
				article_count: 12,
				headline: "Cambios en el IRPF",
				summary: "Se modifica la base imponible",
				is_sneaked: 0,
				block_ids: ["art1", "art2", "art3"],
			},
			{
				topic_label: "Vivienda",
				article_count: 3,
				headline: "Regulación de alquiler",
				summary: "Se limitan las subidas de alquiler",
				is_sneaked: 1,
				block_ids: ["art15"],
			},
		],
	},
};

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
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

describe("Build manifest integration", () => {
	it("reads citizen data from manifest for a known law", () => {
		writeFileSync(MANIFEST_PATH, JSON.stringify(FULL_MANIFEST));
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;

		const manifest = loadManifest();
		expect(manifest).not.toBeNull();

		const id = "BOE-A-1978-31229";
		const citizenData = manifest!.citizens[id];
		const citizenSummary = citizenData?.summary ?? "";
		const citizenTags = citizenData?.tags ?? [];

		expect(citizenSummary).toBe(
			"La Constitución establece los derechos fundamentales",
		);
		expect(citizenTags).toEqual(["derechos", "constitucional"]);
	});

	it("defaults to empty for a law not in manifest", () => {
		writeFileSync(MANIFEST_PATH, JSON.stringify(FULL_MANIFEST));
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;

		const manifest = loadManifest();
		const id = "BOE-A-9999-UNKNOWN";
		const citizenData = manifest!.citizens[id];
		const citizenSummary = citizenData?.summary ?? "";
		const citizenTags = citizenData?.tags ?? [];

		expect(citizenSummary).toBe("");
		expect(citizenTags).toEqual([]);
	});

	it("reads omnibus data from manifest for laws with topics", () => {
		writeFileSync(MANIFEST_PATH, JSON.stringify(FULL_MANIFEST));
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;

		const manifest = loadManifest();
		const id = "BOE-A-2024-002";
		const omnibusTopics = manifest!.omnibus[id] ?? [];

		expect(omnibusTopics).toHaveLength(2);
		expect(omnibusTopics[0]!.topic_label).toBe("Reforma fiscal");
		expect(omnibusTopics[1]!.topic_label).toBe("Vivienda");
		expect(omnibusTopics[1]!.is_sneaked).toBe(1);
	});

	it("returns empty omnibus array for law without topics", () => {
		writeFileSync(MANIFEST_PATH, JSON.stringify(FULL_MANIFEST));
		process.env.BUILD_MANIFEST_PATH = MANIFEST_PATH;

		const manifest = loadManifest();
		const omnibusTopics = manifest!.omnibus["BOE-A-1978-31229"] ?? [];
		expect(omnibusTopics).toEqual([]);
	});

	it("falls back to null when no manifest is present", () => {
		delete process.env.BUILD_MANIFEST_PATH;
		const manifest = loadManifest();
		expect(manifest).toBeNull();
	});
});
