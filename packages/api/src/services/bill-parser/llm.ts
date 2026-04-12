/**
 * Bill Parser — LLM fallback classification and verification.
 */

import { callOpenRouter } from "../openrouter.ts";
import type { BillModification, ModificationGroup } from "./types.ts";
import { findSectionBoundaries } from "./utils.ts";

// ── LLM constants ──

export const LLM_MODEL = "google/gemini-2.5-flash-lite";

/** JSON Schema for structured LLM output — guarantees valid JSON */
export const LLM_MODIFICATIONS_SCHEMA = {
	type: "object" as const,
	properties: {
		modifications: {
			type: "array" as const,
			items: {
				type: "object" as const,
				properties: {
					change_type: {
						type: "string" as const,
						enum: ["modify", "add", "delete", "renumber", "suppress_chapter"],
					},
					target_provision: { type: "string" as const },
				},
				required: ["change_type", "target_provision"],
				additionalProperties: false,
			},
		},
	},
	required: ["modifications"],
	additionalProperties: false,
};

/** JSON Schema for LLM verification response */
export const LLM_VERIFICATION_SCHEMA = {
	type: "object" as const,
	properties: {
		modified_laws: {
			type: "array" as const,
			items: {
				type: "object" as const,
				properties: {
					target_law: { type: "string" as const },
					section_in_bill: { type: "string" as const },
				},
				required: ["target_law", "section_in_bill"] as const,
				additionalProperties: false,
			},
		},
	},
	required: ["modified_laws"] as const,
	additionalProperties: false,
};

// ── LLM classification ──

export async function classifyWithLLM(
	apiKey: string,
	sectionText: string,
): Promise<BillModification[]> {
	const truncated = sectionText.slice(0, 6000); // ~1500 tokens
	try {
		const result = await callOpenRouter<{
			modifications: Array<{
				change_type: string;
				target_provision: string;
			}>;
		}>(apiKey, {
			model: LLM_MODEL,
			messages: [
				{
					role: "system",
					content: `Eres un parser de textos legislativos españoles. Extrae las modificaciones de esta sección legislativa.
Para cada modificación, indica:
- "change_type": "modify" | "add" | "delete" | "renumber" | "suppress_chapter"
- "target_provision": qué se modifica (ej: "párrafo m) del artículo 31 bis", "apartado 2 del artículo 83")
No incluyas texto del articulado, solo el tipo y target.`,
				},
				{ role: "user", content: truncated },
			],
			temperature: 0,
			maxTokens: 1000,
			jsonSchema: {
				name: "bill_modifications",
				schema: LLM_MODIFICATIONS_SCHEMA,
			},
		});
		return (result.data.modifications ?? []).map((m, i) => ({
			ordinal: `llm-${i + 1}`,
			changeType: (m.change_type as BillModification["changeType"]) || "modify",
			targetProvision: m.target_provision || "unknown",
			newText: extractQuotedTextForLLM(sectionText),
			sourceText: sectionText.slice(0, 500),
		}));
	} catch (err) {
		console.warn(`  [llm-fallback] Failed: ${err}`);
		return [];
	}
}

/** Local helper — extract quoted text for LLM results */
function extractQuotedTextForLLM(text: string): string {
	const quoted = text.match(/«([\s\S]*?)»/);
	return quoted ? quoted[1]!.trim() : "";
}

// ── LLM verification ──

/**
 * Extract a "skeleton" of the bill: headers + modification keywords with context.
 * Much smaller than the full text, enough for the LLM to identify all modified laws.
 */
export function extractBillSkeleton(text: string): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	const patterns = [
		/^Artículo/i, /^Disposición/i, /Se modifica/i, /Modificación/i,
		/queda(?:n)?\s+redactad/i, /Se añade/i, /Se suprime/i, /Se introduce/i,
		/Se adiciona/i, /Se deroga/i, /Se crea/i,
	];

	for (let i = 0; i < lines.length; i++) {
		if (patterns.some((p) => p.test(lines[i]!))) {
			kept.push(lines[i]!);
			if (i + 1 < lines.length) kept.push(lines[i + 1]!);
			kept.push("");
		}
	}

	return kept.join("\n").slice(0, 60_000);
}

/** Normalize a law name for fuzzy comparison */
export function normalizeLawName(name: string): string {
	return name
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/ley orgánica/g, "lo")
		.replace(/real decreto[- ]ley/g, "rdl")
		.replace(/real decreto legislativo/g, "rdl")
		.replace(/real decreto/g, "rd")
		.replace(/texto refundido de la /g, "")
		.replace(/texto refundido del /g, "")
		.replace(/,? de \d+ de \w+ de \d+/g, "")
		.replace(/[.,;:()"'«»]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Check if two law names refer to the same law */
export function lawNamesMatch(a: string, b: string): boolean {
	const na = normalizeLawName(a);
	const nb = normalizeLawName(b);
	if (na === nb) return true;

	// Check if significant words overlap (>50%)
	const wordsA = na.split(" ").filter((w) => w.length > 3);
	const wordsB = nb.split(" ").filter((w) => w.length > 3);
	if (wordsA.length === 0 || wordsB.length === 0) return false;

	const matchedAB = wordsA.filter((w) => nb.includes(w)).length;
	const matchedBA = wordsB.filter((w) => na.includes(w)).length;
	return matchedAB >= wordsA.length * 0.5 || matchedBA >= wordsB.length * 0.5;
}

/**
 * LLM verification: ask the LLM to independently list all laws the bill modifies.
 * For any law the LLM finds that the regex parser missed, try to locate and extract
 * the modifications from the bill text.
 */
export async function verifyWithLLM(
	text: string,
	existingGroups: ModificationGroup[],
	apiKey: string,
): Promise<ModificationGroup[]> {
	const skeleton = text.length > 30_000 ? extractBillSkeleton(text) : text;
	const gapGroups: ModificationGroup[] = [];

	// Import parseModificationsAsync lazily to avoid circular dependency
	const { parseModificationsAsync } = await import("./classification.ts");

	try {
		const result = await callOpenRouter<{
			modified_laws: Array<{ target_law: string; section_in_bill: string }>;
		}>(apiKey, {
			model: LLM_MODEL,
			messages: [
				{
					role: "system",
					content: `Eres un analista legislativo. Dado un proyecto de ley español (BOCG), lista TODAS las leyes que este proyecto modifica.

Incluye SOLO leyes que se modifican (Se modifica, quedan? redactado, Se añade, Se suprime).
NO incluyas leyes que solo se citan o referencian sin modificar.
NO incluyas la propia ley del proyecto.
NO incluyas directivas europeas ni tratados internacionales.

Para cada ley modificada indica:
- "target_law": nombre de la ley (ej: "Código Penal", "Ley 39/2015 de Procedimiento Administrativo")
- "section_in_bill": dónde aparece la modificación (ej: "DF cuarta", "DA primera", "Artículo 3")`,
				},
				{
					role: "user",
					content: `${text.length > 30_000 ? "Esqueleto estructural del proyecto de ley (headers y líneas de modificación):" : "Texto del proyecto de ley:"}\n\n${skeleton}`,
				},
			],
			temperature: 0,
			maxTokens: 4000,
			jsonSchema: { name: "bill_verification", schema: LLM_VERIFICATION_SCHEMA },
		});

		const llmLaws = result.data.modified_laws ?? [];
		const existingLawNames = existingGroups.map((g) => g.targetLaw);

		// Find laws the LLM found that the parser missed
		for (const llmLaw of llmLaws) {
			const alreadyFound = existingLawNames.some((name) =>
				lawNamesMatch(name, llmLaw.target_law),
			);
			if (alreadyFound) continue;

			// Locate the section in text
			const sectionText = locateSection(text, llmLaw.section_in_bill, llmLaw.target_law);
			if (!sectionText) continue;

			// Validate: the section must actually contain modification keywords
			// (the LLM sometimes confuses "cites law" with "modifies law")
			const firstChunk = sectionText.slice(0, 500);
			const hasModKeywords =
				/Se modifica[n]?\s+/i.test(firstChunk) ||
				/queda(?:n)?\s+(?:redactad|modificad)/i.test(firstChunk) ||
				/Se (?:añade|introduce|adiciona|suprime)[n]?\s/i.test(firstChunk) ||
				/Se crea[n]?\s/i.test(firstChunk);
			if (!hasModKeywords) continue;

			console.log(`  [llm-verify] Gap detected: "${llmLaw.target_law}" in ${llmLaw.section_in_bill}`);

			let modifications = await parseModificationsAsync(sectionText, apiKey);
			if (modifications.length === 0 && sectionText.length > 200) {
				modifications = await classifyWithLLM(apiKey, sectionText);
			}

			if (modifications.length > 0) {
				gapGroups.push({
					title: `${llmLaw.section_in_bill}. Modificación de ${llmLaw.target_law} (LLM-verified)`,
					targetLaw: llmLaw.target_law,
					modifications,
				});
			}
		}
	} catch (err) {
		console.log(`  [llm-verify] Verification failed: ${err}`);
	}

	return gapGroups;
}

/** Try to locate a section in the bill text by its identifier (e.g., "DF cuarta", "Artículo 3") */
export function locateSection(text: string, sectionRef: string | undefined, targetLaw: string): string | null {
	if (!sectionRef) sectionRef = "";
	const boundaries = findSectionBoundaries(text);

	// Try to find by section reference
	const patterns = [
		// "DF cuarta" → "Disposición final cuarta"
		sectionRef.replace(/^DF /i, "Disposición final "),
		// "DA primera" → "Disposición adicional primera"
		sectionRef.replace(/^DA /i, "Disposición adicional "),
		// "Artículo 3" → "Artículo 3."
		sectionRef.replace(/^(Artículo \d+)$/i, "$1."),
		// Direct match
		sectionRef,
	];

	for (const pattern of patterns) {
		const idx = text.indexOf(pattern);
		if (idx < 0) continue;

		const nextBoundary = boundaries.find((b) => b > idx + 10);
		if (!nextBoundary) continue;

		const section = text.slice(idx, nextBoundary);
		// Validate: section should reference the target law
		if (section.length > 100) return section;
	}

	// Fallback: search for the target law name near modification keywords
	const lawIdx = text.indexOf(targetLaw.slice(0, 30));
	if (lawIdx >= 0) {
		// Find the containing section
		const sectionStart = boundaries.filter((b) => b < lawIdx).pop() ?? 0;
		const sectionEnd = boundaries.find((b) => b > lawIdx + 10) ?? text.length;
		const section = text.slice(sectionStart, sectionEnd);
		if (section.length > 100 && section.length < 50_000) return section;
	}

	return null;
}
