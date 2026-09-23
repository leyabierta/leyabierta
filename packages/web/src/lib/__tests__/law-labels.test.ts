import { describe, expect, test } from "bun:test";
import { boeUrl } from "../law-labels.ts";

describe("boeUrl", () => {
	test("links to the consolidated text on the BOE", () => {
		expect(boeUrl("BOE-A-1978-31229")).toBe(
			"https://www.boe.es/buscar/act.php?id=BOE-A-1978-31229",
		);
		expect(boeUrl("DOGC-f-2019-90497")).toBe(
			"https://www.boe.es/buscar/act.php?id=DOGC-f-2019-90497",
		);
	});

	test("deep-links an article by its BOE block id", () => {
		expect(boeUrl("BOE-A-1889-4763", "art1019")).toBe(
			"https://www.boe.es/buscar/act.php?id=BOE-A-1889-4763#art1019",
		);
		expect(boeUrl("BOE-A-2015-11430", "dadecimosexta")).toBe(
			"https://www.boe.es/buscar/act.php?id=BOE-A-2015-11430#dadecimosexta",
		);
	});

	test("no block id → the law without an anchor", () => {
		expect(boeUrl("BOE-A-2015-11430", null)).toBe(
			"https://www.boe.es/buscar/act.php?id=BOE-A-2015-11430",
		);
		expect(boeUrl("BOE-A-2015-11430", "")).toBe(
			"https://www.boe.es/buscar/act.php?id=BOE-A-2015-11430",
		);
	});
});
