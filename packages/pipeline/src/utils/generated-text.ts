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
