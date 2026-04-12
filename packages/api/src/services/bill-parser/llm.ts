/**
 * Bill Parser — LLM fallback classification and verification.
 */

import { callOpenRouter } from "../openrouter.ts";
import type {
	BillModification,
	ModificationGroup,
	NewEntity,
} from "./types.ts";
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
		/^Artículo/i,
		/^Disposición/i,
		/Se modifica/i,
		/Modificación/i,
		/queda(?:n)?\s+redactad/i,
		/Se añade/i,
		/Se suprime/i,
		/Se introduce/i,
		/Se adiciona/i,
		/Se deroga/i,
		/Se crea/i,
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
			jsonSchema: {
				name: "bill_verification",
				schema: LLM_VERIFICATION_SCHEMA,
			},
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
			const sectionText = locateSection(
				text,
				llmLaw.section_in_bill,
				llmLaw.target_law,
			);
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

			console.log(
				`  [llm-verify] Gap detected: "${llmLaw.target_law}" in ${llmLaw.section_in_bill}`,
			);

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
export function locateSection(
	text: string,
	sectionRef: string | undefined,
	targetLaw: string,
): string | null {
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

// ── LLM derogation extraction ──

/** JSON Schema for structured derogation output */
export const LLM_DEROGATIONS_SCHEMA = {
	type: "object" as const,
	properties: {
		derogations: {
			type: "array" as const,
			items: {
				type: "object" as const,
				properties: {
					target_law: { type: "string" as const },
					scope: { type: "string" as const, enum: ["full", "partial"] },
					target_provisions: {
						type: "array" as const,
						items: { type: "string" as const },
					},
				},
				required: ["target_law", "scope", "target_provisions"] as const,
				additionalProperties: false,
			},
		},
	},
	required: ["derogations"] as const,
	additionalProperties: false,
};

/**
 * Extract derogations from raw derogatory section texts using LLM structured output.
 * Each section is the full text of a "Disposición derogatoria" section.
 */
export async function extractDerogationsWithLLM(
	apiKey: string,
	sectionTexts: string[],
): Promise<
	Array<{
		target_law: string;
		scope: "full" | "partial";
		target_provisions: string[];
	}>
> {
	const combinedText = sectionTexts.join("\n\n---\n\n").slice(0, 12000);

	try {
		const result = await callOpenRouter<{
			derogations: Array<{
				target_law: string;
				scope: "full" | "partial";
				target_provisions: string[];
			}>;
		}>(apiKey, {
			model: LLM_MODEL,
			messages: [
				{
					role: "system",
					content: `Eres un analizador de disposiciones derogatorias de proyectos de ley españoles.

Dado el texto de una o más disposiciones derogatorias, extrae CADA derogación específica:
- target_law: nombre completo de la ley derogada (e.g., "Ley Orgánica 10/1995, de 23 de noviembre, del Código Penal")
- scope: "full" si se deroga la ley entera, "partial" si se derogan artículos/títulos/libros específicos
- target_provisions: lista de provisiones específicas derogadas (e.g., ["libro III", "artículo 89", "artículo 295"])

IMPORTANTE:
- NO incluyas cláusulas genéricas como "cuantas disposiciones de igual o inferior rango se opongan..."
- Cada ley derogada es una entrada separada, incluso si aparecen en el mismo párrafo
- Si un párrafo deroga artículos de VARIAS leyes, crea una entrada por ley
- "Se suprime" dentro de una disposición derogatoria equivale a derogación parcial`,
				},
				{ role: "user", content: combinedText },
			],
			temperature: 0,
			maxTokens: 2000,
			jsonSchema: {
				name: "bill_derogations",
				schema: LLM_DEROGATIONS_SCHEMA,
			},
		});

		return result.data.derogations ?? [];
	} catch (err) {
		console.warn(`  [llm-derogations] Failed: ${err}`);
		return [];
	}
}

// ── LLM entity extraction ──

/** JSON Schema for structured entity output */
export const LLM_ENTITIES_SCHEMA = {
	type: "object" as const,
	properties: {
		entities: {
			type: "array" as const,
			items: {
				type: "object" as const,
				properties: {
					name: { type: "string" as const },
					entity_type: {
						type: "string" as const,
						enum: [
							"registro",
							"organo",
							"procedimiento",
							"derecho",
							"sistema",
							"otro",
						],
					},
					article: { type: "string" as const },
					description: { type: "string" as const },
				},
				required: ["name", "entity_type", "article", "description"] as const,
				additionalProperties: false,
			},
		},
	},
	required: ["entities"] as const,
	additionalProperties: false,
};

/**
 * Extract new entities from the articulado principal using LLM structured output.
 * Truncates to 15000 chars (~4K tokens) to stay within context limits.
 */
export async function extractEntitiesWithLLM(
	apiKey: string,
	articuladoText: string,
): Promise<NewEntity[]> {
	const truncated = articuladoText.slice(0, 15000);

	try {
		const result = await callOpenRouter<{
			entities: Array<{
				name: string;
				entity_type: string;
				article: string;
				description: string;
			}>;
		}>(apiKey, {
			model: LLM_MODEL,
			messages: [
				{
					role: "system",
					content: `Eres un analizador de proyectos de ley españoles. Dado el articulado principal de un proyecto de ley (el texto ANTES de las disposiciones adicionales/transitorias/derogatorias/finales), identifica las ENTIDADES NUEVAS que el proyecto crea.

Entidades nuevas son: registros, órganos, comisiones, sistemas informáticos, plataformas, procedimientos, derechos, o servicios que NO EXISTÍAN antes y que este proyecto crea por primera vez.

Para cada entidad:
- name: nombre propio de la entidad (e.g., "Carpeta Justicia", "Punto de Contacto Nacional")
- entity_type: tipo — "registro" | "organo" | "procedimiento" | "derecho" | "sistema" | "otro"
- article: artículo donde se define (e.g., "Artículo 5")
- description: descripción breve de qué es y para qué sirve (1-2 frases)

IMPORTANTE:
- Solo incluye entidades con NOMBRE PROPIO, no conceptos genéricos ("el procedimiento", "un registro")
- NO incluyas modificaciones a leyes existentes (eso va en las disposiciones finales)
- NO incluyas artículos que solo describen atributos de una entidad ya mencionada (e.g., "Composición", "Funcionamiento")
- Si el proyecto no crea ninguna entidad nueva, devuelve un array vacío`,
				},
				{ role: "user", content: truncated },
			],
			temperature: 0,
			maxTokens: 2000,
			jsonSchema: {
				name: "bill_entities",
				schema: LLM_ENTITIES_SCHEMA,
			},
		});

		return (result.data.entities ?? []).map((e) => ({
			name: e.name,
			entityType: (e.entity_type as NewEntity["entityType"]) || "otro",
			article: e.article,
			description: e.description,
		}));
	} catch (err) {
		console.warn(`  [llm-entities] Failed: ${err}`);
		return [];
	}
}
