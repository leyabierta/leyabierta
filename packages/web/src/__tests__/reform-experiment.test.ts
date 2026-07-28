import { describe, expect, test } from "bun:test";
import {
	isPathFormReform,
	reformCanonicalPath,
} from "../lib/reform-experiment.ts";
import { parseReformRef } from "../worker/index.ts";

const url = (u: string) => new URL(u, "https://leyabierta.es");

describe("isPathFormReform", () => {
	test("only the experiment year is in the treatment group", () => {
		expect(isPathFormReform("2026-02-20")).toBe(true);
		expect(isPathFormReform("2025-12-31")).toBe(false);
		expect(isPathFormReform("1983-07-01")).toBe(false);
	});

	// "2026" must not match a date that merely contains it.
	test("matches on the year field, not a substring", () => {
		expect(isPathFormReform("1926-02-20")).toBe(false);
	});
});

describe("parseReformRef", () => {
	test("reads the query form", () => {
		expect(
			parseReformRef(
				url("/cambios/reforma/?id=BOE-A-1978-31229&date=2024-02-17"),
			),
		).toEqual({ normId: "BOE-A-1978-31229", date: "2024-02-17" });
	});

	test("reads the path form", () => {
		expect(
			parseReformRef(url("/cambios/reforma/BOE-A-1978-31229/2024-02-17/")),
		).toEqual({ normId: "BOE-A-1978-31229", date: "2024-02-17" });
	});

	test("path form works without the trailing slash", () => {
		expect(
			parseReformRef(url("/cambios/reforma/BOE-A-1978-31229/2024-02-17")),
		).toEqual({ normId: "BOE-A-1978-31229", date: "2024-02-17" });
	});

	test("the bare shell has no reference", () => {
		expect(parseReformRef(url("/cambios/reforma/"))).toBeNull();
	});

	// A non-date second segment is a stray path, not a reform address. Without
	// this the worker would call the API with garbage on every 404-ish URL
	// under the prefix.
	test("rejects a second segment that isn't an ISO date", () => {
		expect(
			parseReformRef(url("/cambios/reforma/BOE-A-1978-31229/foo/")),
		).toBeNull();
		expect(
			parseReformRef(url("/cambios/reforma/BOE-A-1978-31229/2024-2-17/")),
		).toBeNull();
	});

	test("rejects the wrong number of segments", () => {
		expect(
			parseReformRef(url("/cambios/reforma/BOE-A-1978-31229/")),
		).toBeNull();
		expect(
			parseReformRef(url("/cambios/reforma/a/2024-02-17/extra/")),
		).toBeNull();
	});

	test("decodes a percent-encoded id", () => {
		expect(
			parseReformRef(url("/cambios/reforma/BORM-s-2001-90010/2024-02-17/")),
		).toEqual({ normId: "BORM-s-2001-90010", date: "2024-02-17" });
	});

	// Query params win so an existing link keeps resolving exactly as before,
	// whatever the path happens to look like.
	test("query form takes precedence over the path", () => {
		expect(
			parseReformRef(
				url("/cambios/reforma/OTHER-ID/1999-01-01/?id=BOE-A-1&date=2024-02-17"),
			),
		).toEqual({ normId: "BOE-A-1", date: "2024-02-17" });
	});
});

describe("reformCanonicalPath", () => {
	test("experiment reforms canonicalise to the path form", () => {
		expect(reformCanonicalPath("BOE-A-2026-3212", "2026-02-20")).toBe(
			"/cambios/reforma/BOE-A-2026-3212/2026-02-20/",
		);
	});

	test("control reforms keep the query form", () => {
		expect(reformCanonicalPath("BOE-A-1978-31229", "2024-02-17")).toBe(
			"/cambios/reforma/?id=BOE-A-1978-31229&date=2024-02-17",
		);
	});

	// The whole point of one canonical per reform: whichever URL a crawler
	// arrives through must round-trip to the same canonical.
	test("both URL forms round-trip to the same canonical", () => {
		for (const u of [
			"/cambios/reforma/BOE-A-2026-3212/2026-02-20/",
			"/cambios/reforma/?id=BOE-A-2026-3212&date=2026-02-20",
		]) {
			const ref = parseReformRef(url(u));
			expect(ref).not.toBeNull();
			expect(reformCanonicalPath(ref!.normId, ref!.date)).toBe(
				"/cambios/reforma/BOE-A-2026-3212/2026-02-20/",
			);
		}
	});
});
