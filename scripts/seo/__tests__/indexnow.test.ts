import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	allKeys,
	chunk,
	filterToSitemap,
	INDEXNOW_KEY,
	keysToUrls,
	sitemapLocs,
} from "../indexnow.ts";

describe("indexnow", () => {
	test("maps law ids and reform keys to their canonical URLs", () => {
		const urls = keysToUrls(
			{ laws: ["BOE-A-1978-31229"], reforms: ["BOE-A-1995-25444|2015-03-31"] },
			"https://x",
		);
		expect(urls).toEqual([
			"https://x/leyes/BOE-A-1978-31229/",
			"https://x/cambios/reforma/?id=BOE-A-1995-25444&date=2015-03-31",
		]);
	});

	test("only URLs the sitemaps advertise are sent (XML entities decoded)", () => {
		const xml = `<urlset>
  <url><loc>https://x/leyes/A/</loc></url>
  <url><loc>https://x/cambios/reforma/?id=A&amp;date=2015-03-31</loc></url>
</urlset>`;
		const advertised = new Set(sitemapLocs(xml));
		expect(
			filterToSitemap(
				[
					"https://x/leyes/A/",
					"https://x/leyes/NOINDEX/",
					"https://x/cambios/reforma/?id=A&date=2015-03-31",
				],
				advertised,
			),
		).toEqual([
			"https://x/leyes/A/",
			"https://x/cambios/reforma/?id=A&date=2015-03-31",
		]);
	});

	test("--all sends law pages only unless reforms are asked for; absent keys never", () => {
		const s = {
			version: 1,
			complete: true,
			generated: "2026-09-25",
			laws: {
				A: ["h", "2026-09-23"],
				GONE: ["h", "2026-09-23", 1],
			},
			reforms: { "A|2015-03-31": ["h", "2026-09-23"] },
		} as Parameters<typeof allKeys>[0];
		expect(allKeys(s)).toEqual({ laws: ["A"], reforms: [] });
		expect(allKeys(s, true)).toEqual({
			laws: ["A"],
			reforms: ["A|2015-03-31"],
		});
	});

	test("splits into protocol-sized batches", () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	test("the key file is published with the key as its content", () => {
		const file = resolve(
			import.meta.dir,
			"../../../packages/web/public",
			`${INDEXNOW_KEY}.txt`,
		);
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, "utf-8").trim()).toBe(INDEXNOW_KEY);
	});
});
