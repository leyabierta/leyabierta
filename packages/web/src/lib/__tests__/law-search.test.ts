import { describe, expect, test } from "bun:test";
import {
	apiParams,
	type LawSearchResponse,
	type LawSearchState,
	pageParams,
	renderLawResults,
	SEARCH_PAGE_SIZE,
	stateFromUrl,
} from "../law-search.ts";

const base: LawSearchState = { q: "", jurisdiction: "", sort: "", page: 1 };

const hit = (
	id: string,
	extra: Partial<LawSearchResponse["data"][0]> = {},
) => ({
	id,
	title: `Ley de prueba ${id}`,
	status: "vigente",
	rank: "ley",
	published_at: "2023-05-24",
	...extra,
});

describe("stateFromUrl", () => {
	test("reads q, jurisdiction, sort and page", () => {
		expect(
			stateFromUrl("?q=%20vivienda%20&jurisdiction=es-an&sort=recent&page=3"),
		).toEqual({
			q: "vivienda",
			jurisdiction: "es-an",
			sort: "recent",
			page: 3,
		});
	});

	test("falls back to page 1 on junk", () => {
		expect(stateFromUrl("?page=abc").page).toBe(1);
		expect(stateFromUrl("?page=-2").page).toBe(1);
		expect(stateFromUrl("").page).toBe(1);
	});
});

describe("URL params", () => {
	test("page URL omits empty fields and page 1", () => {
		expect(pageParams({ ...base, q: "vivienda" }).toString()).toBe(
			"q=vivienda",
		);
		expect(
			pageParams({
				q: "",
				jurisdiction: "es-ct",
				sort: "",
				page: 2,
			}).toString(),
		).toBe("jurisdiction=es-ct&page=2");
	});

	test("API params carry limit and offset", () => {
		const p = apiParams({ ...base, q: "alquiler", page: 3 });
		expect(p.get("q")).toBe("alquiler");
		expect(p.get("limit")).toBe(String(SEARCH_PAGE_SIZE));
		expect(p.get("offset")).toBe(String(2 * SEARCH_PAGE_SIZE));
	});

	test("round-trips through the page URL", () => {
		const s = { q: "ley 12/2023", jurisdiction: "es", sort: "oldest", page: 4 };
		expect(stateFromUrl(`?${pageParams(s).toString()}`)).toEqual(s);
	});
});

describe("renderLawResults", () => {
	test("links each result to its law page", () => {
		const html = renderLawResults(
			{ data: [hit("BOE-A-2023-12203")], total: 1 },
			{ ...base, q: "vivienda" },
		);
		expect(html).toContain('href="/leyes/BOE-A-2023-12203/"');
		expect(html).toContain("En vigor");
		expect(html).toContain("Mostrando 1–1 de 1");
		expect(html).not.toContain('class="pagination"');
	});

	test("prefers the citizen summary as the link text", () => {
		const html = renderLawResults(
			{
				data: [hit("BOE-A-1", { citizen_summary: "Regula el alquiler" })],
				total: 1,
			},
			{ ...base, q: "alquiler" },
		);
		expect(html).toContain(">Regula el alquiler</a>");
		expect(html).toContain('class="law-card-official-title"');
	});

	test("escapes API text", () => {
		const html = renderLawResults(
			{
				data: [hit("BOE-A-1", { title: '<img src=x onerror="x">' })],
				total: 1,
			},
			base,
		);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	test("shows a removable jurisdiction filter with its Spanish name", () => {
		const html = renderLawResults(
			{ data: [hit("BOE-A-1")], total: 1 },
			{ ...base, jurisdiction: "es-pv" },
		);
		expect(html).toContain("País Vasco");
		expect(html).toContain("data-clear-jurisdiction");
	});

	test("paginates, marking the current page", () => {
		const html = renderLawResults(
			{ data: [hit("BOE-A-1")], total: 95, capped: true },
			{ ...base, q: "ley", page: 2 },
		);
		expect(html).toContain("de más de 95");
		expect(html).toContain('data-page="2" aria-current="page"');
		expect(html).toContain('data-page="5"');
		expect(html).not.toContain('data-page="6"');
	});
});
