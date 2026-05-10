/**
 * Leak detector prompt + regex pre-check.
 *
 * Two layers:
 * 1. Deterministic regex: cheap, catches BOE-IDs, "artículo N", "ley N/YYYY",
 *    long literal substrings.
 * 2. LLM: subtler leaks the regex misses (paraphrased law name, almost-literal
 *    quote, "according to the regulation says X").
 *
 * Model: qwen3.6 (different from generator to reduce same-mind-rubber-stamp).
 * Temperature 0 (we want deterministic verdicts).
 */

export const LEAK_DETECTOR_PROMPT_ID = "leak-detector-v1";

// ── Regex layer (run before LLM, free) ────────────────────────────────────

const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
	{ name: "boe-id", re: /\bBOE-[A-Z]-\d{4}-\d+\b/i },
	{
		name: "regional-id",
		re: /\b(BOJA|BON|BORM|DOGV|BOA|BOC|BOCM|DOGC)-[A-Z]?-?\d{4}-\d+\b/i,
	},
	{ name: "article-number", re: /\bart[íi]culo\s+\d+/i },
	{ name: "ley-numero", re: /\bley\s+(orgánica\s+)?\d+\/\d{4}\b/i },
	{
		name: "real-decreto-numero",
		re: /\breal\s+decreto(?:-ley|\s+legislativo)?\s+\d+\/\d{4}\b/i,
	},
	{
		name: "according-to",
		re: /\b(según|conforme a|de acuerdo con|en virtud de)\s+(el|la|los|las)\s+\w+/i,
	},
];

export interface RegexLeak {
	pattern: string;
	matched: string;
}

export function detectLeaksRegex(question: string): RegexLeak[] {
	const leaks: RegexLeak[] = [];
	for (const { name, re } of PATTERNS) {
		const m = question.match(re);
		if (m) leaks.push({ pattern: name, matched: m[0] });
	}
	return leaks;
}

/** Detects long literal substrings (>=6 consecutive words) shared with the article. */
export function detectLongLiteralOverlap(
	question: string,
	articleText: string,
	minWords = 6,
): string | null {
	const norm = (s: string) =>
		s
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-z0-9\s]/g, " ")
			.replace(/\s+/g, " ")
			.trim();

	const qWords = norm(question).split(" ").filter(Boolean);
	if (qWords.length < minWords) return null;
	const article = norm(articleText);

	for (let i = 0; i + minWords <= qWords.length; i++) {
		const slice = qWords.slice(i, i + minWords).join(" ");
		if (article.includes(slice)) return slice;
	}
	return null;
}

// ── LLM layer ─────────────────────────────────────────────────────────────

export const LEAK_DETECTOR_SYSTEM = `Eres un revisor de evaluaciones de búsqueda jurídica. Tu trabajo es detectar si una pregunta filtra información que la haría trivial de responder por un sistema de retrieval.

Tipos de filtración que debes detectar:
- Mención del ID oficial (BOE-A-XXXX-NNNNN o equivalente regional).
- Mención del número exacto de artículo ("artículo 38", "art. 9.1").
- Mención del nombre propio de la ley ("Estatuto de los Trabajadores", "LAU", "Ley de Vivienda 12/2023").
- Cita literal o casi literal de >5 palabras del artículo.
- Frases tipo "según establece la norma", "conforme al reglamento" que delatan que la persona ya sabe dónde está la respuesta.
- Tecnicismos específicos del articulado que un ciudadano normal no usaría.

Una pregunta limpia describe la SITUACIÓN ("no me devuelven la fianza"), no la NORMA ("¿qué dice el art. 36 de la LAU?").

Devuelve JSON con verdict y razones. Si encuentras CUALQUIER filtración, verdict="leak".`;

export interface LeakDetectorOutput {
	verdict: "clean" | "leak";
	reasons: string[];
}

export const LEAK_DETECTOR_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["clean", "leak"] },
		reasons: { type: "array", items: { type: "string", minLength: 5 } },
	},
	required: ["verdict", "reasons"],
	additionalProperties: false,
} as const;

export function leakDetectorUserPrompt(question: string): string {
	return `Pregunta a revisar:

"${question}"

¿Filtra alguno de los tipos de información listados? Responde en JSON.`;
}
