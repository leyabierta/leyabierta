import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REDIRECTS_PATH = fileURLToPath(
	new URL("../../public/_redirects", import.meta.url),
);
const REDIRECTS = readFileSync(REDIRECTS_PATH, "utf-8");

interface Rule {
	from: string;
	to: string;
	status: number;
}

function parseRedirects(text: string): Rule[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.map((line) => {
			const parts = line.split(/\s+/);
			return {
				from: parts[0]!,
				to: parts[1]!,
				status: Number(parts[2] ?? 301),
			};
		});
}

const rules = parseRedirects(REDIRECTS);

describe("/_redirects: /laws/ → /leyes/ migration", () => {
	test("splat rule maps /laws/* to /leyes/:splat/ in one hop", () => {
		const rule = rules.find((r) => r.from === "/laws/*");
		expect(rule).toBeDefined();
		expect(rule?.to).toBe("/leyes/:splat/");
		expect(rule?.status).toBe(301);
	});

	test("no legacy /laws/:id rule remains (would conflict with splat)", () => {
		const legacy = rules.find((r) => r.from === "/laws/:id");
		expect(legacy).toBeUndefined();
	});

	test("destination ends with trailing slash to avoid 2-hop chain", () => {
		// trailingSlash: "always" in astro.config means /leyes/X would 301 to /leyes/X/
		// The splat MUST land on the canonical /-terminated form directly.
		const rule = rules.find((r) => r.from === "/laws/*");
		expect(rule?.to.endsWith("/")).toBe(true);
	});
});

describe("/_redirects: bare-path → trailing-slash redirects exist", () => {
	const requiredBareToSlash = [
		["/pregunta", "/pregunta/"],
		["/cambios", "/cambios/"],
		["/alertas", "/alertas/"],
		["/leyes", "/leyes/"],
	];

	test.each(
		requiredBareToSlash,
	)("%s → %s exists", (from: string, to: string) => {
		const rule = rules.find((r) => r.from === from);
		expect(rule).toBeDefined();
		expect(rule?.to).toBe(to);
		expect(rule?.status).toBe(301);
	});
});

describe("/_redirects: structural sanity", () => {
	test("all redirect lines parse to valid rules", () => {
		for (const r of rules) {
			expect(r.from.startsWith("/")).toBe(true);
			expect(r.to.startsWith("/")).toBe(true);
			expect([301, 302, 200]).toContain(r.status);
		}
	});

	test("no rule redirects to itself (would create infinite loop)", () => {
		for (const r of rules) {
			expect(r.from).not.toBe(r.to);
		}
	});
});
