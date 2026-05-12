/**
 * Persona generator prompt.
 *
 * Given a single article from a Spanish norm, produces 3 plausible citizens
 * who might run into this article in real life. Each persona has a register
 * (citizen vs formal) so downstream we can produce both kinds of questions
 * from the same seed.
 *
 * Model: qwen3.6 on NaN. Temperature 0.7 (we want diversity here).
 */

export const PERSONAS_PROMPT_ID = "personas-v2";

export const PERSONAS_SYSTEM = `Eres un redactor especializado en accesibilidad jurídica. Tu trabajo es imaginar personas reales que se toparían con un artículo concreto del derecho español en su vida cotidiana.

Reglas:
- Tres personas distintas, no variantes de la misma.
- Cada persona tiene una situación concreta (no "alguien que necesita información laboral", sino "Marta, autónoma con un cliente que no le paga desde hace 3 meses").
- Mezcla registros: al menos 1 persona "ciudadana" (busca en Google con palabras llanas, sin jerga) y al menos 1 "formal" (sabe lo que busca, redacta con corrección).
- Evita estereotipos discriminatorios. No inventes nombres con apellidos extranjeros como muletilla; usa nombres comunes españoles si pones nombre.
- No menciones nunca el ID BOE de la norma ni su nombre exacto.
- Cada persona DEBE tener un label específico y descriptivo, no genérico. Por ejemplo BIEN: "inquilina embarazada con riesgo de desahucio". MAL: "Persona 1", "Lucía", "Persona Formal".`;

export interface PersonaOutput {
	personas: Array<{
		label: string; // breve descripción, p.ej. "inquilino agobiado por subida del IPC"
		situation: string; // 2-3 frases describiendo el contexto concreto
		register: "citizen" | "formal";
	}>;
}

export const PERSONAS_JSON_SCHEMA = {
	type: "object",
	properties: {
		personas: {
			type: "array",
			minItems: 3,
			maxItems: 3,
			items: {
				type: "object",
				properties: {
					label: { type: "string", minLength: 5, maxLength: 80 },
					situation: { type: "string", minLength: 30, maxLength: 400 },
					register: { type: "string", enum: ["citizen", "formal"] },
				},
				required: ["label", "situation", "register"],
				additionalProperties: false,
			},
		},
	},
	required: ["personas"],
	additionalProperties: false,
} as const;

export function personasUserPrompt(opts: {
	normId: string;
	articleTitle: string;
	articleText: string;
	materia: string;
}): string {
	return `Materia: ${opts.materia}

Artículo (no incluyas ni el ID ni el título exactos en las personas):

${opts.articleTitle}

${opts.articleText}

Devuelve un JSON con 3 personas que podrían encontrarse con este artículo.`;
}
