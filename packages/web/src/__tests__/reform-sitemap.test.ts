// Guards sitemap-reformas.xml's URL selection. The duplicate case is the one
// with history: on 2026-08-21 the deployed sitemap carried 35,104 entries for
// 34,546 distinct URLs — 558 redundant <loc>s across 380 laws, because a law
// amended by two different norms on the same day has two `reformas[]` entries
// that collapse to a single id+date URL.
import { describe, expect, test } from "bun:test";
import {
	type ReformSitemapLaw,
	reformSitemapEntries,
} from "../lib/reform-sitemap.ts";

const OPTS = {
	siteUrl: "https://leyabierta.es",
	todayIso: "2026-08-21",
	maxYear: 2027,
};

const law = (over: Partial<ReformSitemapLaw> = {}): ReformSitemapLaw => ({
	identificador: "BOE-A-1992-28740",
	fecha_publicacion: "1992-11-27",
	reformas: [],
	...over,
});

describe("reformSitemapEntries", () => {
	test("emits one entry per reform", () => {
		const entries = reformSitemapEntries(
			[law({ reformas: [{ fecha: "1999-01-14" }, { fecha: "2003-11-12" }] })],
			OPTS,
		);
		expect(entries).toHaveLength(2);
	});

	test("collapses same-day reforms of one law into a single URL", () => {
		const entries = reformSitemapEntries(
			[
				law({
					reformas: [
						{ fecha: "2003-11-12" },
						{ fecha: "2003-11-12" },
						{ fecha: "2003-11-12" },
					],
				}),
			],
			OPTS,
		);
		expect(entries).toHaveLength(1);
	});

	test("never emits a duplicate <loc> across the whole corpus", () => {
		const entries = reformSitemapEntries(
			[
				law({ reformas: [{ fecha: "2003-11-12" }, { fecha: "2003-11-12" }] }),
				law({
					identificador: "BOE-A-2015-11724",
					fecha_publicacion: "2015-10-02",
					reformas: [{ fecha: "2021-05-05" }, { fecha: "2021-05-05" }],
				}),
			],
			OPTS,
		);
		const locs = entries.map((e) => e.loc);
		expect(new Set(locs).size).toBe(locs.length);
	});

	test("skips the original version — that's the law page, not a reform", () => {
		const entries = reformSitemapEntries(
			[law({ reformas: [{ fecha: "1992-11-27" }, { fecha: "1999-01-14" }] })],
			OPTS,
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.loc).toContain("1999-01-14");
	});

	test("drops the corrupt year-2929 pipeline dates Google rejected", () => {
		const entries = reformSitemapEntries(
			[law({ reformas: [{ fecha: "2929-11-19" }, { fecha: "1999-01-14" }] })],
			OPTS,
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.lastmod).toBe("1999-01-14");
	});

	test("clamps a future lastmod to today", () => {
		const entries = reformSitemapEntries(
			[law({ reformas: [{ fecha: "2026-12-31" }] })],
			OPTS,
		);
		expect(entries[0]?.lastmod).toBe("2026-08-21");
	});

	test("escapes ampersands so the XML stays well-formed", () => {
		// Query-form URLs carry &date=; a bare & would break the sitemap.
		const entries = reformSitemapEntries(
			[law({ reformas: [{ fecha: "1999-01-14" }] })],
			OPTS,
		);
		const loc = entries[0]?.loc ?? "";
		if (loc.includes("?id=")) expect(loc).toContain("&amp;date=");
		expect(loc).not.toMatch(/&(?!amp;)/);
	});
});
