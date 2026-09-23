import { afterEach, describe, expect, test } from "bun:test";
import {
	apiParams,
	createLawSearch,
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

	test("gives the arrow buttons a spoken name", () => {
		const html = renderLawResults(
			{ data: [hit("BOE-A-1")], total: 95 },
			{ ...base, q: "ley", page: 2 },
		);
		expect(html).toContain(
			'data-page="1" aria-label="Página anterior">&larr;</button>',
		);
		expect(html).toContain(
			'data-page="3" aria-label="Página siguiente">&rarr;</button>',
		);
	});
});

describe("renderLawResults — cards", () => {
	test("shows short_title only when it is longer than 25 characters", () => {
		const long = "Ley de Arrendamientos Urbanos de 1994";
		const withLong = renderLawResults(
			{ data: [hit("BOE-A-1", { short_title: long })], total: 1 },
			base,
		);
		const withShort = renderLawResults(
			{ data: [hit("BOE-A-1", { short_title: "LAU" })], total: 1 },
			base,
		);
		expect(withLong).toContain(`class="law-card-short-title">${long}<`);
		expect(withShort).not.toContain("law-card-short-title");
	});

	test("only known statuses become a badge class", () => {
		const known = renderLawResults(
			{ data: [hit("BOE-A-1", { status: "derogada" })], total: 1 },
			base,
		);
		expect(known).toContain('class="badge badge-derogada"');
		const odd = renderLawResults(
			{ data: [hit("BOE-A-1", { status: "vigente extra" })], total: 1 },
			base,
		);
		expect(odd).toContain('class="badge"');
		expect(odd).not.toContain("badge-vigente");
	});
});

// ── Browser controller, with the few browser globals it touches stubbed ──

type Pending = {
	url: string;
	signal: AbortSignal;
	resolve: (body: LawSearchResponse) => void;
};

const saved = {
	window: globalThis.window,
	history: globalThis.history,
	raf: globalThis.requestAnimationFrame,
	fetch: globalThis.fetch,
	setTimeout: globalThis.setTimeout,
};

afterEach(() => {
	Object.assign(globalThis, {
		window: saved.window,
		history: saved.history,
		requestAnimationFrame: saved.raf,
		fetch: saved.fetch,
		setTimeout: saved.setTimeout,
	});
});

function setup() {
	const pending: Pending[] = [];
	Object.assign(globalThis, {
		window: { innerWidth: 1280 },
		history: { replaceState() {} },
		requestAnimationFrame: (cb: () => void) => cb(),
		// Other test files replace the global setTimeout; don't depend on it.
		setTimeout: (cb: () => void) => {
			queueMicrotask(cb);
			return 0;
		},
		fetch: (url: string, init?: RequestInit) =>
			new Promise((resolve, reject) => {
				const signal = init?.signal as AbortSignal;
				signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
				pending.push({
					url,
					signal,
					resolve: (body) => resolve({ json: async () => body }),
				});
			}),
	});
	const results = {
		innerHTML: "",
		attrs: new Map<string, string>(),
		setAttribute(k: string, v: string) {
			this.attrs.set(k, v);
		},
		removeAttribute(k: string) {
			this.attrs.delete(k);
		},
		querySelectorAll: () => [],
		querySelector: () => null,
	};
	const input = { value: "" };
	const search = createLawSearch({
		api: "https://api.test",
		input: input as unknown as HTMLInputElement,
		results: results as unknown as HTMLElement,
		basePath: "/leyes/",
	});
	return { pending, results, input, search };
}

const tick = () => Bun.sleep(5);

describe("createLawSearch", () => {
	test("a slow earlier response never overwrites a newer search", async () => {
		const { pending, results, input, search } = setup();
		input.value = "alquiler";
		search.run(1);
		await tick();
		input.value = "herencia";
		search.run(1);
		await tick();
		expect(pending).toHaveLength(2);
		expect(pending[0].signal.aborted).toBe(true);

		pending[1].resolve({ data: [hit("BOE-A-HERENCIA")], total: 1 });
		await tick();
		pending[0].resolve({ data: [hit("BOE-A-ALQUILER")], total: 1 });
		await tick();

		expect(results.innerHTML).toContain("BOE-A-HERENCIA");
		expect(results.innerHTML).not.toContain("BOE-A-ALQUILER");
		expect(results.attrs.has("aria-busy")).toBe(false);
	});

	test("clearing the search drops the request in flight", async () => {
		const { pending, results, input, search } = setup();
		input.value = "alquiler";
		search.run(1);
		await tick();
		input.value = "";
		search.run(1);
		pending[0].resolve({ data: [hit("BOE-A-ALQUILER")], total: 1 });
		await tick();
		expect(results.innerHTML).toBe("");
		expect(results.attrs.has("aria-busy")).toBe(false);
	});

	test("paginating asks the API for the right offset", async () => {
		const { pending, results, input, search } = setup();
		input.value = "ley";
		search.run(3);
		await tick();
		expect(pending[0].url).toContain(`offset=${2 * SEARCH_PAGE_SIZE}`);
		pending[0].resolve({ data: [hit("BOE-A-1")], total: 95 });
		await tick();
		expect(results.innerHTML).toContain('data-page="3" aria-current="page"');
	});
});
