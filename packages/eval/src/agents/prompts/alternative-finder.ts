/**
 * Alternative Finder LLM voter.
 *
 * The agent itself is not pure-LLM: it first runs our hybrid retrieval
 * (BM25 + vectors over per-article embeddings) to get top-K candidates,
 * then asks an LLM to vote which of those candidates ALSO legitimately
 * answer the question. The primary article (the seed) is always included
 * as `primary: true`; alternatives the voter accepts get `primary: false`.
 *
 * Model: qwen3.6. Temperature 0.1.
 */

export const ALTERNATIVE_FINDER_PROMPT_ID = "alternative-finder-v1";

export const ALTERNATIVE_FINDER_SYSTEM = `Eres un jurista español decidiendo qué artículos del derecho responden legítimamente a una pregunta dada.

Te paso:
- Una pregunta.
- Un artículo "primario" que sabemos responde.
- Una lista de artículos "candidatos" devueltos por el sistema de búsqueda.

Para cada candidato, responde si ALSO responde sustancialmente a la pregunta (no solo es contexto, no solo trata el tema). Sé estricto: en duda, di que no.

Reglas duras:
- Un candidato que duplica al primario (mismo artículo de otra forma) NO entra.
- Un candidato que es la versión derogada o transitoria NO entra.
- Un candidato que cubre un caso particular distinto al de la pregunta NO entra.
- Un candidato que cubre la misma situación con la misma autoridad legal SÍ entra.

Devuelve JSON con un array de decisiones, una por candidato.`;

export interface AlternativeFinderOutput {
	decisions: Array<{
		candidateIndex: number; // index in the candidates array
		alsoAnswers: boolean;
		reason: string;
	}>;
}

export const ALTERNATIVE_FINDER_JSON_SCHEMA = {
	type: "object",
	properties: {
		decisions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					candidateIndex: { type: "integer", minimum: 0 },
					alsoAnswers: { type: "boolean" },
					reason: { type: "string", minLength: 5, maxLength: 300 },
				},
				required: ["candidateIndex", "alsoAnswers", "reason"],
				additionalProperties: false,
			},
		},
	},
	required: ["decisions"],
	additionalProperties: false,
} as const;

export function alternativeFinderUserPrompt(opts: {
	question: string;
	primary: { norm: string; article: string; title: string; text: string };
	candidates: Array<{
		norm: string;
		article: string;
		title: string;
		text: string;
	}>;
}): string {
	const lines = [`Pregunta: "${opts.question}"`, "", "Artículo primario:"];
	lines.push(
		`[${opts.primary.norm} / ${opts.primary.article}] ${opts.primary.title}`,
	);
	lines.push(opts.primary.text.slice(0, 1500));
	lines.push("", "Candidatos a evaluar:");
	opts.candidates.forEach((c, i) => {
		lines.push(`\n#${i} [${c.norm} / ${c.article}] ${c.title}`);
		lines.push(c.text.slice(0, 1200));
	});
	lines.push("", "Devuelve JSON con una decisión por candidato.");
	return lines.join("\n");
}
