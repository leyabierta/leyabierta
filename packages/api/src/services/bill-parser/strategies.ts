/**
 * Bill Parser — group detection strategies.
 *
 * Five strategies for detecting modification groups in BOCG bill text:
 * 1. Disposiciones finales with "Modificación de..." (LO 10/2022 pattern)
 * 2. "Artículo primero/segundo" with "Modificación de..." (LO 14/2022 pattern)
 * 3. "Artículo único" — with or without "Modificación" keyword (LO 1/2015, B-40-1)
 * 4. Disposiciones adicionales with modification keywords in body (Amnistía pattern)
 * 5. Catch-all: any section (DF, DA, Artículo) with mod keywords not caught above
 */

import {
	parseModifications,
	parseModificationsAsync,
} from "./classification.ts";
import { classifyWithLLM } from "./llm.ts";
import type { ModificationGroup } from "./types.ts";
import {
	buildQuotedRanges,
	findSectionBoundaries,
	isInsideQuotedBlock,
} from "./utils.ts";

// ── Strategy 1: Disposiciones finales with "Modificación de..." ──

export async function extractDFGroups(
	text: string,
	apiKey?: string,
): Promise<ModificationGroup[]> {
	const groups: ModificationGroup[] = [];

	// Match DF headers that mention modification
	// Broad lookahead: body can start with Se/Uno/Único/El/La/Los/Las/digit or next Disposición
	const dfHeaderRegex =
		/Disposición final ([\p{L}\d]+)\. (Modificación (?:de|del) [\s\S]+?)(?=\n(?:Se |Uno\.|Único\.|El |La |Los |Las |\d+\.\s|Disposición ))/gu;

	const quotedRanges = buildQuotedRanges(text);
	const headers: Array<{ title: string; startIndex: number }> = [];
	for (const match of text.matchAll(dfHeaderRegex)) {
		if (isInsideQuotedBlock(match.index!, quotedRanges)) continue;
		headers.push({
			title: match[0].split("\n")[0]!,
			startIndex: match.index!,
		});
	}

	// Find all disposición boundaries
	const anyDisposicionRegex =
		/\nDisposición (?:final|transitoria|derogatoria|adicional) [\p{L}\d]+\./gu;
	const boundaries: number[] = [];
	for (const match of text.matchAll(anyDisposicionRegex)) {
		boundaries.push(match.index!);
	}
	boundaries.push(text.length);

	for (const header of headers) {
		const nextBoundary = boundaries.find((b) => b > header.startIndex + 10);
		if (!nextBoundary) continue;

		const fullText = text.slice(header.startIndex, nextBoundary);

		// Extract target law
		const lawMatch = fullText.match(
			/Modificación (?:de|del) (?:la |el |los |las )?(.+?)(?:\.\n|\n(?:Se |Uno\.|Único\.|El |La |Los |Las |\d+\.\s))/s,
		);
		const targetLaw = lawMatch
			? lawMatch[1]!.replace(/\n/g, " ").trim()
			: header.title;

		let modifications = apiKey
			? await parseModificationsAsync(fullText, apiKey)
			: parseModifications(fullText);

		// LLM fallback: if no ordinals found but DF has content, use LLM
		if (modifications.length === 0 && apiKey && fullText.length > 200) {
			modifications = await classifyWithLLM(apiKey, fullText);
		}

		if (modifications.length > 0) {
			groups.push({
				title: header.title,
				targetLaw,
				modifications,
			});
		}
	}

	return groups;
}

// ── Strategy 2: "Artículo primero/segundo/etc. Modificación de..." ──

export async function extractArticuloGroups(
	text: string,
	apiKey?: string,
): Promise<ModificationGroup[]> {
	const groups: ModificationGroup[] = [];

	// Match "Artículo primero/segundo/1/2/etc. Modificación de..."
	// Broad lookahead covers all common body-start patterns
	const artHeaderRegex =
		/Artículo ([\p{L}\d]+)\. (Modificación (?:de|del) [\s\S]+?)(?=\n(?:Se |Uno\.|Único\.|El |La |Los |Las |\d+\.\s))/gu;

	const quotedRanges = buildQuotedRanges(text);
	const headers: Array<{
		title: string;
		targetLaw: string;
		startIndex: number;
	}> = [];

	for (const match of text.matchAll(artHeaderRegex)) {
		if (isInsideQuotedBlock(match.index!, quotedRanges)) continue;
		const lawMatch = match[2]!.match(
			/Modificación (?:de|del) (?:la |el |los |las )?(.+)/s,
		);
		headers.push({
			title: `Artículo ${match[1]!}. ${match[2]!.replace(/\n/g, " ").trim()}`,
			targetLaw: lawMatch
				? lawMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "")
				: match[2]!.replace(/\n/g, " ").trim(),
			startIndex: match.index!,
		});
	}

	if (headers.length === 0) return [];

	// Find boundaries: next "Artículo X." or "Disposición" or end
	const boundaryRegex =
		/\n(?:Artículo [\p{L}\d]+\.|Disposición (?:transitoria|derogatoria|final|adicional) [\p{L}\d]+\.)/gu;
	const boundaries: number[] = [];
	for (const match of text.matchAll(boundaryRegex)) {
		boundaries.push(match.index!);
	}
	boundaries.push(text.length);

	for (const header of headers) {
		const nextBoundary = boundaries.find((b) => b > header.startIndex + 10);
		if (!nextBoundary) continue;

		const fullText = text.slice(header.startIndex, nextBoundary);
		const modifications = apiKey
			? await parseModificationsAsync(fullText, apiKey)
			: parseModifications(fullText);

		if (modifications.length > 0) {
			groups.push({
				title: header.title,
				targetLaw: header.targetLaw,
				modifications,
			});
		}
	}

	return groups;
}

// ── Strategy 3: "Artículo único" ──

export async function extractArticuloUnicoGroup(
	text: string,
	apiKey?: string,
): Promise<ModificationGroup[]> {
	// Find "Artículo único." anywhere in text, but not inside «» quoted blocks
	const quotedRanges = buildQuotedRanges(text);
	const artUnicoMatch = text.match(/Artículo único\./);
	if (!artUnicoMatch) return [];
	if (isInsideQuotedBlock(artUnicoMatch.index!, quotedRanges)) return [];

	const artUnicoStart = artUnicoMatch.index!;

	// Find the end: first "Disposición" after the artículo único
	const disposicionMatch = text
		.slice(artUnicoStart + 20)
		.match(
			/\nDisposición (?:adicional|transitoria|derogatoria|final) [\p{L}\d]+\./u,
		);
	const endIndex = disposicionMatch
		? artUnicoStart + 20 + disposicionMatch.index!
		: text.length;

	const bodyText = text.slice(artUnicoStart, endIndex);

	// Check if the body contains modification keywords
	const hasModKeywords =
		/Se modifica|quedan? redactad|Se añade|Se introduce|Se adiciona|Se suprime|Se propone (?:la )?(?:adecuación|modificación)/i.test(
			bodyText,
		);
	if (!hasModKeywords) return [];

	// Extract target law name
	let targetLaw = "unknown";

	// Pattern a: "Artículo único. Modificación de la LO 10/1995..."
	const modTitleMatch = bodyText.match(
		/Artículo único\.\s+(Modificación (?:de|del) (?:la |el |los |las )?(.+?))(?:\.\n|\n(?:Se |Uno\.|Único\.|El |La |Los |Las |\d+\.\s))/s,
	);
	if (modTitleMatch) {
		targetLaw = modTitleMatch[2]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
	}

	// Pattern b: "Se modifican los siguientes artículos de la Ley X..."
	if (targetLaw === "unknown") {
		const seModMatch = bodyText.match(
			/Se modifica[n]?\s+(?:los siguientes (?:artículos|preceptos|apartados) (?:de|del) (?:la |el |los |las )?)?(.+?)(?:,|\.\n|\n(?:en los siguientes|como sigue|\d+\.\s|Uno\.))/s,
		);
		if (seModMatch) {
			targetLaw = seModMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
		}
	}

	// Pattern c: look for law name in "del artículo X de la [LEY]"
	if (targetLaw === "unknown") {
		const lawRefMatch = bodyText.match(
			/(?:del artículo|de la disposición) .+? (?:de|del) (?:la |el )(.+?)(?:\s+queda| que )/s,
		);
		if (lawRefMatch) {
			targetLaw = lawRefMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
		}
	}

	const title = modTitleMatch
		? `Artículo único. ${modTitleMatch[1]!.replace(/\n/g, " ").trim()}`
		: `Artículo único. Modificación de ${targetLaw}`;

	const modifications = apiKey
		? await parseModificationsAsync(bodyText, apiKey)
		: parseModifications(bodyText);

	if (modifications.length === 0) return [];

	return [
		{
			title,
			targetLaw,
			modifications,
		},
	];
}

// ── Strategy 4: Disposiciones adicionales with modification keywords ──

export async function extractDAGroups(
	text: string,
	apiKey?: string,
): Promise<ModificationGroup[]> {
	const groups: ModificationGroup[] = [];

	// Find all DA boundaries, excluding those inside «» quoted blocks
	const quotedRanges = buildQuotedRanges(text);
	const daHeaderRegex = /Disposición adicional ([\p{L}\d]+)\.\s+/gu;
	const headers: Array<{ ordinal: string; startIndex: number }> = [];
	for (const match of text.matchAll(daHeaderRegex)) {
		if (isInsideQuotedBlock(match.index!, quotedRanges)) continue;
		headers.push({ ordinal: match[1]!, startIndex: match.index! });
	}

	if (headers.length === 0) return [];

	// Find all section boundaries (any Disposición or Artículo)
	const boundaries = findSectionBoundaries(text);

	for (const header of headers) {
		const nextBoundary = boundaries.find((b) => b > header.startIndex + 10);
		if (!nextBoundary) continue;

		const fullText = text.slice(header.startIndex, nextBoundary);

		// Check if body contains modification keywords
		const hasModKeywords =
			/Se modifica|quedan? redactad|Se añade|Se introduce|Se adiciona/i.test(
				fullText,
			);
		if (!hasModKeywords) continue;

		// Extract target law from body
		const lawMatch = fullText.match(
			/(?:Se modifica[n]?\s+(?:el |la |los |las )?(?:artículo|apartado|párrafo|letra|número).+?(?:de|del) (?:la |el |los |las )?|(?:de|del) (?:la |el |los |las )?)(.+?)(?:,\s+que queda|\.\n|\n«)/s,
		);
		const targetLaw = lawMatch
			? lawMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "")
			: `DA ${header.ordinal}`;

		let modifications = apiKey
			? await parseModificationsAsync(fullText, apiKey)
			: parseModifications(fullText);

		// LLM fallback for DAs without ordinals
		if (modifications.length === 0 && apiKey && fullText.length > 200) {
			modifications = await classifyWithLLM(apiKey, fullText);
		}

		if (modifications.length > 0) {
			groups.push({
				title: `Disposición adicional ${header.ordinal}. Modificación de ${targetLaw}`,
				targetLaw,
				modifications,
			});
		}
	}

	return groups;
}

// ── Strategy 5: Catch-all — any section with implicit modifications ──

export async function extractImplicitModGroups(
	text: string,
	existingGroupRanges: Array<[number, number]>,
	apiKey?: string,
): Promise<ModificationGroup[]> {
	const groups: ModificationGroup[] = [];
	const boundaries = findSectionBoundaries(text);
	const quotedRanges = buildQuotedRanges(text);

	// Find Artículo and DF/DA section headers (exclude transitorias and derogatorias)
	const sectionRegex =
		/(?:^|\n)((?:Artículo [\p{L}\d]+|Disposición (?:final|adicional) [\p{L}\d]+)\.)\s+/gu;

	for (const match of text.matchAll(sectionRegex)) {
		const startIndex = match.index!;

		// Skip headers inside «» quoted blocks (proposed law text, not bill structure)
		if (isInsideQuotedBlock(startIndex, quotedRanges)) continue;

		// Skip if this range is already covered by a found group
		if (
			existingGroupRanges.some(([s, e]) => startIndex >= s && startIndex < e)
		) {
			continue;
		}

		const nextBoundary = boundaries.find((b) => b > startIndex + 10);
		if (!nextBoundary) continue;

		const fullText = text.slice(startIndex, nextBoundary);

		// Skip very short sections (boilerplate like "Entrada en vigor", "Título competencial")
		if (fullText.length < 150) continue;

		// Strict check: modification keywords must appear in the FIRST 500 chars
		// (not buried deep in article body text)
		const firstChunk = fullText.slice(0, 500);
		const hasModInHeader =
			/Se modifica[n]?\s+(?:el |la |los |las )?(?:artículo|apartado|párrafo|letra|número|disposición)/i.test(
				firstChunk,
			) ||
			/queda(?:n)?\s+(?:redactad|modificad)/i.test(firstChunk) ||
			/Se (?:añade|introduce|adiciona)[n]?\s/i.test(firstChunk) ||
			/Se suprime/i.test(firstChunk);

		if (!hasModInHeader) continue;

		// Must reference a specific external law (Ley, RD, Código, Estatuto, etc.)
		const referencesExternalLaw =
			/(?:Ley|Real Decreto|Código|Estatuto|Constitución|Reglamento|texto refundido)/i.test(
				fullText.slice(0, 1000),
			);
		if (!referencesExternalLaw) continue;

		// Extract target law
		const sectionTitle = match[1];
		let targetLaw = "unknown";

		// Check header for law name
		const titleLawMatch = fullText.match(
			/(?:Modificación|modificación) (?:de|del) (?:la |el |los |las )?(.+?)(?:\.\n|\n)/,
		);
		if (titleLawMatch) {
			targetLaw = titleLawMatch[1]!.replace(/\n/g, " ").trim();
		}

		// Check body for law reference
		if (targetLaw === "unknown") {
			const bodyLawMatch = fullText.match(
				/(?:de|del) (?:la |el |los |las )?((?:Ley|Real Decreto|texto refundido|Constitución|Reglamento|Código|Estatuto).+?)(?:,\s+(?:que|en |aprobad)|\.\n)/s,
			);
			if (bodyLawMatch) {
				targetLaw = bodyLawMatch[1]!
					.replace(/\n/g, " ")
					.trim()
					.replace(/\.$/, "");
			}
		}

		let modifications = apiKey
			? await parseModificationsAsync(fullText, apiKey)
			: parseModifications(fullText);

		// LLM fallback for sections with 0 mods
		if (modifications.length === 0 && apiKey && fullText.length > 200) {
			modifications = await classifyWithLLM(apiKey, fullText);
		}

		if (modifications.length > 0) {
			groups.push({
				title: `${sectionTitle} Modificación de ${targetLaw}`,
				targetLaw,
				modifications,
			});
		}
	}

	return groups;
}
