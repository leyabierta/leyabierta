import { describe, expect, test } from "bun:test";
import { validateManifest } from "../../../scripts/check-manifest.ts";

describe("validateManifest", () => {
	const mainObj = {
		citizens: { "BOE-A-1": { summary: "x", tags: [], materias: [] } },
		omnibus: {},
		reforms: {
			"BOE-A-1": [
				{ date: "2024-01-02", source: "BOE-A-9", headline: "h", summary: "s" },
			],
		},
	};
	const main = JSON.stringify(mainObj);
	const articles = JSON.stringify({ "BOE-A-1": [["Artículo 1", "x", "a1"]] });

	test("accepts a well-formed manifest above the minimum size", () => {
		expect(validateManifest(main, "main", 10).ok).toBe(true);
		expect(validateManifest(articles, "articles", 10).ok).toBe(true);
	});

	test("rejects a truncated download (below the minimum size)", () => {
		expect(validateManifest(main, "main", 1_000_000).ok).toBe(false);
	});

	test("rejects invalid JSON (cut mid-transfer)", () => {
		expect(validateManifest(articles.slice(0, -5), "articles", 1).ok).toBe(
			false,
		);
	});

	test("rejects the wrong shape or empty content", () => {
		expect(validateManifest("[]", "articles", 1).ok).toBe(false);
		expect(validateManifest("{}", "articles", 1).ok).toBe(false);
		expect(validateManifest("<html>error</html>", "main", 1).ok).toBe(false);
	});

	test("main manifest: citizens, omnibus and reforms must be objects; citizens and reforms non-empty", () => {
		const bad = (patch: Record<string, unknown>) =>
			validateManifest(JSON.stringify({ ...mainObj, ...patch }), "main", 1).ok;
		expect(bad({ citizens: {} })).toBe(false);
		expect(bad({ citizens: null })).toBe(false);
		expect(bad({ omnibus: null })).toBe(false);
		expect(bad({ omnibus: [] })).toBe(false);
		expect(bad({ reforms: undefined })).toBe(false);
		expect(bad({ reforms: null })).toBe(false);
		expect(bad({ reforms: {} })).toBe(false);
		// An empty omnibus map is legitimate.
		expect(bad({ omnibus: {} })).toBe(true);
	});
});
