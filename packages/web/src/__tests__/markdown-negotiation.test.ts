import { describe, expect, test } from "bun:test";
import {
	lawIdFromPath,
	legacyTextTabRedirect,
	prefersMarkdown,
} from "../worker/index.ts";

describe("prefersMarkdown", () => {
	const req = (method: string, accept?: string) =>
		new Request("https://leyabierta.es/", {
			method,
			headers: accept ? { accept } : {},
		});

	test("opts in when Accept lists text/markdown", () => {
		expect(prefersMarkdown(req("GET", "text/markdown"))).toBe(true);
		expect(prefersMarkdown(req("GET", "text/markdown, text/plain;q=0.9"))).toBe(
			true,
		);
	});

	test("browsers (text/html) are not opted in", () => {
		expect(
			prefersMarkdown(
				req("GET", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*"),
			),
		).toBe(false);
		expect(prefersMarkdown(req("GET", "*/*"))).toBe(false);
		expect(prefersMarkdown(req("GET"))).toBe(false);
	});

	test("only GET is eligible", () => {
		expect(prefersMarkdown(req("POST", "text/markdown"))).toBe(false);
		expect(prefersMarkdown(req("HEAD", "text/markdown"))).toBe(false);
	});
});

describe("lawIdFromPath", () => {
	test("extracts the norm id from a law page path", () => {
		expect(lawIdFromPath("/leyes/BOE-A-2023-12203/")).toBe("BOE-A-2023-12203");
		expect(lawIdFromPath("/leyes/BOE-A-2023-12203")).toBe("BOE-A-2023-12203");
	});

	test("also serves the full-text page (/leyes/<id>/texto/)", () => {
		expect(lawIdFromPath("/leyes/BOE-A-2023-12203/texto/")).toBe(
			"BOE-A-2023-12203",
		);
		expect(lawIdFromPath("/leyes/BOE-A-2023-12203/texto")).toBe(
			"BOE-A-2023-12203",
		);
	});

	test("returns null for non-law paths", () => {
		expect(lawIdFromPath("/")).toBeNull();
		expect(lawIdFromPath("/leyes/")).toBeNull();
		expect(lawIdFromPath("/leyes/BOE-A-2023-12203/reformas/")).toBeNull();
		expect(lawIdFromPath("/cambios/reforma/")).toBeNull();
	});
});

describe("legacyTextTabRedirect", () => {
	const u = (s: string) => new URL(s, "https://leyabierta.es");

	test("sends the old ?tab=texto law URL to the text on the BOE", () => {
		expect(legacyTextTabRedirect(u("/leyes/BOE-A-1978-31229/?tab=texto"))).toBe(
			"https://www.boe.es/buscar/act.php?id=BOE-A-1978-31229",
		);
		expect(legacyTextTabRedirect(u("/leyes/DOGC-f-2019-90497?tab=texto"))).toBe(
			"https://www.boe.es/buscar/act.php?id=DOGC-f-2019-90497",
		);
	});

	test("leaves every other URL alone", () => {
		expect(legacyTextTabRedirect(u("/leyes/BOE-A-1978-31229/"))).toBeNull();
		expect(
			legacyTextTabRedirect(u("/leyes/BOE-A-1978-31229/?tab=reformas")),
		).toBeNull();
		expect(
			legacyTextTabRedirect(u("/leyes/BOE-A-1978-31229/texto/?tab=texto")),
		).toBeNull();
		expect(legacyTextTabRedirect(u("/cambios/?tab=texto"))).toBeNull();
	});

	test("malformed percent-encoding is ignored instead of throwing", () => {
		expect(legacyTextTabRedirect(u("/leyes/%E0%A4%A/?tab=texto"))).toBeNull();
		expect(lawIdFromPath("/leyes/%E0%A4%A/")).toBeNull();
	});
});
