// wrangler.jsonc's `assets.run_worker_first` config (PR #209 review, follow-up).
//
// Not something wrangler itself validates for us, and it's easy to silently
// break: a `true` here works but burns the Workers Free plan's 100k
// req/day budget on every static asset; a path list that's too narrow
// silently drops /openapi.json or the Markdown-404 feature back to plain
// ASSETS routing (exactly what happened once already — see the comment in
// wrangler.jsonc). This locks down the invariants a config change must keep.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/** Strips `//` line comments from JSONC. None of this file's actual JSON
 *  values contain "//", so a naive strip is safe here (not a general JSONC
 *  parser). */
function parseJsonc(text: string): unknown {
	const stripped = text.replace(/\/\/.*$/gm, "");
	return JSON.parse(stripped);
}

interface WranglerConfig {
	assets?: {
		run_worker_first?: boolean | string[];
		not_found_handling?: string;
		directory?: string;
	};
}

async function loadConfig(): Promise<WranglerConfig> {
	const text = await Bun.file(
		join(import.meta.dir, "../../wrangler.jsonc"),
	).text();
	return parseJsonc(text) as WranglerConfig;
}

describe("wrangler.jsonc assets.run_worker_first", () => {
	test("is an array (not `true`) — Workers Free plan can't afford every static asset through the Worker", async () => {
		const config = await loadConfig();
		expect(Array.isArray(config.assets?.run_worker_first)).toBe(true);
	});

	test("runs the Worker first for everything by default (`/*`)", async () => {
		const config = await loadConfig();
		const patterns = config.assets?.run_worker_first as string[];
		expect(patterns).toContain("/*");
	});

	test("excludes the known static-asset directories and extensions from the Worker", async () => {
		const config = await loadConfig();
		const patterns = config.assets?.run_worker_first as string[];
		for (const excluded of [
			"!/_astro/*",
			"!/fonts/*",
			"!/.well-known/*",
			"!/*.png",
			"!/*.css",
			"!/*.js",
			"!/*.woff2",
			"!/*.xml",
			"!/*.txt",
		]) {
			expect(patterns).toContain(excluded);
		}
	});

	test("does NOT blanket-exclude .json — that would also swallow /openapi.json", async () => {
		const config = await loadConfig();
		const patterns = config.assets?.run_worker_first as string[];
		expect(patterns).not.toContain("!/*.json");
		expect(patterns).not.toContain("!*.json");
		// The one static .json file that does need to skip the Worker
		// (.well-known/mcp/server-card.json) is covered by the /.well-known/*
		// directory exclusion instead, not a blanket extension match.
		expect(patterns).not.toContain("!/openapi.json");
	});

	test("does not exclude the paths the Worker must still handle specially", async () => {
		const config = await loadConfig();
		const patterns = config.assets?.run_worker_first as string[];
		const mustNotExclude = [
			"!/",
			"!/leyes/*",
			"!/cambios/reforma/*",
			"!/openapi.json",
		];
		for (const bad of mustNotExclude) {
			expect(patterns).not.toContain(bad);
		}
	});

	test("still configures the branded 404 page (not_found_handling)", async () => {
		const config = await loadConfig();
		expect(config.assets?.not_found_handling).toBe("404-page");
	});
});
