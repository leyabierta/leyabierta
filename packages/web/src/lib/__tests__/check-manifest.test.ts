import { describe, expect, test } from "bun:test";
import { validateManifest } from "../../../scripts/check-manifest.ts";

describe("validateManifest", () => {
	const main = JSON.stringify({
		citizens: { "BOE-A-1": { summary: "x", tags: [], materias: [] } },
		omnibus: {},
		reforms: {},
	});
	const articles = JSON.stringify({ "BOE-A-1": [["Artículo 1", "x", "a1"]] });

	test("accepts a well-formed manifest above the minimum size", () => {
		expect(validateManifest(main, "main", 10).ok).toBe(true);
		expect(validateManifest(articles, "articles", 10).ok).toBe(true);
	});

	test("rejects a truncated download (below the minimum size)", () => {
		const r = validateManifest(main, "main", 1_000_000);
		expect(r.ok).toBe(false);
	});

	test("rejects invalid JSON (cut mid-transfer)", () => {
		expect(validateManifest(articles.slice(0, -5), "articles", 1).ok).toBe(
			false,
		);
	});

	test("rejects the wrong shape or empty content", () => {
		expect(validateManifest("[]", "articles", 1).ok).toBe(false);
		expect(validateManifest("{}", "articles", 1).ok).toBe(false);
		expect(validateManifest('{"citizens":{}}', "main", 1).ok).toBe(false);
		expect(validateManifest('{"citizens":{},"omnibus":{}}', "main", 1).ok).toBe(
			false,
		);
		expect(validateManifest("<html>error</html>", "main", 1).ok).toBe(false);
	});
});
