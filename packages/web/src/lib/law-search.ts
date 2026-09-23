/**
 * Law search, shared by the home page and the /leyes/ index.
 *
 * Both pages call `GET /v1/laws` from the browser and render the same result
 * cards. Until 2026-09-23 this lived only in an inline script on the home, and
 * /leyes/ — the `action` of the navbar search form and the target of the
 * JSON-LD `SearchAction` — returned 404. Keeping the logic here means the two
 * pages can't drift apart.
 *
 * The pure pieces (labels, `renderLawResults`) are exported separately so they
 * can be tested without a DOM. `createLawSearch` is the browser controller.
 */

export const RANK_LABELS: Record<string, string> = {
	constitucion: "Constitución",
	ley_organica: "Ley Orgánica",
	ley: "Ley",
	real_decreto_ley: "Decreto urgente",
	real_decreto_legislativo: "Decreto legislativo",
	real_decreto: "Real Decreto",
	orden: "Orden",
	resolucion: "Resolución",
	acuerdo_internacional: "Acuerdo internacional",
	circular: "Circular",
	instruccion: "Instrucción",
	decreto: "Decreto",
	reglamento: "Reglamento",
	acuerdo: "Acuerdo",
};

export const STATUS_LABELS: Record<string, string> = {
	vigente: "En vigor",
	derogada: "Ya no está en vigor",
	parcialmente_derogada: "Parcialmente en vigor",
};

export const JURISDICTION_LABELS: Record<string, string> = {
	es: "Estatal",
	"es-an": "Andalucía",
	"es-ar": "Aragón",
	"es-as": "Asturias",
	"es-cb": "Cantabria",
	"es-cl": "Castilla y León",
	"es-cm": "Castilla-La Mancha",
	"es-cn": "Canarias",
	"es-ct": "Cataluña",
	"es-ex": "Extremadura",
	"es-ga": "Galicia",
	"es-ib": "Illes Balears",
	"es-mc": "Murcia",
	"es-md": "Madrid",
	"es-nc": "Navarra",
	"es-pv": "País Vasco",
	"es-ri": "La Rioja",
	"es-vc": "C. Valenciana",
};

export const SEARCH_PAGE_SIZE = 20;

export interface LawSearchHit {
	id: string;
	title: string;
	short_title?: string | null;
	citizen_summary?: string | null;
	status: string;
	rank: string;
	published_at: string;
}

export interface LawSearchResponse {
	data: LawSearchHit[];
	total: number;
	capped?: boolean;
}

export interface LawSearchState {
	q: string;
	jurisdiction: string;
	sort: string;
	page: number;
}

function esc(s: unknown): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const fmt = (n: number) => n.toLocaleString("es", { useGrouping: "always" });

export const NO_RESULTS_HTML =
	'<div class="search-message">No se encontraron resultados. Prueba con otro término.</div>';
export const SEARCH_ERROR_HTML =
	'<div class="search-message">Error al buscar. La API no está disponible.</div>';

export function renderSkeleton(): string {
	const bar = (w: string, last = false) =>
		`<div class="search-skeleton-bar" style="width:${w}${last ? ";margin-bottom:0" : ""}"></div>`;
	return `<div class="search-skeleton"><div class="search-skeleton-card">${bar("70%")}${bar("90%")}${bar("40%", true)}</div></div>`;
}

/** Query string for `GET /v1/laws`. */
export function apiParams(state: LawSearchState): URLSearchParams {
	const params = new URLSearchParams();
	if (state.q) params.set("q", state.q);
	if (state.jurisdiction) params.set("jurisdiction", state.jurisdiction);
	if (state.sort) params.set("sort", state.sort);
	params.set("limit", String(SEARCH_PAGE_SIZE));
	params.set("offset", String((state.page - 1) * SEARCH_PAGE_SIZE));
	return params;
}

/** Query string for the page's own URL, so a search can be shared or reloaded. */
export function pageParams(state: LawSearchState): URLSearchParams {
	const params = new URLSearchParams();
	if (state.q) params.set("q", state.q);
	if (state.jurisdiction) params.set("jurisdiction", state.jurisdiction);
	if (state.sort) params.set("sort", state.sort);
	if (state.page > 1) params.set("page", String(state.page));
	return params;
}

/** Reads a search back out of a page URL. */
export function stateFromUrl(search: string): LawSearchState {
	const p = new URLSearchParams(search);
	const page = Number.parseInt(p.get("page") ?? "1", 10);
	return {
		q: (p.get("q") ?? "").trim(),
		jurisdiction: p.get("jurisdiction") ?? "",
		sort: p.get("sort") ?? "",
		page: Number.isFinite(page) && page > 0 ? page : 1,
	};
}

/**
 * HTML for a page of results: optional jurisdiction badge, header with count
 * and sort, the law cards, and pagination. Assumes `result.data` is non-empty.
 */
export function renderLawResults(
	result: LawSearchResponse,
	state: LawSearchState,
): string {
	const offset = (state.page - 1) * SEARCH_PAGE_SIZE;
	const totalPages = Math.ceil(result.total / SEARCH_PAGE_SIZE);
	let html = "";

	if (state.jurisdiction) {
		const name = JURISDICTION_LABELS[state.jurisdiction] || state.jurisdiction;
		html += `<div class="results-filter-badge">${esc(name)} <button type="button" class="results-filter-clear" data-clear-jurisdiction aria-label="Quitar filtro">&times;</button></div>`;
	}

	const hasQuery = !!state.q;
	const totalLabel = result.capped
		? `más de ${fmt(result.total)}`
		: fmt(result.total);
	const opt = (value: string, label: string) =>
		`<option value="${value}"${state.sort === value ? " selected" : ""}>${label}</option>`;
	html += '<div class="results-header">';
	html += `<span class="results-info">Mostrando ${offset + 1}–${Math.min(offset + SEARCH_PAGE_SIZE, result.total)} de ${totalLabel}</span>`;
	html += '<select class="sort-select" aria-label="Ordenar resultados">';
	html += opt("", hasQuery ? "Más relevantes" : "Más recientes");
	if (hasQuery) html += opt("recent", "Más recientes");
	html += opt("oldest", "Más antiguas");
	html += opt("title", "Alfabético");
	html += "</select></div>";

	for (const law of result.data) {
		const href = `/leyes/${encodeURIComponent(law.id)}/`;
		html += '<article class="law-card">';
		if (law.citizen_summary) {
			html += `<a href="${href}" class="law-card-title">${esc(law.citizen_summary)}</a>`;
			html += `<p class="law-card-official-title">${esc(law.title)}</p>`;
		} else {
			if (
				law.short_title &&
				law.short_title !== law.title &&
				law.short_title.length > 25
			) {
				html += `<span class="law-card-short-title">${esc(law.short_title)}</span>`;
			}
			html += `<a href="${href}" class="law-card-title">${esc(law.title)}</a>`;
		}
		html += '<div class="law-card-meta">';
		// Only known statuses become a class name; anything else gets no badge colour.
		const statusClass = STATUS_LABELS[law.status] ? ` badge-${law.status}` : "";
		html += `<span class="badge${statusClass}" style="text-transform:none">${esc(STATUS_LABELS[law.status] || law.status)}</span>`;
		html += '<span class="meta-sep">&middot;</span>';
		html += `<span>${esc(RANK_LABELS[law.rank] || law.rank)}</span>`;
		html += '<span class="meta-sep">&middot;</span>';
		html += `<span>${esc(law.published_at)}</span>`;
		html += `<span class="law-card-id">${esc(law.id)}</span>`;
		html += "</div></article>";
	}

	if (totalPages > 1) {
		const page = state.page;
		const num = (
			p: number,
			label: string | number = p,
			current = false,
			ariaLabel = "",
		) =>
			`<button type="button" class="page-num${current ? " current" : ""}" data-page="${p}"${current ? ' aria-current="page"' : ""}${ariaLabel ? ` aria-label="${ariaLabel}"` : ""}>${label}</button>`;
		html += '<nav class="pagination" aria-label="Páginas de resultados">';
		if (page > 1) html += num(page - 1, "&larr;", false, "Página anterior");
		const startPage = Math.max(1, page - 4);
		const endPage = Math.min(totalPages, startPage + 9);
		if (startPage > 1)
			html += `${num(1)}<span class="page-ellipsis">&hellip;</span>`;
		for (let p = startPage; p <= endPage; p++) html += num(p, p, p === page);
		if (endPage < totalPages)
			html += `<span class="page-ellipsis">&hellip;</span>${num(totalPages)}`;
		if (page < totalPages)
			html += num(page + 1, "&rarr;", false, "Página siguiente");
		html += "</nav>";
	}

	return html;
}

export interface LawSearchOptions {
	/** API origin, e.g. https://api.leyabierta.es */
	api: string;
	/** Text box holding the query. */
	input: HTMLInputElement;
	/** Where result HTML is written. */
	results: HTMLElement;
	/** Path the page's URL is rewritten to while searching ("/" or "/leyes/"). */
	basePath: string;
	/** Called when a search starts (show the results area, hide the rest). */
	onActive?: (state: Readonly<LawSearchState>) => void;
	/** Called when there is nothing to search (no query, no jurisdiction). */
	onIdle?: () => void;
	/** Scrolled into view on narrow screens once results arrive. */
	scrollTarget?: HTMLElement;
}

export interface LawSearch {
	run(page?: number): void;
	setJurisdiction(jurisdiction: string): void;
	/** Runs the search encoded in the current URL, if any. Returns whether it did. */
	restoreFromUrl(): boolean;
}

/** Browser controller: fetch, render, pagination, sort, filter, URL sync. */
export function createLawSearch(opts: LawSearchOptions): LawSearch {
	const state: LawSearchState = { q: "", jurisdiction: "", sort: "", page: 1 };
	// The request in flight, if any. Each new search (or going back to idle)
	// aborts it, so a slow earlier response can never overwrite newer results.
	let inflight: AbortController | null = null;

	function run(page = 1): void {
		state.page = page;
		state.q = opts.input.value.trim();
		inflight?.abort();
		inflight = null;

		if (!state.q && !state.jurisdiction) {
			opts.results.removeAttribute("aria-busy");
			opts.results.innerHTML = "";
			opts.onIdle?.();
			history.replaceState(null, "", opts.basePath);
			return;
		}

		opts.onActive?.({ ...state });

		// First page only, so paginating doesn't count as another search.
		if (window.la && state.page === 1 && state.q) {
			window.la.track("search_submit", {
				q_len: state.q.length,
				has_jurisdiction: !!state.jurisdiction,
			});
		}

		opts.results.innerHTML = renderSkeleton();
		opts.results.setAttribute("aria-busy", "true");
		history.replaceState(
			null,
			"",
			`${opts.basePath}?${pageParams(state).toString()}`,
		);

		const snapshot = { ...state };
		const fetchUrl = `${opts.api}/v1/laws?${apiParams(snapshot).toString()}`;
		const controller = new AbortController();
		inflight = controller;
		const { signal } = controller;
		requestAnimationFrame(() => {
			setTimeout(() => {
				if (signal.aborted) return;
				fetch(fetchUrl, { signal })
					.then((r) => r.json() as Promise<LawSearchResponse>)
					.then((result) => {
						if (!signal.aborted) render(result, snapshot);
					})
					.catch(() => {
						if (!signal.aborted) opts.results.innerHTML = SEARCH_ERROR_HTML;
					})
					.finally(() => {
						if (signal.aborted) return;
						opts.results.removeAttribute("aria-busy");
						if (inflight === controller) inflight = null;
					});
			}, 0);
		});
	}

	function render(result: LawSearchResponse, snapshot: LawSearchState): void {
		if (result.data.length === 0) {
			if (window.la && snapshot.q) {
				const sanitized = window.la.sanitize(snapshot.q);
				window.la.track("search_zero_results", {
					had_pii: sanitized.had_pii,
					query: sanitized.query,
					jurisdiction: snapshot.jurisdiction || null,
				});
			}
			opts.results.innerHTML = NO_RESULTS_HTML;
			return;
		}

		opts.results.innerHTML = renderLawResults(result, snapshot);

		if (opts.scrollTarget && window.innerWidth <= 768) {
			opts.scrollTarget.scrollIntoView({ behavior: "smooth", block: "start" });
		}

		const offset = (snapshot.page - 1) * SEARCH_PAGE_SIZE;
		if (window.la) {
			const la = window.la;
			const links = opts.results.querySelectorAll<HTMLAnchorElement>(
				".law-card .law-card-title",
			);
			for (const [idx, link] of [...links].entries()) {
				link.addEventListener("click", () => {
					la.track("search_result_click", {
						position: offset + idx + 1,
						law_id: (link.getAttribute("href") || "").replace(
							/\/leyes\/|\/$/g,
							"",
						),
						had_query: !!snapshot.q,
					});
				});
			}
		}

		for (const el of opts.results.querySelectorAll<HTMLElement>(
			".page-num[data-page]",
		)) {
			el.addEventListener("click", () => run(Number(el.dataset.page)));
		}

		const sortSelect = opts.results.querySelector(
			".sort-select",
		) as HTMLSelectElement | null;
		sortSelect?.addEventListener("change", () => {
			state.sort = sortSelect.value;
			window.la?.track("filter_applied", {
				kind: "sort",
				value: state.sort || "default",
			});
			run(1);
		});

		opts.results
			.querySelector("[data-clear-jurisdiction]")
			?.addEventListener("click", () => {
				state.jurisdiction = "";
				window.la?.track("filter_applied", { kind: "jurisdiction_cleared" });
				run(1);
			});
	}

	return {
		run,
		setJurisdiction(jurisdiction: string) {
			state.jurisdiction = jurisdiction;
		},
		restoreFromUrl() {
			const fromUrl = stateFromUrl(window.location.search);
			if (!fromUrl.q && !fromUrl.jurisdiction) return false;
			opts.input.value = fromUrl.q;
			state.jurisdiction = fromUrl.jurisdiction;
			state.sort = fromUrl.sort;
			run(fromUrl.page);
			return true;
		},
	};
}
