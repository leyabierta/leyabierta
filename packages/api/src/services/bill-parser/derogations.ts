/**
 * Bill Parser — derogation (repeal) extraction.
 *
 * Architecture:
 * - Structural detection (findDerogatorySections, splitIntoItems) uses regex
 *   — these patterns follow the Directrices de Tecnica Normativa and are stable.
 * - Semantic extraction uses LLM structured output when an API key is available.
 * - A simplified regex fallback handles the most common patterns (~60% of cases).
 */

import { extractDerogationsWithLLM } from "./llm.ts";
import type { Derogation } from "./types.ts";
import { buildQuotedRanges, isInsideQuotedBlock } from "./utils.ts";

// ── Generic clause patterns (skip these) ──

const GENERIC_CLAUSE_RE =
	/cuantas?\s+disposiciones?\s+(?:de\s+igual\s+o\s+inferior\s+rango|contrarias?|que\s+se\s+opongan)/i;

/** Detects a specific law reference (Ley N/YYYY, Real Decreto, etc.) */
const SPECIFIC_LAW_RE =
	/(?:Ley\s+(?:Orgánica\s+)?\d+\/\d{4}|Real\s+Decreto(?:-[Ll]ey)?\s+\d+\/\d{4}|texto\s+refundido)/i;

// ── Section extraction ──

/**
 * Find all "Disposición derogatoria" sections in the text.
 * Returns an array of section texts (one per derogatoria).
 */
export function findDerogatorySections(text: string): string[] {
	const quotedRanges = buildQuotedRanges(text);
	const sections: string[] = [];

	// Match "Disposición derogatoria única/primera/segunda/etc."
	// Can appear after \n or at start of line in PDF text
	const headerRegex = /(?:^|\n)Disposición derogatoria ([\p{L}\d]+)\./gu;

	const headers: Array<{ startIndex: number }> = [];
	for (const match of text.matchAll(headerRegex)) {
		// Adjust startIndex to skip the leading \n if present
		const idx = text[match.index!] === "\n" ? match.index! + 1 : match.index!;
		if (isInsideQuotedBlock(idx, quotedRanges)) continue;
		headers.push({ startIndex: idx });
	}

	if (headers.length === 0) return [];

	// Find boundaries: next "Disposición" header (any kind) or "Artículo" or end of text
	const boundaryRegex =
		/\n(?:Disposición (?:final|transitoria|derogatoria|adicional) [\p{L}\d]+\.|Artículo [\p{L}\d]+\.)/gu;
	const boundaries: number[] = [];
	for (const match of text.matchAll(boundaryRegex)) {
		boundaries.push(match.index!);
	}
	boundaries.push(text.length);

	for (const header of headers) {
		const nextBoundary = boundaries.find((b) => b > header.startIndex + 10);
		if (!nextBoundary) continue;
		sections.push(text.slice(header.startIndex, nextBoundary));
	}

	return sections;
}

/** Split a derogatoria section into individual items. */
export function splitIntoItems(section: string): string[] {
	// Remove the header line (including optional subtitle like "Normas derogadas.")
	// Use [^\S\n] (whitespace except newline) to avoid consuming into the next line.
	const body = section.replace(
		/^Disposición derogatoria [\p{L}\d]+\.[^\S\n]*[^\n]*\n?/u,
		"",
	);

	// Try numbered items: "1. ...", "2. ..."
	// Prepend \n so that a body starting with "1. ..." is matched by the split regex
	const numberedItems = `\n${body}`.split(/\n\s*(\d+)\.\s+/);
	if (numberedItems.length > 2) {
		// numberedItems: ["preamble", "1", "text1", "2", "text2", ...]
		const items: string[] = [];
		for (let i = 1; i < numberedItems.length; i += 2) {
			const itemText = numberedItems[i + 1];
			if (itemText) items.push(itemText.trim());
		}
		if (items.length > 0) return items;
	}

	// Try lettered items directly: "a) ...", "b) ..."
	const letteredParts = body.split(/(?:^|\n)\s*[a-z]\)\s+/);
	if (letteredParts.length > 1) {
		const items = letteredParts
			.slice(1)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (items.length > 0) return items;
	}

	// No sub-items: return the whole body as one item
	return [body.trim()].filter((s) => s.length > 0);
}

// ── Main extraction ──

/**
 * Extract derogations from bill text.
 * Uses LLM structured output when an API key is available; falls back to
 * simplified regex patterns for the most common derogation forms.
 */
export async function extractDerogations(
	text: string,
	apiKey?: string,
): Promise<Derogation[]> {
	// 1. Find derogation sections (regex — structural, stable)
	const sections = findDerogatorySections(text);
	if (sections.length === 0) return [];

	// 2. LLM extraction (if apiKey available)
	if (apiKey) {
		const llmResults = await extractDerogationsWithLLM(apiKey, sections);
		return llmResults.map((d) => ({
			text: findMatchingText(sections, d.target_law),
			targetLaw: d.target_law,
			scope: d.scope,
			targetProvisions: d.target_provisions,
		}));
	}

	// 3. Regex fallback (simplified — covers ~60% of cases)
	return extractDerogationsRegexFallback(sections);
}

/**
 * Find the original text snippet that mentions a target law.
 * Used to populate the `text` field of Derogation from LLM results.
 */
function findMatchingText(sections: string[], targetLaw: string): string {
	// Extract a short identifier from the law name (e.g., "18/2011")
	const idMatch = targetLaw.match(/\d+\/\d{4}/);
	if (idMatch) {
		for (const section of sections) {
			if (section.includes(idMatch[0])) {
				// Find the sentence containing the law reference
				const lines = section.split("\n");
				for (const line of lines) {
					if (line.includes(idMatch[0]) && line.trim().length > 20) {
						return line.trim();
					}
				}
			}
		}
	}
	// Fallback: return first section (truncated)
	return sections[0]?.slice(0, 500) ?? "";
}

// ── Simplified regex fallback ──

/**
 * Simplified regex fallback for derogation extraction.
 * Catches the most common patterns:
 * - "Se deroga[n] ... Ley N/YYYY"
 * - "Queda[n] derogad[oa]s ... Ley N/YYYY"
 * - "Se suprime[n] ... de la Ley N/YYYY"
 * - Standalone law references in lettered/numbered items
 */
function extractDerogationsRegexFallback(sections: string[]): Derogation[] {
	const derogations: Derogation[] = [];

	for (const section of sections) {
		const items = splitIntoItems(section);

		for (const item of items) {
			if (item.trim().length < 20) continue;
			if (GENERIC_CLAUSE_RE.test(item) && !SPECIFIC_LAW_RE.test(item)) continue;

			const text = item.replace(/\n/g, " ").trim();

			// Match law references: "Ley N/YYYY", "Real Decreto-ley N/YYYY", etc.
			const lawRefs = [
				...text.matchAll(
					/(?:la |el |del |los |las )?((?:Ley\s+Orgánica|Ley|Real\s+Decreto(?:-[Ll]ey)?|texto\s+refundido)\s+\d+\/\d{4}(?:,\s+de\s+\d+\s+de\s+\w+)?(?:,\s+[^,.]+)?)/gi,
				),
			];

			if (lawRefs.length === 0) {
				// Try short law names like "Código Penal" after derogation verbs
				const shortMatch = text.match(
					/(?:Se\s+(?:deroga[n]?|suprime[n]?)|Queda(?:n)?\s+derogad[oa]s?)\s+[\s\S]+?(?:de(?:l)?\s+)((?:Código|Estatuto|Reglamento)\s+[\w\s]+?)(?:\.\s*$|$)/i,
				);
				if (shortMatch) {
					const hasProvisions =
						/art[ií]culos?\s+\d|libro\s+\w|t[ií]tulo\s+\w/i.test(text);
					derogations.push({
						text,
						targetLaw: shortMatch[1]!.trim().replace(/\.$/, ""),
						scope: hasProvisions ? "partial" : "full",
						targetProvisions: hasProvisions
							? extractSimpleProvisions(text)
							: [],
					});
				}
				continue;
			}

			for (const ref of lawRefs) {
				const lawName = ref[1]!.trim().replace(/\.$/, "");
				// Check if provisions are mentioned BEFORE this law reference
				const beforeLaw = text.slice(0, ref.index ?? 0);
				const hasProvisions =
					/art[ií]culos?\s+[\d\w]/i.test(beforeLaw) ||
					/libro\s+[\w]/i.test(beforeLaw) ||
					/t[ií]tulo\s+[\w]/i.test(beforeLaw) ||
					/apartado\s+\d/i.test(beforeLaw) ||
					/disposici[oó]n\s+(?:adicional|final|transitoria)/i.test(beforeLaw);

				derogations.push({
					text,
					targetLaw: lawName,
					scope: hasProvisions ? "partial" : "full",
					targetProvisions: hasProvisions ? extractSimpleProvisions(text) : [],
				});
			}
		}
	}

	return derogations;
}

/** Extract simple provision references for the regex fallback. */
function extractSimpleProvisions(text: string): string[] {
	const provisions: string[] = [];

	const libroMatch = text.match(/libro\s+([\w]+)/i);
	if (libroMatch) provisions.push(`libro ${libroMatch[1]}`);

	const tituloMatch = text.match(/t[ií]tulo\s+([\w\s]+?)(?:\s+del?\s+)/i);
	if (tituloMatch) provisions.push(`título ${tituloMatch[1]!.trim()}`);

	const artMatch = text.match(
		/art[ií]culos?\s+([\d\w\s,.\-()yébis]+?)(?:\s+(?:de\s+(?:la |el )|del\s+))/i,
	);
	if (artMatch) {
		const raw = artMatch[1]!.replace(/\s+y\s+/g, ", ");
		for (const part of raw.split(/,\s*/)) {
			const trimmed = part.trim();
			if (trimmed) provisions.push(`artículo ${trimmed}`);
		}
	}

	return provisions;
}
