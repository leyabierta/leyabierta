/**
 * Build-time manifest loader.
 *
 * During CI builds, a JSON manifest is fetched once from the API before
 * `astro build` starts. This file reads and caches that manifest so each
 * law page can look up citizen_summary, citizen_tags, and omnibus topics
 * without making per-page API calls (12K calls → 0).
 *
 * This file is intentionally separate from api.ts to avoid introducing
 * a node:fs import into a module that could be bundled for client-side code.
 */

import { readFileSync } from "node:fs";
import type { OmnibusTopic } from "./api.ts";

export interface BuildManifest {
	citizens: Record<string, { summary: string; tags: string[] }>;
	omnibus: Record<string, OmnibusTopic[]>;
}

let _manifest: BuildManifest | null | undefined;

export function loadManifest(): BuildManifest | null {
	if (_manifest !== undefined) return _manifest;
	const path = process.env.BUILD_MANIFEST_PATH;
	if (!path) {
		_manifest = null;
		return null;
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);

		// Shape validation: ensure manifest has expected structure
		if (
			!parsed ||
			typeof parsed.citizens !== "object" ||
			typeof parsed.omnibus !== "object"
		) {
			console.warn(
				"[manifest] Invalid shape: missing 'citizens' or 'omnibus' key",
			);
			_manifest = null;
			return null;
		}

		_manifest = parsed as BuildManifest;
		const citizenCount = Object.keys(_manifest.citizens).length;
		const omnibusCount = Object.keys(_manifest.omnibus).length;
		console.log(
			`[manifest] Loaded ${citizenCount} citizens, ${omnibusCount} omnibus entries`,
		);
		return _manifest;
	} catch (err) {
		console.warn(
			`[manifest] Failed to load from ${path}: ${err instanceof Error ? err.message : "unknown error"}`,
		);
		_manifest = null;
		return null;
	}
}
