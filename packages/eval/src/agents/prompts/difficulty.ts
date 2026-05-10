/**
 * Difficulty scorer.
 *
 * Tags an accepted question as easy / medium / hard. Used downstream to:
 * - Stratify retrieval evals (e.g. R@5 on hard questions specifically).
 * - Identify regressions concentrated in one bucket.
 *
 * Model: qwen3.6. Temperature 0.1.
 */

export const DIFFICULTY_PROMPT_ID = "difficulty-v1";

export const DIFFICULTY_SYSTEM = `Etiquetas la dificultad de una pregunta para un sistema de retrieval jurídico que combina BM25 y embeddings semánticos sobre el corpus del derecho español.

Criterios:
- "easy": las palabras clave de la pregunta aparecen literalmente en el artículo correcto. Un BM25 honesto la resolvería.
- "medium": la pregunta usa lenguaje natural distinto del articulado pero conceptualmente cercano. Necesita embeddings o sinónimos.
- "hard": la pregunta requiere salto conceptual: el usuario describe un síntoma y la respuesta está en una norma cuyo título no es obvio, o requiere combinar varios artículos, o el área legal correcta no es evidente del enunciado.

Devuelve JSON con difficulty y razón breve.`;

export interface DifficultyOutput {
	difficulty: "easy" | "medium" | "hard";
	reason: string;
}

export const DIFFICULTY_JSON_SCHEMA = {
	type: "object",
	properties: {
		difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
		reason: { type: "string", minLength: 10, maxLength: 200 },
	},
	required: ["difficulty", "reason"],
	additionalProperties: false,
} as const;

export function difficultyUserPrompt(opts: {
	question: string;
	expectedArticles: Array<{
		norm: string;
		article: string;
		title?: string;
		text?: string;
	}>;
}): string {
	const lines = [
		`Pregunta: "${opts.question}"`,
		"",
		"Artículo(s) que responden:",
	];
	for (const a of opts.expectedArticles) {
		lines.push(`- ${a.norm} / ${a.article}: ${a.title ?? ""}`);
		if (a.text) lines.push(`  ${a.text.slice(0, 800)}`);
	}
	return lines.join("\n");
}
