/**
 * Per-article citizen summaries: match them to the rendered legal text.
 *
 * Two consumers share the same matcher so they can never disagree:
 * - `/leyes/[id]/texto/` injects each summary as a visible, labelled note right
 *   after its article heading (`bakeArticleSummaries`).
 * - `/leyes/[id]/` lists every summary ("Artículo por artículo") and links each
 *   one to the anchor of its article on the text page (`matchArticleSummaries`).
 */

import { escapeHtml } from "./escape.ts";

/** Where the "generado con IA" labels link to (explains how summaries are made). */
export const AI_SUMMARIES_EXPLAINER_HREF = "/sobre/#resumenes-ia";

/**
 * Normalize heading / summary-title text so the build-time matcher is
 * insensitive to case, accents, punctuation and whitespace.
 */
export function normKey(s: string): string {
	return (
		s
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			// "Art. 1", "Art 1" and "Artículo 1" are the same article: older texts
			// (and some BOE titles) abbreviate the heading.
			.replace(/^\s*art(?:iculo)?\.?\s+/, "articulo ")
			// Map "." to a word boundary ("-") *before* the general strip so that
			// decimal articles keep their structure: "Artículo 1.1" → "articulo 1-1"
			// stays distinct from "Artículo 11" → "articulo 11" (otherwise both
			// collapse to "articulo 11" and one summary is silently dropped).
			.replace(/\./g, "-")
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/** Decode the few entities markdown-it / sanitize-html emit in heading text. */
export function decodeEntities(s: string): string {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&#x27;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

/** Plain text of an HTML fragment (tags dropped, entities decoded, spaces collapsed). */
function plainText(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Markup for one summary note on the text page. Kept compact on purpose:
 * large codes carry 1,000+ of these.
 */
export function renderArticleSummary(summary: string): string {
	return (
		`<div class="article-summary" role="note">` +
		`<p class="article-summary-label">Resumen en lenguaje sencillo ` +
		`<a href="${AI_SUMMARIES_EXPLAINER_HREF}">(generado con IA)</a></p>` +
		`<p class="article-summary-text">${escapeHtml(summary)}</p>` +
		`</div>`
	);
}

/**
 * "articulo 5- competencias del presidente-" → "articulo 5"; "articulo 17 bis-
 * ..." → "articulo 17 bis"; null for headings that are not articles.
 *
 * Any single word between the number and the end of the heading's first
 * sentence is part of the article number: besides bis/ter/quater, tax codes
 * go up to "quaterdecies", "tervicies", "quinquagies"… and some old laws use
 * "30 tercero", "91 cuarto". Treating those as plain "articulo 103" made every
 * "103 …ies" article share one fallback queue, so summaries slid onto the
 * wrong article.
 */
function articleNumberKey(key: string): string | null {
	const m =
		/^articulo (\d+(?:-\d+)*|unico)(?: ([a-z]+)(?=-|$))?(?=$|[ -])/.exec(key);
	if (!m) return null;
	return m[2] ? `articulo ${m[1]} ${m[2]}` : `articulo ${m[1]}`;
}

/** One summary, as matched against the rendered text. */
export interface ArticleSummaryItem {
	/** Article heading as it appears in the legal text, e.g. "Artículo 1. Ámbito." */
	heading: string;
	summary: string;
	/** `id` of the matched heading on the text page, or null when unmatched. */
	anchor: string | null;
	/** Closest structural heading above the article (e.g. "DISPOSICIONES TRANSITORIAS"). */
	section: string | null;
}

/**
 * Match citizen summaries to the article headings of rendered legal text.
 *
 * `pairs` is `[headingText, summary][]` for one norm, **in document order**.
 * `headingText` is the article heading as it appears in the legal text (e.g.
 * "Artículo 1." or "Primera."); an empty `summary` is a placeholder for a
 * block that has no summary but shares its heading text with one that does.
 *
 * Headings are walked in document order and each normalized heading consumes
 * the next pair queued under the same key. That keeps repeated headings apart
 * — e.g. "Primera." exists once under the disposiciones transitorias and again
 * under the adicionales — instead of stamping the first summary on both.
 *
 * Exact matches are resolved for the whole text first. Only then, for the
 * headings still unmatched, a word-boundary prefix match is tried (longest key
 * first) and finally the article number, so a bare title like "Artículo 14" still matches
 * a heading such as "Artículo 14. Igualdad ante la ley". Articles usually
 * render as h6 (markdown heading levels are shifted down by 1), but some texts
 * (treaties, tariffs) put them at h4/h5, so any h2–h6 heading may match.
 *
 * Returns the HTML (with notes injected when `inject` is true) and one item
 * per non-empty summary, in `pairs` order, carrying the matched anchor.
 */
export function matchArticleSummaries(
	html: string,
	pairs: Array<[string, string]> | undefined,
	options: { inject: boolean },
): { html: string; items: ArticleSummaryItem[] } {
	if (!pairs || pairs.length === 0) return { html, items: [] };

	// Queues of pair indexes, by full heading key and by article number. A pair
	// can sit in both; `used` makes sure it is consumed once.
	const byHeading = new Map<string, number[]>();
	const byArticle = new Map<string, number[]>();
	const push = (map: Map<string, number[]>, key: string, i: number) => {
		const q = map.get(key);
		if (q) q.push(i);
		else map.set(key, [i]);
	};
	pairs.forEach(([heading], i) => {
		const key = normKey(heading);
		if (!key) return;
		push(byHeading, key, i);
		const art = articleNumberKey(key);
		if (art) push(byArticle, art, i);
	});
	const used = new Uint8Array(pairs.length);
	const take = (q: number[] | undefined): number | undefined => {
		while (q && q.length > 0) {
			const i = q.shift()!;
			if (!used[i]) return i;
		}
		return undefined;
	};
	const hasFree = (q: number[] | undefined) => !!q?.some((i) => !used[i]);
	// Prefix fallback candidates, longest first (only keys with a real summary).
	const prefixKeys = [...byHeading.keys()]
		.filter((k) => byHeading.get(k)?.some((i) => pairs[i]?.[1]))
		.sort((a, b) => b.length - a.length);

	// Every heading, in document order.
	const headingRe = /<(h[2-6])([^>]*)>([\s\S]*?)<\/\1>/g;
	const heads: Array<{
		start: number;
		end: number;
		tag: string;
		attrs: string;
		inner: string;
		key: string;
		idx?: number;
	}> = [];
	for (const m of html.matchAll(headingRe)) {
		heads.push({
			start: m.index!,
			end: m.index! + m[0].length,
			tag: m[1]!,
			attrs: m[2]!,
			inner: m[3]!,
			key: normKey(plainText(m[3]!)),
		});
	}

	// Pass 1: exact headings only. Done over the whole text before any fallback
	// so that a fallback can never take a pair whose own heading appears later
	// (e.g. an unsummarized "Artículo 12." of one annex grabbing the summary of
	// the next annex's "Artículo 12.").
	for (const h of heads) {
		if (!h.key) continue;
		const idx = take(byHeading.get(h.key));
		if (idx !== undefined) {
			used[idx] = 1;
			h.idx = idx;
		}
	}
	// Pass 2, for what is left: word-boundary prefix ("Artículo 14" matches
	// "Artículo 14. Igualdad…"), then same article number with different
	// wording (the heading was renamed by a later reform).
	for (const h of heads) {
		if (h.idx !== undefined || !h.key) continue;
		let idx: number | undefined;
		for (const k of prefixKeys) {
			if (h.key.indexOf(k) !== 0) continue;
			const next = h.key.charAt(k.length);
			if (next !== " " && next !== "-") continue;
			if (hasFree(byHeading.get(k))) {
				idx = take(byHeading.get(k));
				break;
			}
		}
		if (idx === undefined) {
			const art = articleNumberKey(h.key);
			if (art) idx = take(byArticle.get(art));
		}
		if (idx !== undefined) {
			used[idx] = 1;
			h.idx = idx;
		}
	}

	const anchors: Array<string | null> = pairs.map(() => null);
	const sections: Array<string | null> = pairs.map(() => null);
	let section: string | null = null;
	let out = "";
	let last = 0;
	for (const h of heads) {
		if (h.idx === undefined) {
			// Not an article: a structural heading (título, capítulo, sección).
			if (h.key && h.tag !== "h6") section = plainText(h.inner) || section;
			continue;
		}
		const summary = pairs[h.idx]![1];
		if (!summary) continue;
		anchors[h.idx] = /\sid="([^"]+)"/.exec(h.attrs)?.[1] ?? null;
		sections[h.idx] = section;
		if (options.inject) {
			out += html.slice(last, h.end) + renderArticleSummary(summary);
			last = h.end;
		}
	}
	out += html.slice(last);

	const items: ArticleSummaryItem[] = [];
	pairs.forEach(([heading, summary], i) => {
		if (!summary) return;
		items.push({
			heading,
			summary,
			anchor: anchors[i]!,
			section: sections[i]!,
		});
	});
	return { html: options.inject ? out : html, items };
}

/** Inject visible summary notes after their matching article headings. */
export function bakeArticleSummaries(
	html: string,
	pairs: Array<[string, string]> | undefined,
): string {
	return matchArticleSummaries(html, pairs, { inject: true }).html;
}

const ORDINAL_HEADING =
	/^(primer[ao]?|segund[ao]|tercer[ao]?|cuart[ao]|quint[ao]|sext[ao]|s[ée]ptim[ao]|octav[ao]|noven[ao]|d[ée]cim[ao]|und[ée]cim[ao]|duod[ée]cim[ao]|d[ée]cimo?\s*\S+|vig[ée]sim[ao].*|[úu]nic[ao])$/i;

function sentenceCase(s: string): string {
	const lower = s.toLocaleLowerCase("es");
	return lower.charAt(0).toLocaleUpperCase("es") + lower.slice(1);
}

/**
 * Short, readable label for an article in the "Artículo por artículo" list:
 * "Artículo 14. Igualdad ante la ley." → "Artículo 14 — Igualdad ante la ley";
 * a bare ordinal under a disposiciones section ("Primera." under
 * "DISPOSICIONES TRANSITORIAS") → "Disposiciones transitorias — Primera".
 */
export function articleLabel(heading: string, section: string | null): string {
	const h = heading.replace(/\s+/g, " ").trim();
	const m =
		/^(?:Art[íi]culo|Art\.?)\s+([\p{L}\d]+(?:\s+(?:bis|ter|quater|quinquies|sexies|septies|octies|novies|decies))?(?:\.\d+)*)(?:\.?\s*[ºª])?\.?\s*(.*)$/iu.exec(
			h,
		);
	if (m) {
		const art = `Artículo ${m[1]}`;
		const rest = m[2]!.replace(/\.$/, "").trim();
		return rest ? `${art} — ${rest}` : art;
	}
	const bare = h.replace(/\.$/, "").trim();
	if (section && ORDINAL_HEADING.test(bare)) {
		return `${sentenceCase(section)} — ${bare}`;
	}
	const d = /^(.+?)\.\s+(.+?)\.?$/.exec(h);
	if (d && /^(Disposici[óo]n|Anexo)\b/i.test(d[1]!)) return `${d[1]} — ${d[2]}`;
	return bare;
}
