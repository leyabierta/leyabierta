/**
 * Bill Parser — extracts modification structure from BOCG PDFs.
 *
 * Handles five strategies for group detection:
 * 1. Disposiciones finales with "Modificación de..." (LO 10/2022 pattern)
 * 2. "Artículo primero/segundo" with "Modificación de..." (LO 14/2022 pattern)
 * 3. "Artículo único" — with or without "Modificación" keyword (LO 1/2015, B-40-1)
 * 4. Disposiciones adicionales with modification keywords in body (Amnistía pattern)
 * 5. Catch-all: any section (DF, DA, Artículo) with mod keywords not caught above
 *
 * Priority: fiabilidad > coste > rendimiento.
 * The parser uses regex for ~99% of work (free, deterministic) and LLM structured
 * output as fallback for sections without ordinals (~$0.001/section).
 */

import type { BillType, ModificationGroup, ParsedBill } from "./types.ts";
import { extractBocgId, extractPublicationDate, extractTitle, extractTransitionalProvisions } from "./header.ts";
import { parseModifications, parseModificationsAsync } from "./classification.ts";
import { extractDFGroups, extractArticuloGroups, extractArticuloUnicoGroup, extractDAGroups, extractImplicitModGroups } from "./strategies.ts";
import { verifyWithLLM } from "./llm.ts";
import { buildQuotedRanges, deduplicateGroups } from "./utils.ts";
import { extractDerogations } from "./derogations.ts";
import { extractNewEntities } from "./entities.ts";

// ── Re-exports for backward compatibility ──

export { extractTextFromPdf } from "./pdf.ts";
export type { BillModification, BillType, Derogation, NewEntity, ModificationGroup, ParsedBill } from "./types.ts";

// ── Bill type classification ──

/**
 * Classify a bill based on its content structure:
 * - `amendment`: has modification groups but no/minimal articulado
 * - `new_law`: has substantial articulado but 0 modification groups
 * - `mixed`: has both (common for omnibus bills)
 */
export function classifyBillType(text: string, modificationGroups: ModificationGroup[]): BillType {
	const hasModifications = modificationGroups.length > 0;

	// Check for substantial articulado (articles before disposiciones)
	// Case-sensitive: structural headings use uppercase "Disposición"
	const dispMatch = text.search(
		/\nDisposición\s+(?:adicional|transitoria|derogatoria|final)\s/,
	);
	const articulado = dispMatch > 0 ? text.slice(0, dispMatch) : text;

	// Count numbered articles in the articulado
	const articleCount = [...articulado.matchAll(/\nArtículo\s+\d+(?:\s*(?:bis|ter))?\./gi)].length;
	const hasSubstantialArticulado = articleCount >= 3;

	// Check if the articulado is mostly «»-quoted text (modification instructions)
	const firstArticle = articulado.search(/\nArtículo\s+1\./i);
	let isMostlyQuoted = false;
	if (firstArticle > 0) {
		const body = articulado.slice(firstArticle);
		const ranges = buildQuotedRanges(body);
		const quotedChars = ranges.reduce((sum, [s, e]) => sum + (e - s), 0);
		isMostlyQuoted = quotedChars > body.length * 0.5;
	}

	// "Artículo único" bills: if they have modifications, they're amendments;
	// if they have no modifications, they create new rules (new_law).
	const hasArticuloUnico = /\bArtículo\s+único\b/i.test(articulado);

	const hasRealArticulado = hasSubstantialArticulado && !isMostlyQuoted && !hasArticuloUnico;

	if (hasModifications && hasRealArticulado) return "mixed";
	if (hasModifications) return "amendment";
	if (hasRealArticulado) return "new_law";

	// Fallback: if there's articulado text but no modifications, treat as new_law
	// This covers both numbered articles (articleCount >= 1) and "Artículo único"
	if (articulado.length > 2000 && (articleCount >= 1 || hasArticuloUnico)) return "new_law";

	return "amendment";
}

// ── Main parser ──

export async function parseBill(
	text: string,
	options?: { apiKey?: string },
): Promise<ParsedBill> {
	const bocgId = extractBocgId(text);
	const publicationDate = extractPublicationDate(text);
	const title = extractTitle(text);
	const transitionalProvisions = extractTransitionalProvisions(text);

	// Run all strategies and combine results
	let modificationGroups: ModificationGroup[] = [];

	// Strategy 1: Disposiciones finales with "Modificación de..." (LO 10/2022)
	const dfGroups = await extractDFGroups(text, options?.apiKey);
	modificationGroups.push(...dfGroups);

	// Strategy 2: "Artículo primero/segundo" with "Modificación de..." (LO 14/2022)
	const artGroups = await extractArticuloGroups(text, options?.apiKey);
	modificationGroups.push(...artGroups);

	// Strategy 3: "Artículo único" — with or without "Modificación" (LO 1/2015, B-40-1)
	const unicoGroups = await extractArticuloUnicoGroup(text, options?.apiKey);
	modificationGroups.push(...unicoGroups);

	// Strategy 4: Disposiciones adicionales with modification keywords (Amnistía pattern)
	const daGroups = await extractDAGroups(text, options?.apiKey);
	modificationGroups.push(...daGroups);

	// Strategy 5: Catch-all — any section with implicit modifications not caught above
	// Build ranges of already-found groups to avoid duplicates
	const existingRanges: Array<[number, number]> = [];
	for (const group of modificationGroups) {
		// Find approximate position of each group in the text
		const titleSnippet = group.title.slice(0, 40);
		const idx = text.indexOf(titleSnippet);
		if (idx >= 0) {
			// Estimate end as start + reasonable section size
			const nextSectionIdx = text.indexOf("\nDisposición ", idx + 100);
			const nextArticleIdx = text.indexOf("\nArtículo ", idx + 100);
			const end = Math.min(
				nextSectionIdx > 0 ? nextSectionIdx : text.length,
				nextArticleIdx > 0 ? nextArticleIdx : text.length,
			);
			existingRanges.push([idx, end]);
		}
	}
	const implicitGroups = await extractImplicitModGroups(text, existingRanges, options?.apiKey);
	modificationGroups.push(...implicitGroups);

	// Deduplicate groups with overlapping target laws
	modificationGroups = deduplicateGroups(modificationGroups);

	// Strategy 7: Last resort — bill title says "modificación" but no groups found
	// Some Serie B proposiciones use informal structure (no Artículos, no DFs)
	// with ordinals (Uno. Dos.) directly in the body after exposición de motivos
	if (modificationGroups.length === 0) {
		const titleMod = title.match(/modificación (?:de|del) (?:la |el |los |las )?(.+)/i)
			?? text.match(/Proposición de Ley de modificación (?:de|del) (?:la |el |los |las )?(.+?)(?:\.\n|\n(?:Present|Acuerdo))/is);
		if (titleMod) {
			const targetLaw = titleMod[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
			// Find body: after "Exposición de motivos" section ends, look for ordinals
			const bodyStart = text.search(/\n(?:Uno|Primero|1)\.\s/);
			if (bodyStart > 0) {
				const bodyText = text.slice(bodyStart);
				const modifications = options?.apiKey
					? await parseModificationsAsync(bodyText, options.apiKey)
					: parseModifications(bodyText);
				if (modifications.length > 0) {
					modificationGroups.push({
						title: `Modificación de ${targetLaw}`,
						targetLaw,
						modifications,
					});
				}
			}
		}
	}

	// Strategy 8: LLM verification — independent extraction to catch gaps
	if (options?.apiKey) {
		const llmGapGroups = await verifyWithLLM(text, modificationGroups, options.apiKey);
		if (llmGapGroups.length > 0) {
			modificationGroups.push(...llmGapGroups);
			modificationGroups = deduplicateGroups(modificationGroups);
		}
	}

	// Extract derogations (repealing provisions)
	const derogations = await extractDerogations(text, options?.apiKey);

	// Classify bill type based on content structure
	const billType = classifyBillType(text, modificationGroups);

	// Extract new entities created by the bill's main body
	// (requires API key for LLM extraction; returns [] without one)
	const newEntities = await extractNewEntities(text, options?.apiKey);

	return {
		bocgId,
		title,
		publicationDate,
		billType,
		modificationGroups,
		derogations,
		transitionalProvisions,
		newEntities,
		rawText: text,
	};
}
