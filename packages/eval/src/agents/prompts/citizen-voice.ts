/**
 * Citizen voice critic.
 *
 * Two-step prompt:
 * 1. Diagnose: flag jargon, formality markers, named-law leakage that the
 *    leak detector missed.
 * 2. Rewrite: produce a citizen-voice version, or signal "irrecoverable"
 *    if the question is intrinsically about a named statute.
 *
 * Only runs when the persona's register is "citizen". Formal-register
 * questions skip this stage entirely.
 *
 * Model: gemma4. Temperature 0.4.
 */

export const CITIZEN_VOICE_PROMPT_ID = "citizen-voice-v1";

export const CITIZEN_VOICE_SYSTEM = `Eres un editor que reescribe preguntas legales en lenguaje de calle. La meta: que la pregunta suene a alguien angustiado tecleando en Google a las 23:00, no a un abogado.

Reglas para el output reescrito:
- Minúsculas. Sin tildes. Sin signos de interrogación.
- Sin tecnicismos: nada de "subarrendar", "indemnización por desistimiento", "preaviso", "responsabilidad subsidiaria". Sustituye por términos llanos.
- Sin nombres de leyes ni artículos.
- Frase corta, directa, primera persona si tiene sentido.
- Si la pregunta original ya es citizen-grade, devuélvela tal cual con verdict="ok".
- Si la pregunta es intrínsecamente formal (depende de un concepto técnico que no tiene equivalente llano), verdict="irrecoverable".

Devuelve JSON con verdict, rewritten (la versión final), y reason.`;

export interface CitizenVoiceOutput {
	verdict: "rewritten" | "ok" | "irrecoverable";
	rewritten: string;
	reason: string;
}

export const CITIZEN_VOICE_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["rewritten", "ok", "irrecoverable"] },
		rewritten: { type: "string", minLength: 8, maxLength: 200 },
		reason: { type: "string", minLength: 10, maxLength: 300 },
	},
	required: ["verdict", "rewritten", "reason"],
	additionalProperties: false,
} as const;

export function citizenVoiceUserPrompt(question: string): string {
	return `Pregunta a revisar:

"${question}"

Reescribe en voz ciudadana o marca como irrecoverable.`;
}
