/**
 * Regression test for the /laws/ → /leyes/ migration.
 *
 * The migration accidentally left the regex literals in analytics-init.ts
 * pointing at the old path, breaking scroll-depth tracking and law_id
 * extraction silently. This test parses the source and asserts no /laws/
 * regex remains.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE_PATH = fileURLToPath(
	new URL("../lib/analytics-init.ts", import.meta.url),
);
const SOURCE = readFileSync(SOURCE_PATH, "utf-8");

describe("analytics-init.ts: post-migration path regexes", () => {
	test("no regex literal references the legacy /laws/ path", () => {
		// Match \/laws\/ inside any regex /.../ literal in the source.
		const legacy = SOURCE.match(/\/\\\/laws\\\/[^/]+/g);
		expect(legacy).toBeNull();
	});

	test("scroll-depth detector matches /leyes/<id>/ paths", () => {
		const re = /^\/leyes\/[^/]+\/?$/;
		expect(re.test("/leyes/BOE-A-1978-31229/")).toBe(true);
		expect(re.test("/leyes/BOE-A-1978-31229")).toBe(true);
		expect(re.test("/laws/BOE-A-1978-31229/")).toBe(false);
		expect(re.test("/cambios/")).toBe(false);
	});

	test("law_id extractor returns the id from /leyes/<id>/...", () => {
		const re = /^\/leyes\/([^/]+)\//;
		expect("/leyes/BOE-A-1978-31229/".match(re)?.[1]).toBe("BOE-A-1978-31229");
		expect("/leyes/BOE-A-1995-25444/?from=foo".match(re)?.[1]).toBe(
			"BOE-A-1995-25444",
		);
		expect("/laws/BOE-A-1978-31229/".match(re)).toBeNull();
	});
});
