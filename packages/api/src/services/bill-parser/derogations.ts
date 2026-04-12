/**
 * Bill Parser — derogation (repeal) extraction.
 *
 * Detects "Disposición derogatoria" sections in bill text and extracts
 * specific law derogations, skipping generic clauses like
 * "cuantas disposiciones de igual o inferior rango...".
 */

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
function findDerogatorySections(text: string): string[] {
	const quotedRanges = buildQuotedRanges(text);
	const sections: string[] = [];

	// Match "Disposición derogatoria única/primera/segunda/etc."
	// Can appear after \n or at start of line in PDF text
	const headerRegex =
		/(?:^|\n)Disposición derogatoria ([\p{L}\d]+)\./gu;

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

// ── Law name extraction patterns ──

/** Extract the law name from a derogation sentence. */
function extractLawName(sentence: string): string | null {
	// Match patterns like "la Ley 18/2011, de 5 de julio, reguladora del uso de..."
	// or "el Real Decreto 123/2020, de 1 de enero, por el que..."
	// or "la Ley Orgánica 3/2007, de 22 de marzo, para la igualdad..."
	// Stop at: "así como", "y todas las", end of sentence, or generic clause start
	const lawMatch = sentence.match(
		/(?:la |el |los |las )?((?:Ley\s+Orgánica|Ley|Real\s+Decreto(?:-[Ll]ey)?|Decreto(?:-[Ll]ey)?|texto\s+refundido|Código|Estatuto|Reglamento)\s+[\s\S]*?)(?:,?\s+así como|,?\s+y (?:todas|cuantas)|,?\s+y las demás|\.\s*$|\.\s*\n|$)/i,
	);
	if (lawMatch) {
		return lawMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
	}
	return null;
}

// ── Provision extraction for partial derogations ──

/** Extract specific provision references (artículos, apartados, etc.) */
function extractProvisions(sentence: string): string[] {
	const provisions: string[] = [];

	// Match "los artículos X, Y y Z" or "el artículo X"
	const artMatch = sentence.match(
		/(?:los\s+)?art[ií]culos?\s+([\d\w\s,\.yé]+?)(?:\s+de\s+(?:la |el ))/i,
	);
	if (artMatch) {
		// Split "1, 2, 3 y 4" into individual articles
		const raw = artMatch[1]!.replace(/\s+y\s+/g, ", ");
		for (const part of raw.split(/,\s*/)) {
			const trimmed = part.trim();
			if (trimmed) provisions.push(`artículo ${trimmed}`);
		}
		return provisions;
	}

	// Match "el apartado N del artículo M"
	const aptMatch = sentence.match(
		/(?:el\s+)?apartado\s+(\d+)\s+del\s+art[ií]culo\s+(\d+[\w]*)/i,
	);
	if (aptMatch) {
		provisions.push(`apartado ${aptMatch[1]} del artículo ${aptMatch[2]}`);
		return provisions;
	}

	// Match "la disposición adicional/final/transitoria X"
	const dispMatch = sentence.match(
		/(?:la\s+)?disposición\s+(adicional|final|transitoria)\s+([\p{L}\d]+)/iu,
	);
	if (dispMatch) {
		provisions.push(`disposición ${dispMatch[1]} ${dispMatch[2]}`);
		return provisions;
	}

	return provisions;
}

// ── Main extraction ──

/**
 * Extract derogations from bill text.
 * Finds "Disposición derogatoria" sections and parses specific derogation targets.
 */
export function extractDerogations(text: string): Derogation[] {
	const sections = findDerogatorySections(text);
	const derogations: Derogation[] = [];

	for (const section of sections) {
		// Split section into numbered items (1. ..., 2. ...) or lettered items (a) ..., b) ...)
		// If no numbered items, treat the whole section body as a single item
		const items = splitIntoItems(section);

		for (const item of items) {
			// Skip very short items (likely just headers or blank)
			if (item.trim().length < 20) continue;

			// If the item is PURELY generic (no specific law mentioned), skip
			if (GENERIC_CLAUSE_RE.test(item) && !SPECIFIC_LAW_RE.test(item)) continue;

			// Try to detect derogation patterns
			const derogation = parseDerogationItem(item);
			if (derogation) {
				derogations.push(derogation);
			}
		}
	}

	return derogations;
}

/** Split a derogatoria section into individual items. */
function splitIntoItems(section: string): string[] {
	// Remove the header line
	const body = section.replace(
		/^Disposición derogatoria [\p{L}\d]+\.\s*[^\n]*\n?/u,
		"",
	);

	// Try numbered items: "1. ...", "2. ..."
	const numberedItems = body.split(/\n\s*(\d+)\.\s+/);
	if (numberedItems.length > 2) {
		// numberedItems: ["preamble", "1", "text1", "2", "text2", ...]
		const items: string[] = [];
		for (let i = 1; i < numberedItems.length; i += 2) {
			const itemText = numberedItems[i + 1];
			if (itemText) items.push(itemText.trim());
		}
		if (items.length > 0) return items;
	}

	// Try lettered items: "a) ...", "b) ..."
	const letteredItems = body.split(/\n\s*[a-z]\)\s+/);
	if (letteredItems.length > 1) {
		return letteredItems.slice(1).map((s) => s.trim()).filter((s) => s.length > 0);
	}

	// No sub-items: return the whole body as one item
	return [body.trim()].filter((s) => s.length > 0);
}

/** Parse a single derogation item into a Derogation or null. */
function parseDerogationItem(item: string): Derogation | null {
	const text = item.replace(/\n/g, " ").trim();

	// Full derogation patterns
	const fullPatterns = [
		/(?:Se deroga[n]?|Queda(?:n)? derogada?s?)\s+(?:expresamente\s+|íntegramente\s+)?(?:la |el |los |las )?((?:Ley\s+Orgánica|Ley|Real\s+Decreto(?:-[Ll]ey)?|Decreto(?:-[Ll]ey)?|texto\s+refundido|Código|Estatuto|Reglamento)\s+[\s\S]+)/i,
	];

	// Partial derogation patterns (mentions specific articles/provisions)
	const partialIndicators =
		/(?:los\s+)?art[ií]culos?\s+\d|(?:el\s+)?apartado\s+\d|(?:la\s+)?disposición\s+(?:adicional|final|transitoria)/i;

	for (const pattern of fullPatterns) {
		const match = text.match(pattern);
		if (!match) continue;

		const lawTail = match[1]!;
		const isPartial = partialIndicators.test(text);

		if (isPartial) {
			// Partial derogation: extract provisions and law name
			const provisions = extractProvisions(text);
			const lawName = extractLawName(lawTail) ?? lawTail.replace(/\n/g, " ").trim().replace(/\.$/, "");

			return {
				text,
				targetLaw: lawName,
				scope: "partial",
				targetProvisions: provisions,
			};
		}

		// Full derogation
		const lawName = extractLawName(lawTail) ?? lawTail.replace(/\n/g, " ").trim().replace(/\.$/, "");

		return {
			text,
			targetLaw: lawName,
			scope: "full",
			targetProvisions: [],
		};
	}

	return null;
}
