import { describe, expect, test } from "bun:test";
import { lawIdFromPath, prefersMarkdown } from "../worker/index.ts";

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

	test("returns null for non-law paths", () => {
		expect(lawIdFromPath("/")).toBeNull();
		expect(lawIdFromPath("/leyes/")).toBeNull();
		expect(lawIdFromPath("/leyes/BOE-A-2023-12203/reformas/")).toBeNull();
		expect(lawIdFromPath("/cambios/reforma/")).toBeNull();
	});
});
