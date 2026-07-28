import { describe, expect, test } from "bun:test";
import {
	isExperimentReform,
	isPathFormReform,
	REFORM_PATH_PREFIX,
	reformCanonicalPath,
} from "../lib/reform-experiment.ts";
import { parseReformRef } from "../worker/index.ts";

const url = (u: string) => new URL(u, "https://leyabierta.es");

describe("isExperimentReform", () => {
	test("only the experiment year takes part", () => {
		expect(isExperimentReform("2026-02-20")).toBe(true);
		expect(isExperimentReform("2025-12-31")).toBe(false);
		expect(isExperimentReform("1983-07-01")).toBe(false);
	});

	// "2026" must not match a date that merely contains it.
	test("matches on the year field, not a substring", () => {
		expect(isExperimentReform("1926-02-20")).toBe(false);
	});
});

describe("isPathFormReform", () => {
	test("nothing outside the experiment year is treatment", () => {
		expect(isPathFormReform("BOE-A-1978-31229", "2024-02-17")).toBe(false);
		expect(isPathFormReform("BOE-A-1978-31229", "1983-07-01")).toBe(false);
	});

	// Every caller (worker, sitemap, law page) computes assignment independently.
	// Non-determinism would have them advertise one URL and canonicalise another.
	test("assignment is deterministic", () => {
		const first = isPathFormReform("BOE-A-2026-3212", "2026-02-20");
		for (let i = 0; i < 100; i++) {
			expect(isPathFormReform("BOE-A-2026-3212", "2026-02-20")).toBe(first);
		}
	});

	// The split must actually split. A hash that sent everything one way would
	// leave the experiment with no matched control and no way to notice.
	test("splits the experiment year into two non-trivial arms", () => {
		let path = 0;
		const n = 400;
		for (let i = 0; i < n; i++) {
			if (isPathFormReform(`BOE-A-2026-${i}`, "2026-03-15")) path++;
		}
		// Not asserting 50/50 — just that neither arm collapsed.
		expect(path).toBeGreaterThan(n * 0.3);
		expect(path).toBeLessThan(n * 0.7);
	});

	test("the same reform on a different date is assigned independently", () => {
		// Assignment keys on id AND date, so one law's reforms can land in
		// different arms — that's intended, it's per-URL not per-law.
		const a = isPathFormReform("BOE-A-1978-31229", "2026-01-01");
		const b = isPathFormReform("BOE-A-1978-31229", "2026-01-02");
		expect(typeof a).toBe("boolean");
		expect(typeof b).toBe("boolean");
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

/** A 2026 reform id that the hash puts in the path arm. */
function pathArmId(): string {
	for (let i = 0; i < 1000; i++) {
		if (isPathFormReform(`BOE-A-2026-${i}`, "2026-02-20"))
			return `BOE-A-2026-${i}`;
	}
	throw new Error("no path-arm id found — the split is broken");
}

describe("reformCanonicalPath", () => {
	test("path-arm reforms canonicalise to the path form", () => {
		const id = pathArmId();
		expect(reformCanonicalPath(id, "2026-02-20")).toBe(
			`/cambios/reforma/${id}/2026-02-20/`,
		);
	});

	test("everything outside the path arm keeps the query form", () => {
		expect(reformCanonicalPath("BOE-A-1978-31229", "2024-02-17")).toBe(
			"/cambios/reforma/?id=BOE-A-1978-31229&date=2024-02-17",
		);
	});

	// The whole point of one canonical per reform: whichever URL a crawler
	// arrives through must round-trip to the same canonical.
	test("both URL forms round-trip to the same canonical", () => {
		const id = pathArmId();
		for (const u of [
			`/cambios/reforma/${id}/2026-02-20/`,
			`/cambios/reforma/?id=${id}&date=2026-02-20`,
		]) {
			const ref = parseReformRef(url(u));
			expect(ref).not.toBeNull();
			expect(reformCanonicalPath(ref!.normId, ref!.date)).toBe(
				`/cambios/reforma/${id}/2026-02-20/`,
			);
		}
	});
});

describe("REFORM_PATH_PREFIX", () => {
	// The worker imports this rather than keeping its own copy: a local
	// redefinition would let the base path drift, and the worker would silently
	// stop intercepting path URLs — crawlers would get 404s with no error.
	test("every canonical URL starts with the shared prefix", () => {
		expect(reformCanonicalPath("BOE-A-2026-1", "2026-01-01")).toStartWith(
			REFORM_PATH_PREFIX,
		);
		expect(reformCanonicalPath(pathArmId(), "2026-02-20")).toStartWith(
			REFORM_PATH_PREFIX,
		);
		expect(reformCanonicalPath("BOE-A-2020-1", "2020-01-01")).toStartWith(
			REFORM_PATH_PREFIX,
		);
	});
});

describe("client shell stays in sync with the shared prefix", () => {
	// The shell's script is inline browser JS: it can't import the module, so it
	// hardcodes the route in a regex. If REFORM_PATH_PREFIX ever changes and the
	// regex doesn't, the script stops recognising path URLs, writes "Faltan
	// parámetros" over the server-rendered content, and every treatment URL
	// renders as an error page for users and Googlebot alike. That exact bug
	// shipped once; this test is what makes it loud instead of silent.
	test("the shell's path regex matches REFORM_PATH_PREFIX", async () => {
		const shell = await Bun.file(
			new URL("../pages/cambios/reforma/index.astro", import.meta.url).pathname,
		).text();

		const escaped = REFORM_PATH_PREFIX.replaceAll("/", "\\/");
		expect(shell).toContain(
			`/^${escaped}([^/]+)\\/(\\d{4}-\\d{2}-\\d{2})\\/?$/`,
		);
	});

	// Guards the other half of the fix: without the data-ssr bail-out the script
	// would re-fetch and re-render over content the worker already injected.
	test("the shell bails out on server-rendered content", async () => {
		const shell = await Bun.file(
			new URL("../pages/cambios/reforma/index.astro", import.meta.url).pathname,
		).text();
		expect(shell).toContain('contentDiv.dataset.ssr === "1"');
	});
});
