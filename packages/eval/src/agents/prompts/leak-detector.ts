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

import { DOMAIN_INEVITABLE_BIGRAMS } from "./leak-detector-whitelist.ts";

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

/**
 * Tokenize for rare-term overlap analysis. Lowercases, strips diacritics,
 * splits on non-letter/digit characters, and keeps tokens with length
 * `>= minLength` (default 4) so we ignore stop words and short particles.
 */
export function tokenizeForRareOverlap(text: string, minLength = 4): string[] {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.filter((t) => t.length >= minLength);
}

/**
 * Detects rare-term lifting: tokens shared between the question and the
 * article whose corpus document-frequency falls below `rareThreshold`.
 *
 * `rareTermFrequency` maps token → fraction of articles in the corpus that
 * contain the token (0..1). Tokens absent from the map are treated as
 * extremely rare (frequency = 0), since an unseen token in a 5k sample
 * is by definition uncommon. If there are at least `minRareCooccurrence`
 * such overlaps (default 2), we consider it a leak.
 *
 * Returns the matched rare tokens (deduplicated), or null if below the
 * threshold.
 */
export function detectRareTermOverlap(
	question: string,
	articleText: string,
	rareTermFrequency: Map<string, number>,
	opts: { minRareCooccurrence?: number; rareThreshold?: number } = {},
): { matched: string[] } | null {
	const minRareCooccurrence = opts.minRareCooccurrence ?? 2;
	const rareThreshold = opts.rareThreshold ?? 0.005; // <0.5% of articles

	const qTokens = new Set(tokenizeForRareOverlap(question));
	if (qTokens.size === 0) return null;
	const aTokens = new Set(tokenizeForRareOverlap(articleText));

	const matched: string[] = [];
	for (const token of qTokens) {
		if (!aTokens.has(token)) continue;
		const freq = rareTermFrequency.get(token) ?? 0;
		if (freq < rareThreshold) matched.push(token);
	}

	if (matched.length < minRareCooccurrence) return null;
	return { matched };
}

// ── Bigram-substring overlap layer ────────────────────────────────────────

/**
 * Spanish stoplist for bigram tokenization. We drop these tokens BEFORE
 * forming bigrams, so "organización de productores" → bigram
 * "organizacion productores" (after stripping "de"). This mirrors how a
 * human reader would treat the phrase as a single multi-word concept.
 */
const BIGRAM_STOPLIST: ReadonlySet<string> = new Set([
	"el",
	"la",
	"los",
	"las",
	"un",
	"una",
	"de",
	"del",
	"en",
	"y",
	"o",
	"para",
	"por",
	"con",
	"sin",
	"sobre",
	"bajo",
	"ante",
	"entre",
	"contra",
	"durante",
	"segun",
	"mediante",
	"hasta",
	"hacia",
	"desde",
	"que",
	"como",
	"cuando",
	"donde",
	"lo",
	"le",
	"su",
	"sus",
	"mi",
	"mis",
	"este",
	"esta",
	"estos",
	"estas",
	"ese",
	"esa",
	"esos",
	"esas",
	"ya",
	"no",
	"si",
]);

/**
 * Tokenize for bigram overlap analysis. Lowercases, strips diacritics,
 * splits on non-letter/digit characters, drops tokens shorter than
 * `minLength` (default 3), and removes a small Spanish stoplist of
 * particles, articles, prepositions, and pronouns. The stoplist is
 * applied AFTER diacritic stripping (so "según" → "segun" is recognised).
 */
/**
 * Crude Spanish plural stemmer: collapses regular plurals onto their
 * singular form so "investigaciones clínicas" matches "investigación
 * clínica" after diacritic stripping. Only handles the two most common
 * patterns (-es and -s); irregulars are accepted as-is. The aim is
 * recall on collocation overlap, not linguistic correctness.
 */
function stemPlural(token: string): string {
	if (token.length > 5 && token.endsWith("es")) {
		const stem = token.slice(0, -2);
		// Avoid collisions where the stem turns into a stopword
		// (e.g. "antes" → "ante"). Keep the original surface form.
		if (BIGRAM_STOPLIST.has(stem)) return token;
		return stem;
	}
	if (token.length > 4 && token.endsWith("s")) {
		const stem = token.slice(0, -1);
		if (BIGRAM_STOPLIST.has(stem)) return token;
		return stem;
	}
	return token;
}

/**
 * Returns the FULL token stream (including stopwords). Stopwords are kept
 * here so the bigram builder can see the gaps between content tokens and
 * form skip-bigrams over them. Filtering happens inside `bigramSet`.
 */
export function tokenizeForBigramOverlap(
	text: string,
	minLength = 3,
): string[] {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.filter((t) => t.length >= minLength)
		.map(stemPlural);
}

/**
 * Build a set of bigrams over the content tokens, allowing at most one
 * stopword token between two content tokens (so "Fondo de mejora" yields
 * "fondo mejora"). Adjacent content-content pairs are also captured.
 *
 * Pure adjacent bigrams that contain a stopword are NOT emitted: those
 * tend to be noise like "fondo de", "de mejora" that match too eagerly.
 * The skip-bigram is the one that carries the collocational signal.
 */
function bigramSet(tokens: string[]): Set<string> {
	const set = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		const a = tokens[i]!;
		if (BIGRAM_STOPLIST.has(a)) continue;
		// Look at the next 1 or 2 positions; skip up to 1 stopword.
		for (let j = i + 1; j <= Math.min(i + 2, tokens.length - 1); j++) {
			const b = tokens[j]!;
			if (BIGRAM_STOPLIST.has(b)) continue;
			set.add(`${a} ${b}`);
			break;
		}
	}
	return set;
}

/**
 * Detects shared multi-word collocations (bigrams) between the question
 * and the source article. Single tokens are too noisy ("articulo",
 * "persona"), but consecutive 2-token sequences capture the kind of
 * domain-specific phrasing that makes a question trivially answerable
 * by lexical retrieval (e.g. "organizacion productores", "importe
 * recuperado", "investigacion clinica", "seleccion final").
 *
 * Returns the matched bigrams (deduplicated) if at least
 * `minOverlapBigrams` bigrams (default 2) are shared, else null.
 */
export function detectBigramOverlap(
	question: string,
	articleText: string,
	opts: {
		minOverlapBigrams?: number;
		minBigramFreqRatio?: number;
		/**
		 * Bigrams that count as "domain-inevitable" and should NOT contribute
		 * to the overlap count. Defaults to `DOMAIN_INEVITABLE_BIGRAMS`
		 * (data-driven, see leak-detector-whitelist.ts). Pass `new Set()` to
		 * disable the whitelist entirely (e.g. for legacy tests).
		 */
		whitelist?: ReadonlySet<string>;
	} = {},
): { matched: string[] } | null {
	const minOverlapBigrams = opts.minOverlapBigrams ?? 2;
	const whitelist = opts.whitelist ?? DOMAIN_INEVITABLE_BIGRAMS;
	// `minBigramFreqRatio` reserved for v2 corpus-frequency filtering;
	// v1 treats every shared bigram as suspicious.

	const qBigrams = bigramSet(tokenizeForBigramOverlap(question));
	if (qBigrams.size === 0) return null;
	const aBigrams = bigramSet(tokenizeForBigramOverlap(articleText));

	const matched: string[] = [];
	for (const bg of qBigrams) {
		if (!aBigrams.has(bg)) continue;
		// Drop domain-inevitable bigrams: they share a collocation by
		// necessity (any citizen asking about "comunidad autonoma X" will
		// share that bigram with the article, regardless of whether they
		// have seen it). The downstream LLM critic still inspects the
		// question as a whole for subtler leak patterns.
		if (whitelist.has(bg)) continue;
		matched.push(bg);
	}

	if (matched.length < minOverlapBigrams) return null;
	return { matched };
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
