/**
 * "Generated with AI" notice for reform headlines and summaries (YMYL: a
 * citizen must never mistake an AI summary for the official text).
 *
 * Pure TS so both the Worker (src/lib/reform-render.ts, server-side) and the
 * Astro pages can use it. The client-side fallback in
 * src/pages/cambios/reforma/index.astro (an `is:inline` script, which cannot
 * import) repeats `reformAiNoticeHtml` by hand — keep the two in sync.
 */

import { AI_SUMMARIES_EXPLAINER_HREF } from "./article-summaries.ts";
import { escapeHtml } from "./escape.ts";

/** Short label shown next to an AI-written headline. */
export const AI_BADGE_LABEL = "Resumen con IA";

/** Which AI-written parts a reform shows (the H1 falls back to the law title). */
function aiPartsLabel(hasHeadline: boolean, hasSummary: boolean): string {
	if (hasHeadline && hasSummary) return "El titular y el resumen";
	if (hasHeadline) return "El titular";
	return "El resumen";
}

/**
 * Notice under a reform's AI headline/summary, linking to the official
 * disposition on the BOE. Returns "" when the reform shows no AI text.
 */
export function reformAiNoticeHtml(opts: {
	hasHeadline: boolean;
	hasSummary: boolean;
	/** The disposition on the BOE (txt.php?id=<source_id>). */
	sourceUrl: string;
}): string {
	const { hasHeadline, hasSummary, sourceUrl } = opts;
	if (!hasHeadline && !hasSummary) return "";
	const plural = hasHeadline && hasSummary;
	return (
		'<p class="reforma-ai-note" id="aviso-ia">' +
		`${aiPartsLabel(hasHeadline, hasSummary)} ${plural ? "están generados" : "está generado"} con inteligencia artificial y ${plural ? "pueden" : "puede"} contener errores. ` +
		`Fuente oficial: <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">la disposición en el BOE ↗</a>. ` +
		`<a href="${AI_SUMMARIES_EXPLAINER_HREF}">Cómo los hacemos</a>.` +
		"</p>"
	);
}

/** Badge placed in the date row, next to the AI headline. */
export function reformAiBadgeHtml(): string {
	return `<a href="#aviso-ia" class="reforma-ai-badge">${AI_BADGE_LABEL}</a>`;
}
