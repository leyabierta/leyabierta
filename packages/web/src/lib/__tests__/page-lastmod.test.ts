import { describe, expect, test } from "bun:test";
import { fetchPrevState } from "../../../scripts/fetch-lastmod.ts";
import { pageLastModified } from "../law-dates.ts";
import { lawSitemapEntries, maxLastmod } from "../law-sitemap.ts";
import {
	advanceEntries,
	buildLastmodState,
	changedKeys,
	classifyPrevResponse,
	contentHash,
	LASTMOD_BOOTSTRAP_DATE,
	type LastmodEntry,
	type LastmodManifestInput,
	type LastmodState,
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

/** `n` keys k0..k(n-1), each with hash `h<i>`. */
const hashes = (n: number, prefix = "h") =>
	Object.fromEntries(
		Array.from({ length: n }, (_, i) => [`k${i}`, `${prefix}${i}`]),
	);
const prevOf = (cur: Record<string, string>, date = "2026-09-23") =>
	Object.fromEntries(
		Object.entries(cur).map(([k, h]) => [k, [h, date] as LastmodEntry]),
	);
const state = (
	laws: Record<string, LastmodEntry>,
	generated = "2026-09-25",
): LastmodState => ({
	version: 1,
	complete: true,
	generated,
	laws,
	reforms: {},
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
		expect(
			advanceEntries(undefined, { x: "h1" }, "2026-10-01").entries,
		).toEqual({
			x: ["h1", LASTMOD_BOOTSTRAP_DATE],
		});
	});

	test("the date only moves when the hash changes", () => {
		const prev = {
			same: ["h1", "2026-09-23"],
			changed: ["h2", "2026-09-23"],
		} as Record<string, LastmodEntry>;
		const r = advanceEntries(
			prev,
			{ same: "h1", changed: "h3", fresh: "h4" },
			"2026-10-01",
		);
		expect(r.entries).toEqual({
			same: ["h1", "2026-09-23"],
			changed: ["h3", "2026-10-01"],
			fresh: ["h4", "2026-10-01"],
		});
		expect(r.braked).toBe(false);
	});

	test("keys missing from a build are kept (marked absent) and not new when they return", () => {
		const cur = hashes(100);
		const prev = prevOf(cur);
		const { k5: _gone, ...without } = cur;
		const r1 = advanceEntries(prev, without, "2026-10-01");
		expect(r1.entries.k5).toEqual(["h5", "2026-09-23", 1]);
		const r2 = advanceEntries(r1.entries, cur, "2026-10-02");
		expect(r2.entries.k5).toEqual(["h5", "2026-09-23"]);
		expect(r2.changed).toBe(0);
	});

	test("mass change (>20%) is re-baselined: new hashes keep the previous date", () => {
		const cur = hashes(100);
		const next = { ...cur };
		for (let i = 0; i < 30; i++) next[`k${i}`] = `x${i}`;
		next.brandNew = "n";
		const r = advanceEntries(prevOf(cur), next, "2026-10-01");
		expect(r.braked).toBe(true);
		expect(r.changed).toBe(0);
		expect(r.entries.k0).toEqual(["x0", "2026-09-23"]);
		expect(r.entries.brandNew).toEqual(["n", LASTMOD_BOOTSTRAP_DATE]);
	});

	test("mass drop (>10%) also brakes", () => {
		const cur = hashes(100);
		const next = { ...cur };
		for (let i = 0; i < 11; i++) delete next[`k${i}`];
		next.k50 = "changed";
		const r = advanceEntries(prevOf(cur), next, "2026-10-01");
		expect(r.braked).toBe(true);
		expect(r.entries.k50).toEqual(["changed", "2026-09-23"]);
		expect(r.entries.k0).toEqual(["h0", "2026-09-23", 1]);
	});

	test("the brake can be lifted for a real mass change", () => {
		const cur = hashes(100);
		const next = hashes(100, "x");
		const r = advanceEntries(prevOf(cur), next, "2026-10-01", {
			allowMassChange: true,
		});
		expect(r.braked).toBe(false);
		expect(r.entries.k0).toEqual(["x0", "2026-10-01"]);
	});

	test("tiny states are not braked", () => {
		const r = advanceEntries(prevOf(hashes(10)), hashes(10, "x"), "2026-10-01");
		expect(r.braked).toBe(false);
	});
});

describe("buildLastmodState", () => {
	test("bootstrap, then incremental", () => {
		const first = buildLastmodState({
			prev: null,
			content: content(),
			today: "2026-09-25",
		}).state;
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
		}).state;
		expect(same.laws).toEqual(first.laws);
		expect(changedKeys(roundTrip, same)).toEqual({ laws: [], reforms: [] });

		const edited = content();
		edited.citizens["BOE-A-1"]!.summary = "Regula el alquiler de vivienda.";
		const next = buildLastmodState({
			prev: roundTrip,
			content: edited,
			today: "2026-09-26",
		}).state;
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
		}).state;
		const carried = buildLastmodState({
			prev,
			content: null,
			today: "2026-09-30",
		});
		expect(carried.state.laws).toEqual(prev.laws);
		expect(carried.warnings.length).toBe(1);
		expect(changedKeys(prev, carried.state)).toEqual({ laws: [], reforms: [] });
	});

	test("without content or previous state the output is an empty incomplete state", () => {
		const s = buildLastmodState({
			prev: null,
			content: null,
			today: "2026-09-30",
		}).state;
		expect(s.complete).toBe(false);
		expect(classifyPrevResponse(200, JSON.stringify(s)).kind).toBe("bootstrap");
	});
});

describe("classifyPrevResponse (H1: never reset over an existing state)", () => {
	const existing = JSON.stringify(state({ a: ["h", "2026-09-23"] }));

	test("200 with a valid state → prev", () => {
		expect(classifyPrevResponse(200, existing).kind).toBe("prev");
	});
	test("404 → bootstrap", () => {
		expect(classifyPrevResponse(404, "").kind).toBe("bootstrap");
	});
	test("5xx, network error, HTML challenge, bad shape → retry (not bootstrap)", () => {
		expect(classifyPrevResponse(503, "").kind).toBe("retry");
		expect(classifyPrevResponse(0, "").kind).toBe("retry");
		expect(classifyPrevResponse(200, "<html>Just a moment…</html>").kind).toBe(
			"retry",
		);
		expect(classifyPrevResponse(200, '{"version":1}').kind).toBe("retry");
		expect(
			classifyPrevResponse(
				200,
				JSON.stringify({
					...state({ a: ["h", "2026-09-23"] }),
					complete: false,
				}),
			).kind,
		).toBe("retry");
	});
	test("the operator can allow a reset", () => {
		expect(classifyPrevResponse(503, "", true).kind).toBe("bootstrap");
	});
});

describe("fetchPrevState", () => {
	const noSleep = async () => {};

	test("download fails with an existing state → error after retries, no reset", async () => {
		let calls = 0;
		const d = await fetchPrevState(
			"u",
			{
				fetch: async () => {
					calls++;
					return { status: 502, body: "" };
				},
				sleep: noSleep,
			},
			false,
		);
		expect(d.kind).toBe("retry");
		expect(calls).toBe(4);
	});

	test("a transient failure recovers on retry", async () => {
		let calls = 0;
		const body = JSON.stringify(state({ a: ["h", "2026-09-23"] }));
		const d = await fetchPrevState(
			"u",
			{
				fetch: async () =>
					++calls < 3
						? Promise.reject(new Error("timeout"))
						: { status: 200, body },
				sleep: noSleep,
			},
			false,
		);
		expect(d.kind).toBe("prev");
	});

	test("404 bootstraps without retrying", async () => {
		let calls = 0;
		const d = await fetchPrevState(
			"u",
			{
				fetch: async () => {
					calls++;
					return { status: 404, body: "" };
				},
				sleep: noSleep,
			},
			false,
		);
		expect(d.kind).toBe("bootstrap");
		expect(calls).toBe(1);
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
	test("accepts absent-marked entries", () => {
		expect(
			parseLastmodState(state({ a: ["h", "2026-09-23", 1] })),
		).not.toBeNull();
	});
});

describe("changedKeys", () => {
	test("sends nothing without a previous state", () => {
		const next = buildLastmodState({
			prev: null,
			content: content(),
			today: "2026-09-25",
		}).state;
		expect(changedKeys(null, next)).toEqual({ laws: [], reforms: [] });
	});
	test("skips re-baselined and absent keys", () => {
		const prev = state({
			a: ["h1", "2026-09-23"],
			b: ["h2", "2026-09-23"],
			c: ["h3", "2026-09-23"],
		});
		const next = state({
			a: ["x1", "2026-09-23"], // re-baselined: new hash, old date
			b: ["x2", "2026-09-25"], // dated in this build
			c: ["h3", "2026-09-23", 1], // absent
		});
		expect(changedKeys(prev, next)).toEqual({ laws: ["b"], reforms: [] });
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
