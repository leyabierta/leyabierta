import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import {
	PERSONAS_JSON_SCHEMA,
	PERSONAS_PROMPT_ID,
	PERSONAS_SYSTEM,
	type PersonaOutput,
	personasUserPrompt,
} from "./prompts/personas.ts";
import type { ArticleSeed, Persona, PersonaAgent } from "./types.ts";

const DEGENERATE_PATTERNS: RegExp[] = [
	// "Persona", "Persona 1", "Persona_2", "Persona-3"
	/^Persona[\s_-]?\d*$/i,
	// "Persona Formal", "Persona Ciudadana", "formal", "citizen"
	/^(Persona\s)?(Formal|Ciudadana|Ciudadano|formal|citizen)$/i,
	// Single capitalized word (e.g. "Lucía", "Marta") — likely just a first
	// name without descriptive context.
	/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+$/,
	// Too short to be descriptive (< 9 chars).
	/^.{1,8}$/,
];

/**
 * A well-formed persona string ends with a Spanish letter or a closing
 * punctuation mark (`.`, `!`, `?`, `…`, `)`, `"`, `»`). Strings that end
 * with anything else — control bytes, lone CJK characters from a
 * mid-multibyte truncation, dangling stems like "comunit" — are rejected.
 *
 * Examples of trailing garbage caught in the pilot 100 review:
 *   "...brig猛"  → ends in CJK, fails
 *   "...comunit" → ends in non-Spanish letter cluster (still fine on the
 *                  letter check), but bare consonant clusters that aren't
 *                  Spanish words are caught upstream by the LLM critic.
 *   "...序"       → CJK, fails
 */
const ENDS_WELL_RE = /[a-záéíóúñüÁÉÍÓÚÑÜ.!?…)"»]$/u;

export function isWellFormedPersonaText(s: string): boolean {
	const trimmed = s.trim();
	if (trimmed.length === 0) return false;
	return ENDS_WELL_RE.test(trimmed);
}

export function isDegeneratePersonaLabel(label: string): boolean {
	const trimmed = label.trim();
	for (const re of DEGENERATE_PATTERNS) {
		if (re.test(trimmed)) return true;
	}
	// UTF-8 truncation / non-letter trailing garbage.
	if (!isWellFormedPersonaText(trimmed)) return true;
	return false;
}

export function makePersonaAgent(
	llm: NanLlmClient,
	trace?: EvalTrace,
): PersonaAgent {
	return {
		async generate(seed: ArticleSeed): Promise<Persona[]> {
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await llm.complete<PersonaOutput>({
					systemPrompt: PERSONAS_SYSTEM,
					userPrompt: personasUserPrompt({
						normId: seed.normId,
						articleTitle: seed.articleTitle,
						articleText: seed.articleText,
						materia: seed.materia,
					}),
					jsonSchema: PERSONAS_JSON_SCHEMA as unknown as Record<
						string,
						unknown
					>,
					jsonSchemaName: PERSONAS_PROMPT_ID,
					temperature: attempt === 0 ? 0.7 : 0.85,
					maxTokens: 800,
					trace,
					spanName: "personas",
				});
				const filtered = result.value.personas.filter(
					(p) =>
						!isDegeneratePersonaLabel(p.label) &&
						isWellFormedPersonaText(p.situation),
				);
				if (filtered.length >= 1) return filtered;
			}
			throw new Error(
				"persona-generator: could not produce non-degenerate personas after 2 attempts",
			);
		},
	};
}
