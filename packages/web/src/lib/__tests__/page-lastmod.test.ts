import { describe, expect, test } from "bun:test";
import { pageLastModified } from "../law-dates.ts";
import { lawSitemapEntries, maxLastmod } from "../law-sitemap.ts";
import {
	advanceEntries,
	buildLastmodState,
	changedKeys,
	contentHash,
	LASTMOD_BOOTSTRAP_DATE,
	type LastmodManifestInput,
	lawContentHash,
	parseLastmodState,
	reformContentHashes,
} from "../page-lastmod.ts";
import { reformSitemapEntries } from "../reform-sitemap.ts";

const content = (): LastmodManifestInput => ({
	citizens: {
		"BOE-A-1": {
			summary: "Regula  el alquiler.",
			tags: ["vivienda", "alquiler"],
		},
		"BOE-A-2": { summary: "", tags: [] },
	},
	reforms: {
		"BOE-A-1": [
			{
				date: "2024-01-02",
				source: "BOE-A-9",
				headline: "Sube la fianza",
				summary: "Dos meses.",
			},
			{
				date: "2024-01-02",
				source: "BOE-A-8",
				headline: "Otro cambio",
				summary: "",
			},
		],
	},
	articles: {
		"BOE-A-1": [
			["Artículo 1", "Objeto de la ley.", "a1"],
			["Artículo 2", "Ámbito.", "a2"],
		],
		"BOE-A-3": [["Artículo 1", "", "a1"]],
	},
});

describe("contentHash", () => {
	test("is stable across part order and whitespace", () => {
		expect(contentHash(["a  b", "c"])).toBe(contentHash(["c", " a b\n"]));
	});
	test("changes when the text changes", () => {
		expect(contentHash(["a b"])).not.toBe(contentHash(["a c"]));
	});
});

describe("lawContentHash", () => {
	test("ignores manifest order and spacing", () => {
		const a = content();
		const b = content();
		b.reforms["BOE-A-1"]!.reverse();
		b.articles["BOE-A-1"]!.reverse();
		b.citizens["BOE-A-1"]!.summary = " Regula el alquiler. ";
		b.citizens["BOE-A-1"]!.tags.reverse();
		expect(lawContentHash("BOE-A-1", a)).toBe(lawContentHash("BOE-A-1", b)!);
	});
	test("changes when an article summary changes", () => {
		const b = content();
		b.articles["BOE-A-1"]![1]![1] = "Ámbito de aplicación.";
		expect(lawContentHash("BOE-A-1", content())).not.toBe(
			lawContentHash("BOE-A-1", b)!,
		);
	});
	test("is undefined for a law with no own content (a noindex page)", () => {
		expect(lawContentHash("BOE-A-2", content())).toBeUndefined();
		expect(lawContentHash("BOE-A-3", content())).toBeUndefined();
		expect(lawContentHash("BOE-A-404", content())).toBeUndefined();
	});
});

describe("reformContentHashes", () => {
	test("one entry per law+date, reforms without text are absent", () => {
		const m = content();
		m.reforms["BOE-A-1"]!.push({
			date: "2020-05-05",
			source: "BOE-A-7",
			headline: " ",
			summary: "",
		});
		expect(Object.keys(reformContentHashes(m))).toEqual(["BOE-A-1|2024-01-02"]);
	});
});

describe("advanceEntries", () => {
	test("without a previous state every entry gets the bootstrap date", () => {
		expect(advanceEntries(undefined, { x: "h1" }, "2026-10-01")).toEqual({
			x: ["h1", LASTMOD_BOOTSTRAP_DATE],
		});
	});
	test("the date only moves when the hash changes", () => {
		const prev = {
			same: ["h1", "2026-09-23"],
			changed: ["h2", "2026-09-23"],
		} as Record<string, [string, string]>;
		expect(
			advanceEntries(
				prev,
				{ same: "h1", changed: "h3", fresh: "h4" },
				"2026-10-01",
			),
		).toEqual({
			same: ["h1", "2026-09-23"],
			changed: ["h3", "2026-10-01"],
			fresh: ["h4", "2026-10-01"],
		});
	});
});

describe("buildLastmodState", () => {
	test("bootstrap, then incremental", () => {
		const first = buildLastmodState({
			prev: null,
			content: content(),
			today: "2026-09-25",
		});
		expect(first.complete).toBe(true);
		expect(first.laws["BOE-A-1"]![1]).toBe(LASTMOD_BOOTSTRAP_DATE);
		expect(first.reforms["BOE-A-1|2024-01-02"]![1]).toBe(
			LASTMOD_BOOTSTRAP_DATE,
		);
		expect(Object.keys(first.laws)).toEqual(["BOE-A-1"]);

		const roundTrip = parseLastmodState(JSON.parse(JSON.stringify(first)));
		const same = buildLastmodState({
			prev: roundTrip,
			content: content(),
			today: "2026-09-26",
		});
		expect(same.laws).toEqual(first.laws);
		expect(changedKeys(roundTrip, same)).toEqual({ laws: [], reforms: [] });

		const edited = content();
		edited.citizens["BOE-A-1"]!.summary = "Regula el alquiler de vivienda.";
		const next = buildLastmodState({
			prev: roundTrip,
			content: edited,
			today: "2026-09-26",
		});
		expect(next.laws["BOE-A-1"]![1]).toBe("2026-09-26");
		expect(next.reforms["BOE-A-1|2024-01-02"]![1]).toBe(LASTMOD_BOOTSTRAP_DATE);
		expect(changedKeys(roundTrip, next)).toEqual({
			laws: ["BOE-A-1"],
			reforms: [],
		});
	});

	test("without content it carries the previous state, never inventing dates", () => {
		const prev = buildLastmodState({
			prev: null,
			content: content(),
			today: "2026-09-25",
		});
		const carried = buildLastmodState({
			prev,
			content: null,
			today: "2026-09-30",
		});
		expect(carried.laws).toEqual(prev.laws);
		expect(changedKeys(prev, carried)).toEqual({ laws: [], reforms: [] });
	});

	test("without content or previous state the output is incomplete (next build bootstraps)", () => {
		const s = buildLastmodState({
			prev: null,
			content: null,
			today: "2026-09-30",
		});
		expect(s.complete).toBe(false);
		expect(parseLastmodState(JSON.parse(JSON.stringify(s)))).toBeNull();
	});
});

describe("parseLastmodState", () => {
	test("rejects malformed input", () => {
		expect(parseLastmodState(null)).toBeNull();
		expect(
			parseLastmodState({
				version: 99,
				complete: true,
				generated: "x",
				laws: {},
				reforms: {},
			}),
		).toBeNull();
		expect(
			parseLastmodState({
				version: 1,
				complete: true,
				generated: "x",
				laws: { a: ["h", "ayer"] },
				reforms: {},
			}),
		).toBeNull();
	});
});

describe("changedKeys", () => {
	test("sends nothing without a previous state", () => {
		const next = buildLastmodState({
			prev: null,
			content: content(),
			today: "2026-09-25",
		});
		expect(changedKeys(null, next)).toEqual({ laws: [], reforms: [] });
	});
});

describe("pageLastModified", () => {
	const law = {
		ultima_actualizacion: "2020-01-01",
		reformas: [{ fecha: "2021-03-04" }],
	};
	test("later of the legal date and the content date", () => {
		expect(pageLastModified(law, "2026-09-23", "2026-09-25")).toBe(
			"2026-09-23",
		);
		expect(pageLastModified(law, "2019-01-01", "2026-09-25")).toBe(
			"2021-03-04",
		);
		expect(pageLastModified(law, undefined, "2026-09-25")).toBe("2021-03-04");
	});
	test("ignores a content date in the future", () => {
		expect(pageLastModified(law, "2026-12-01", "2026-09-25")).toBe(
			"2021-03-04",
		);
	});
});

describe("sitemap lastmod", () => {
	const laws = [
		{
			identificador: "A",
			fecha_publicacion: "1990-01-01",
			reformas: [{ fecha: "1990-01-01" }, { fecha: "1995-06-01" }],
		},
		{
			identificador: "B",
			fecha_publicacion: "2001-01-01",
			reformas: [{ fecha: "2001-01-01" }],
		},
		{
			identificador: "C",
			fecha_publicacion: "1950-01-01",
			reformas: [{ fecha: "1950-01-01" }],
		},
	];
	const today = "2026-09-25";

	test("law entries use the content date and skip non-indexable laws", () => {
		const entries = lawSitemapEntries(laws, {
			siteUrl: "https://x",
			todayIso: today,
			isIndexable: (id) => id !== "B",
			contentDate: (id) => (id === "A" ? "2026-09-23" : undefined),
		});
		expect(entries).toEqual([
			{ loc: "https://x/leyes/A/", lastmod: "2026-09-23" },
			// 1950 is not emittable as <lastmod> (pre-1970).
			{ loc: "https://x/leyes/C/" },
		]);
	});

	test("reform entries take a later content date, even for pre-1970 reforms", () => {
		const entries = reformSitemapEntries(
			[
				...laws,
				{
					identificador: "D",
					fecha_publicacion: "1940-01-01",
					reformas: [{ fecha: "1940-01-01" }, { fecha: "1946-12-19" }],
				},
			],
			{
				siteUrl: "https://x",
				todayIso: today,
				maxYear: 2027,
				contentDate: (id) => (id === "D" ? "2026-09-23" : undefined),
			},
		);
		expect(entries.map((e) => e.lastmod)).toEqual(["1995-06-01", "2026-09-23"]);
	});

	test("the index lastmod is the max of its children's", () => {
		expect(
			maxLastmod([{ lastmod: "2020-01-01" }, {}, { lastmod: "2026-09-23" }]),
		).toBe("2026-09-23");
		expect(maxLastmod([{}])).toBeUndefined();
	});
});
