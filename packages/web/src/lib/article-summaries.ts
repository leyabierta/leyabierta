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
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Inject citizen summaries after their matching article headings.
 *
 * `pairs` is `[articleTitle, summary][]` for one norm. A heading matches when
 * its normalized text starts with a summary title (longest title first) on a
 * word boundary — mirroring the previous client matcher exactly. Articles
 * render as h5/h6 because the markdown heading levels are shifted down by 1.
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

	return html.replace(
		/<(h[56])([^>]*)>([\s\S]*?)<\/\1>/g,
		(full, _tag, _attrs, inner) => {
			const text = normKey(String(inner).replace(/<[^>]+>/g, " "));
			if (!text) return full;
			let matched: { key: string; summary: string } | null = null;
			for (const e of entries) {
				if (text.indexOf(e.key) !== 0) continue;
				const next = text.charAt(e.key.length);
				if (!next || next === " " || next === "-") {
					matched = e;
					break;
				}
			}
			if (!matched) return full;
			return (
				`${full}<details class="article-summary">` +
				`<summary class="article-summary-toggle">Ver resumen ciudadano</summary>` +
				`<div class="article-summary-body">` +
				`<span class="article-summary-kicker">En resumen</span>` +
				`<p class="article-summary-text">${escapeHtml(matched.summary)}</p>` +
				`</div></details>`
			);
		},
	);
}
