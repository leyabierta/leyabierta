/**
 * Bill Parser — new entity extraction from the articulado principal.
 *
 * Isolates the articulado (text before Disposiciones) and delegates
 * entity detection to LLM structured output.
 */

import type { NewEntity } from "./types.ts";
import { extractEntitiesWithLLM } from "./llm.ts";

// ── Articulado isolation ──

/**
 * Isolate the articulado principal (before disposiciones).
 * Case-SENSITIVE: structural headings always use uppercase "Disposición".
 * Using /i would match lowercase "disposición" in body text, which truncates
 * the articulado before the real articles even start (see BOCG-14-A-94-1).
 */
function isolateArticulado(text: string): string | null {
	const dispMatch = text.search(
		/\nDisposición\s+(?:adicional|transitoria|derogatoria|final)\s/,
	);
	const articulado = dispMatch > 0 ? text.slice(0, dispMatch) : text;

	if (articulado.length < 500) return null;

	// If the articulado body (from first article to disposiciones) is tiny,
	// the bill has no real articulado principal (it's all modifications).
	const firstArticleMatch = articulado.search(/\nArtículo\s+1\./i);
	if (firstArticleMatch > 0 && dispMatch > 0) {
		const articuladoBody = text.slice(firstArticleMatch, dispMatch).trim();
		if (articuladoBody.length < 500) return null;
	}

	// Check if the articulado is predominantly «»-quoted text (modification instructions).
	// If >60% of the articulado body (after first article) is inside quotes, skip.
	if (firstArticleMatch > 0) {
		const body = articulado.slice(firstArticleMatch);
		const quotedChars = [...body.matchAll(/«[^»]*»/gs)].reduce(
			(sum, m) => sum + m[0].length,
			0,
		);
		if (quotedChars > body.length * 0.6) return null;
	}

	return articulado;
}

// ── Main extractor ──

/**
 * Extract new entities created by the bill's articulado principal.
 * Uses LLM structured output when an API key is available.
 * Without API key, returns an empty array.
 */
export async function extractNewEntities(text: string, apiKey?: string): Promise<NewEntity[]> {
	// 1. Isolate articulado principal (regex, deterministic)
	const articulado = isolateArticulado(text);
	if (!articulado) return [];

	// 2. "Artículo único" bills are almost always pure modification bills
	if (/\bArtículo\s+único\b/i.test(articulado)) return [];

	// 3. LLM extraction (requires API key)
	if (apiKey) {
		return extractEntitiesWithLLM(apiKey, articulado);
	}

	// 4. No fallback — return empty without API key
	return [];
}
