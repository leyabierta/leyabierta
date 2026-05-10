/**
 * Self-critique prompt for the question generator.
 *
 * Run after the first generation pass with the SAME model that produced
 * the question (keeps coherence with the generator's vocabulary). The
 * model reads its own output, the article, and the persona register, and
 * decides whether the question filters distinctive terminology, is
 * unrealistic, or mismatches register. Output is a verdict + (optional)
 * rewrite.
 *
 * Temperature 0.2 (we want a stable judgment, with a small allowance for
 * a creative rewrite when needed).
 */

export const QUESTION_SELF_CRITIQUE_PROMPT_ID = "question-self-critique-v1";

export const QUESTION_SELF_CRITIQUE_SYSTEM = `Eres un revisor estricto de preguntas para un benchmark de búsqueda jurídica. Aquí tienes una pregunta que tú mismo has generado para el siguiente artículo. ¿Filtra terminología distintiva del artículo? ¿Es realista? ¿Coincide con el registro pedido (citizen|formal)? Si encuentras algún problema, devuelve una versión reescrita.

Reglas para tu juicio:
- "Filtración de terminología" = la pregunta usa una palabra o expresión técnica poco frecuente que aparece literalmente en el artículo (p.ej. "colchón de capital", "biocombustibles", "concurrencia competitiva", "régimen retributivo adicional", "académico correspondiente"). Eso convierte el retrieval en trivial.
- "Realismo" = la pregunta debe sonar como algo que la persona descrita teclearía de verdad. No un encabezado de examen, no una definición.
- "Registro" =
  · citizen: minúsculas, sin tildes, sin signos de interrogación, jerga cero, como se teclea en Google.
  · formal: gramática correcta, con signos de interrogación, registro de ciudadano informado pero no de abogado.
- Si la pregunta es correcta: verdict="ok", revised="" (cadena vacía), reason explica brevemente por qué pasa.
- Si tiene un problema arreglable: verdict="rewritten", revised=la versión corregida (manteniendo el mismo registro y tema), reason explica qué cambiaste.
- Si la pregunta no se puede salvar (depende inevitablemente de un tecnicismo, o el artículo no admite una pregunta natural en ese registro): verdict="irrecoverable", revised="", reason explica el motivo.

Devuelve SIEMPRE JSON válido con el esquema indicado.`;

export interface QuestionSelfCritiqueOutput {
	verdict: "ok" | "rewritten" | "irrecoverable";
	revised: string;
	reason: string;
}

export const QUESTION_SELF_CRITIQUE_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: {
			type: "string",
			enum: ["ok", "rewritten", "irrecoverable"],
		},
		revised: { type: "string", maxLength: 300 },
		reason: { type: "string", minLength: 5, maxLength: 300 },
	},
	required: ["verdict", "revised", "reason"],
	additionalProperties: false,
} as const;

export function questionSelfCritiqueUserPrompt(opts: {
	question: string;
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

Pregunta generada:
"${opts.question}"

Revísala con los criterios indicados y devuelve JSON {verdict, revised, reason}.`;
}
