/**
 * Bake per-article citizen summaries into rendered legal-text HTML.
 *
 * Article summaries used to be fetched client-side and shown as hover
 * tooltips, which left them invisible to search engines. This module injects
 * them at build time as collapsed <details> blocks right after each matching
 * article heading, so the summary text lives in the static HTML (crawlable)
 * while staying out of the way of the legal text until expanded.
 */

import { escapeHtml } from "./escape.ts";

/**
 * Normalize heading / summary-title text the same way the old client-side
 * annotator did, so build-time matching stays identical in behavior.
 */
export function normKey(s: string): string {
	return (
		s
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			// Map "." to a word boundary ("-") *before* the general strip so that
			// decimal articles keep their structure: "Art\u00edculo 1.1" \u2192 "articulo 1-1"
			// stays distinct from "Art\u00edculo 11" \u2192 "articulo 11" (otherwise both
			// collapse to "articulo 11" and one summary is silently dropped).
			.replace(/\./g, "-")
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/**
 * Inject citizen summaries after their matching article headings.
 *
 * `pairs` is `[articleTitle, summary][]` for one norm. A heading matches when
 * its normalized text starts with a summary title (longest title first) on a
 * word boundary — mirroring the previous client matcher. Articles render as
 * h5/h6 because the markdown heading levels are shifted down by 1.
 *
 * Fast path: most headings equal their article title verbatim, so an exact
 * Map lookup resolves them in O(1); only headings with trailing text fall back
 * to the longest-first prefix scan. This keeps large laws (e.g. the Código
 * Civil, ~2K articles) from degenerating into O(headings × titles).
 */
export function bakeArticleSummaries(
	html: string,
	pairs: Array<[string, string]> | undefined,
): string {
	if (!pairs || pairs.length === 0) return html;
	const entries = pairs
		.map(([title, summary]) => ({ key: normKey(title), summary }))
		.filter((e) => e.key.length > 0)
		.sort((a, b) => b.key.length - a.key.length);
	if (entries.length === 0) return html;

	// Exact-match index for the common case (first writer wins, matching the
	// prefix scan which stops at the first — longest — hit).
	const exact = new Map<string, string>();
	for (const e of entries) {
		if (!exact.has(e.key)) exact.set(e.key, e.summary);
	}

	return html.replace(
		/<(h[56])([^>]*)>([\s\S]*?)<\/\1>/g,
		(full, _tag, _attrs, inner) => {
			const text = normKey(String(inner).replace(/<[^>]+>/g, " "));
			if (!text) return full;
			let summary = exact.get(text);
			if (summary === undefined) {
				for (const e of entries) {
					if (text.indexOf(e.key) !== 0) continue;
					const next = text.charAt(e.key.length);
					if (!next || next === " " || next === "-") {
						summary = e.summary;
						break;
					}
				}
			}
			if (summary === undefined) return full;
			return (
				`${full}<details class="article-summary">` +
				`<summary class="article-summary-toggle">Ver resumen ciudadano</summary>` +
				`<div class="article-summary-body">` +
				`<span class="article-summary-kicker">En resumen</span>` +
				`<p class="article-summary-text">${escapeHtml(summary)}</p>` +
				`</div></details>`
			);
		},
	);
}
