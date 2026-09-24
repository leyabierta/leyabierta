import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chunk, INDEXNOW_KEY, keysToUrls } from "../indexnow.ts";

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
