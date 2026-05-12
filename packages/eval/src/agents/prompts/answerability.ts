/**
 * Answerability checker prompt.
 *
 * Verifies that the seed article actually answers the generated question.
 * Without this, the generator can drift: the persona's situation triggers
 * tangential questions whose actual answer is in another article entirely.
 *
 * Model: gemma4 (cross-check with a different family from the generator).
 * Temperature 0.1.
 */

export const ANSWERABILITY_PROMPT_ID = "answerability-v1";

export const ANSWERABILITY_SYSTEM = `Eres un jurista español verificando si un artículo concreto del derecho español responde a una pregunta dada.

Reglas:
- "Responde" significa que el artículo contiene la respuesta sustantiva, no que sea tangencialmente relacionado.
- Si el artículo solo es contexto, marco general, definiciones, o trata el tema en abstracto sin resolver la pregunta concreta: NO responde.
- Si el artículo responde parcialmente (por ejemplo da el plazo pero no las excepciones), considera que SÍ responde a la pregunta principal.
- Si la pregunta es genérica y el artículo es un caso específico que ilustra la regla, considera que SÍ responde.
- Si te asalta la duda, prefiere "no" — un dataset con falsos positivos es peor que uno con menos preguntas.

Responde JSON con verdict ("answers" | "does-not-answer") y una razón breve.`;

export interface AnswerabilityOutput {
	verdict: "answers" | "does-not-answer";
	reason: string;
}

export const ANSWERABILITY_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["answers", "does-not-answer"] },
		reason: { type: "string", minLength: 10, maxLength: 300 },
	},
	required: ["verdict", "reason"],
	additionalProperties: false,
} as const;

export function answerabilityUserPrompt(opts: {
	question: string;
	articleTitle: string;
	articleText: string;
}): string {
	return `Pregunta: "${opts.question}"

Artículo:
${opts.articleTitle}
${opts.articleText}

¿El artículo responde sustancialmente a la pregunta?`;
}
