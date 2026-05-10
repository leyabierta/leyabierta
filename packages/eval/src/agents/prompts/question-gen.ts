/**
 * Question generator prompt.
 *
 * Given an article and a persona, writes one question as the persona would
 * actually type it. Citizen register = lowercase, no diacritics, no jargon,
 * how-would-you-Google-this. Formal register = grammatical, with question
 * marks, how-would-an-informed-citizen-write-this.
 *
 * Model: alternates qwen3.6 and gemma4 across calls (orchestrator decides).
 * Temperature 0.8 (diversity).
 */

export const QUESTION_GEN_PROMPT_ID = "question-gen-v1";

export const QUESTION_GEN_SYSTEM = `Eres un experto en cómo la gente real consulta dudas legales. Te dan un artículo del derecho español y una persona; escribes UNA pregunta que esa persona haría para llegar a este artículo.

Reglas duras (si las violas, la pregunta se descarta):
- NUNCA menciones el ID BOE, el número de artículo, el nombre exacto de la ley, ni cites más de 5 palabras literales del artículo.
- NUNCA digas "según el artículo X", "según la ley Y".
- La pregunta debe ser una pregunta REAL que esa persona haría: no un examen, no un encabezado.
- Si el registro es "citizen": minúsculas, sin tildes, sin signos de interrogación, jerga cero, como se teclea en Google.
- Si el registro es "formal": gramática correcta, signos de interrogación, registro de ciudadano informado pero NO de abogado.
- Una sola pregunta. Sin explicaciones. Sin contexto añadido.

Ejemplos correctos en cada registro:
- citizen: "no me devuelven la fianza del piso"
- citizen: "el casero quiere echarme de casa"
- formal: "¿Cuánto tiempo tiene el casero para devolverme la fianza?"
- formal: "¿Me puede subir el alquiler mi casero cuando quiera?"`;

export interface QuestionGenOutput {
	question: string;
	rationale: string; // por qué esta pregunta lleva al artículo
}

export const QUESTION_GEN_JSON_SCHEMA = {
	type: "object",
	properties: {
		question: { type: "string", minLength: 8, maxLength: 200 },
		rationale: { type: "string", minLength: 10, maxLength: 300 },
	},
	required: ["question", "rationale"],
	additionalProperties: false,
} as const;

export function questionGenUserPrompt(opts: {
	persona: { label: string; situation: string; register: "citizen" | "formal" };
	articleTitle: string;
	articleText: string;
	materia: string;
}): string {
	return `Persona: ${opts.persona.label}
Situación: ${opts.persona.situation}
Registro requerido: ${opts.persona.register}
Materia: ${opts.materia}

Artículo:
${opts.articleTitle}
${opts.articleText}

Escribe la pregunta que esta persona haría. Devuelve JSON con la pregunta y un rationale corto.`;
}
