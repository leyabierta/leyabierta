/**
 * Checks shared by every path that stores LLM-generated citizen text
 * (article and law summaries, tags, reform and omnibus summaries).
 *
 * Qwen models sometimes switch language mid-sentence ("…por servicio军事.");
 * 1,753 old article summaries had such fragments. Any text outside the Latin
 * script is rejected before it reaches the DB.
 */

// Latin script (incl. accents), plus digits, punctuation and symbols shared
// by all scripts, and Greek (formulas: "el parámetro α"). Anything else (CJK,
// Cyrillic...) is a model glitch.
export const FOREIGN_SCRIPT =
	/[^\p{Script=Latin}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]/u;

export function hasForeignScript(...texts: string[]): boolean {
	return texts.some((t) => FOREIGN_SCRIPT.test(t));
}

/**
 * The model id as stored next to a generated text (reform_summaries.model,
 * citizen_article_summaries.model): an OpenRouter-style `provider/model` id.
 * The offline generator records the served name of the local vLLM
 * (`qwen3.8-27b`), the same weights as `qwen/qwen3.8-27b`.
 */
export function normalizeModelId(model: string | undefined): string {
	const m = (model ?? "").trim();
	// Only the bare vLLM served name ("qwen3.8-27b"); anything else (an
	// OpenRouter id, a local tag like "qwen3.8:27b-mlx") is kept as is.
	if (/^qwen\d[\w.-]*$/i.test(m)) return `qwen/${m.toLowerCase()}`;
	return m;
}
