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

/** Law type keywords used in regexes */
const LAW_TYPES =
	"Ley\\s+Orgánica|Ley|Real\\s+Decreto(?:-[Ll]ey)?|Decreto(?:-[Ll]ey)?|texto\\s+refundido|Código|Estatuto|Reglamento";

/** Extract the law name from a derogation sentence. */
function extractLawName(sentence: string): string | null {
	// Match patterns like "la Ley 18/2011, de 5 de julio, reguladora del uso de..."
	// or "el Real Decreto 123/2020, de 1 de enero, por el que..."
	// or "la Ley Orgánica 3/2007, de 22 de marzo, para la igualdad..."
	// Also match "del Código Penal" standalone references
	// Stop at: "así como", "y todas las", end of sentence, or generic clause start
	const lawMatch = sentence.match(
		new RegExp(
			`(?:la |el |los |las |del )?((?:${LAW_TYPES})\\s+[\\s\\S]*?)(?:,?\\s+así como|,?\\s+y (?:todas|cuantas)|,?\\s+y las demás|,?\\s+no obstante|\\.\\s*$|\\.\\s*\\n|$)`,
			"i",
		),
	);
	if (lawMatch) {
		return lawMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
	}
	return null;
}

// ── Provision extraction for partial derogations ──

/** Extract specific provision references (artículos, apartados, libros, títulos, etc.) */
function extractProvisions(sentence: string): string[] {
	const provisions: string[] = [];

	// Match "el libro III de la Ley..."
	const libroMatch = sentence.match(
		/(?:el\s+)?libro\s+([\w]+)(?:\s+de(?:l\s+libro\s+[\w]+\s+de)?\s+(?:la |el |del ))/i,
	);
	if (libroMatch) {
		provisions.push(`libro ${libroMatch[1]}`);
	}

	// Match "el título XIX bis del libro II de..." or "el título X de..."
	const tituloMatch = sentence.match(
		/(?:el\s+)?t[ií]tulo\s+([\w\s]+?)(?:\s+del?\s+(?:libro|la |el |los |las ))/i,
	);
	if (tituloMatch) {
		provisions.push(`título ${tituloMatch[1]!.trim()}`);
	}

	// Match "los artículos X, Y y Z" or "el artículo X" — including complex refs like "12.1.b)"
	const artMatch = sentence.match(
		/(?:los\s+)?art[ií]culos?\s+([\d\w\s,.\-()yébis]+?)(?:\s+(?:de\s+(?:la |el )|así como|y (?:el|la|las|los)\s+(?:número|disposición|apartado)))/i,
	);
	if (artMatch) {
		// Split "1, 2, 3 y 4" into individual articles
		const raw = artMatch[1]!.replace(/\s+y\s+/g, ", ");
		for (const part of raw.split(/,\s*/)) {
			const trimmed = part.trim();
			if (trimmed) provisions.push(`artículo ${trimmed}`);
		}
	}

	// Match "el número N del artículo M"
	const numMatch = sentence.match(
		/(?:el\s+)?número\s+(\d+)\s+del\s+art[ií]culo\s+(\d+[\w]*)/i,
	);
	if (numMatch) {
		provisions.push(`número ${numMatch[1]} del artículo ${numMatch[2]}`);
	}

	// Match "el apartado N del artículo M" or "en su apartado N"
	const aptMatch = sentence.match(
		/(?:el\s+)?apartado\s+(\d+)\s+del\s+art[ií]culo\s+(\d+[\w]*)/i,
	);
	if (aptMatch) {
		provisions.push(`apartado ${aptMatch[1]} del artículo ${aptMatch[2]}`);
	}

	// Match "las disposiciones adicionales octava, novena..."
	const dispPluralMatch = sentence.match(
		/(?:las\s+)?disposiciones\s+(adicional|final|transitoria)es?\s+([\p{L},\s\d]+?)(?:\s+(?:en\s+su|de\s+la|y\s+la\s+disposición))/iu,
	);
	if (dispPluralMatch) {
		const kind = dispPluralMatch[1]!;
		const raw = dispPluralMatch[2]!.replace(/\s+y\s+/g, ", ");
		for (const part of raw.split(/,\s*/)) {
			const trimmed = part.trim();
			if (trimmed) provisions.push(`disposición ${kind} ${trimmed}`);
		}
	}

	// Match "la disposición adicional/final/transitoria X"
	const dispMatch = sentence.match(
		/(?:la\s+)?disposición\s+(adicional|final|transitoria)\s+([\p{L}\d]+)/iu,
	);
	if (dispMatch) {
		provisions.push(`disposición ${dispMatch[1]} ${dispMatch[2]}`);
	}

	// Match "el segundo párrafo del artículo X"
	const parrafoMatch = sentence.match(
		/(?:el\s+)?([\p{L}]+)\s+párrafo\s+del\s+art[ií]culo\s+([\p{L}\d]+)/iu,
	);
	if (parrafoMatch) {
		provisions.push(`${parrafoMatch[1]} párrafo del artículo ${parrafoMatch[2]}`);
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

			// If the item is PURELY generic (no specific law mentioned), skip.
			// But keep items that have "expresamente:" since they may have been
			// split into sub-items already via expandLetteredSubItems.
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
		if (items.length > 0) {
			// Each numbered item might itself contain lettered sub-items.
			// Expand them inline.
			return items.flatMap(expandLetteredSubItems);
		}
	}

	// Try lettered items directly: "a) ...", "b) ..."
	const expandedFromLettered = expandLetteredSubItems(body);
	if (expandedFromLettered.length > 1) {
		return expandedFromLettered;
	}

	// Check for "expresamente:" or "en particular:" followed by content
	const expresamenteMatch = body.match(
		/^([\s\S]*?(?:expresamente|en particular)\s*:\s*)\n([\s\S]+)$/i,
	);
	if (expresamenteMatch) {
		const afterColon = expresamenteMatch[2]!;
		const expanded = expandLetteredSubItems(afterColon);
		if (expanded.length > 1) return expanded;
		// If no lettered items, return the whole after-colon text
		return [afterColon.trim()].filter((s) => s.length > 0);
	}

	// No sub-items: return the whole body as one item
	return [body.trim()].filter((s) => s.length > 0);
}

/**
 * If text contains lettered sub-items (a) ..., b) ...), split into them.
 * If the text starts with a preamble before the first letter, that preamble
 * is returned as the first item (only if it contains a specific law ref).
 * Sub-items after "expresamente:" are split individually.
 */
function expandLetteredSubItems(text: string): string[] {
	// Check for "expresamente:" or "en particular:" splitting the text
	const expresamenteMatch = text.match(
		/^([\s\S]*?(?:expresamente|en particular)\s*:\s*)\n([\s\S]+)$/i,
	);
	if (expresamenteMatch) {
		const afterColon = expresamenteMatch[2]!;
		// Split by lettered items — also match at start of string
		const letteredParts = afterColon.split(/(?:^|\n)\s*[a-z]\)\s+/);
		if (letteredParts.length > 1) {
			// First split element is text before "a)" — usually empty or whitespace
			const items = letteredParts.map((s) => s.trim()).filter((s) => s.length > 0);
			if (items.length > 0) return items;
		}
	}

	// Direct lettered items in the text
	const letteredParts = text.split(/(?:^|\n)\s*[a-z]\)\s+/);
	if (letteredParts.length > 1) {
		const preamble = letteredParts[0]!.trim();
		const items = letteredParts.slice(1).map((s) => s.trim()).filter((s) => s.length > 0);
		// Include preamble only if it has a specific derogation (not just generic clause)
		if (preamble.length > 20 && SPECIFIC_LAW_RE.test(preamble) && !GENERIC_CLAUSE_RE.test(preamble)) {
			return [preamble, ...items];
		}
		return items.length > 0 ? items : [text.trim()];
	}

	return [text.trim()];
}

/**
 * Indicators that the derogation targets specific provisions (partial).
 * Matches: artículos, apartados, libros, títulos, disposiciones, números, párrafos.
 */
const PARTIAL_INDICATORS =
	/(?:los\s+)?art[ií]culos?\s+[\d\w]|(?:el\s+)?apartado\s+\d|(?:el\s+)?número\s+\d|(?:el\s+)?libro\s+[\w]|(?:el\s+)?t[ií]tulo\s+[\w]|(?:las?\s+)?disposicion(?:es)?\s+(?:adicional|final|transitoria)|(?:el\s+)?[\p{L}]+\s+párrafo\s+del/iu;

/** Regex for derogation verbs: "Se deroga(n)", "Queda(n) derogado/a/os/as", "Se suprime(n)" */
const DEROG_VERB_RE =
	/(?:Se deroga[n]?|Queda(?:n)? derogad[oa]s?|Se suprime[n]?)/i;

/** Parse a single derogation item into a Derogation or null. */
function parseDerogationItem(item: string): Derogation | null {
	const text = item.replace(/\n/g, " ").trim();

	// ── Strategy 1: Verb + direct law name ──
	// "Se deroga la Ley X", "Queda derogado el Real Decreto Y"
	const directLawPattern = new RegExp(
		`(?:Se\\s+deroga[n]?|Queda(?:n)?\\s+derogad[oa]s?|Se\\s+suprime[n]?)\\s+(?:expresamente\\s+|íntegramente\\s+)?(?:la\\s+|el\\s+|los\\s+|las\\s+)?((?:${LAW_TYPES})\\s+[\\s\\S]+)`,
		"i",
	);
	const directMatch = text.match(directLawPattern);
	if (directMatch) {
		const lawTail = directMatch[1]!;
		const isPartial = PARTIAL_INDICATORS.test(text);
		const provisions = isPartial ? extractProvisions(text) : [];
		const lawName =
			extractLawName(lawTail) ??
			lawTail.replace(/\n/g, " ").trim().replace(/\.$/, "");
		return {
			text,
			targetLaw: lawName,
			scope: isPartial ? "partial" : "full",
			targetProvisions: provisions,
		};
	}

	// ── Strategy 2: Verb + provision + "de la Ley X" ──
	// "Se derogan los artículos 89, 295 de la Ley Orgánica 10/1995..."
	// "Queda derogado el libro III de la Ley Orgánica 10/1995..."
	// "Se suprime el título XIX bis del libro II del Código Penal."
	const provisionThenLaw = new RegExp(
		`(?:Se\\s+deroga[n]?|Queda(?:n)?\\s+derogad[oa]s?|Se\\s+suprime[n]?)\\s+(?:expresamente\\s+)?(?:la\\s+|el\\s+|los\\s+|las\\s+)?[\\s\\S]+?(?:de(?:l)?\\s+(?:la\\s+|el\\s+)?)((?:${LAW_TYPES})\\s+[\\s\\S]+)`,
		"i",
	);
	const provMatch = text.match(provisionThenLaw);
	if (provMatch) {
		const lawTail = provMatch[1]!;
		const provisions = extractProvisions(text);
		const lawName =
			extractLawName(lawTail) ??
			lawTail.replace(/\n/g, " ").trim().replace(/\.$/, "");
		return {
			text,
			targetLaw: lawName,
			scope: "partial",
			targetProvisions: provisions,
		};
	}

	// ── Strategy 3: Verb + provision referencing a short law name ──
	// "Se suprime el título XIX bis del libro II del Código Penal."
	// The law name here is just "Código Penal" without a number.
	const shortLawRef = new RegExp(
		`(?:Se\\s+deroga[n]?|Queda(?:n)?\\s+derogad[oa]s?|Se\\s+suprime[n]?)\\s+[\\s\\S]+?(?:de(?:l)?\\s+)((?:${LAW_TYPES})[\\s\\S]*?)(?:\\.\\s*$|$)`,
		"i",
	);
	const shortMatch = text.match(shortLawRef);
	if (shortMatch) {
		const provisions = extractProvisions(text);
		const lawName = shortMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
		return {
			text,
			targetLaw: lawName,
			scope: "partial",
			targetProvisions: provisions,
		};
	}

	// ── Strategy 4: No verb — lettered/numbered item in "expresamente:" list ──
	// Items like "Los artículos 31, 64... de la Ley 48/1960"
	// or "El artículo 166 de la Ley 13/1996"
	// These appear in lettered items after a generic clause + "expresamente:"
	if (!DEROG_VERB_RE.test(text) && SPECIFIC_LAW_RE.test(text)) {
		const provisions = extractProvisions(text);
		const lawName = extractLawName(text);
		if (lawName) {
			return {
				text,
				targetLaw: lawName,
				scope: provisions.length > 0 ? "partial" : "full",
				targetProvisions: provisions,
			};
		}
	}

	return null;
}
