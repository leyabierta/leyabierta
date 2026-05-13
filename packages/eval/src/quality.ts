import type { QAEntry } from "./qa-schema.ts";

export interface QualityResult {
	pass: boolean;
	reasons: string[];
}

// Language heuristic: count high-frequency Spanish diacritics + all ASCII letters,
// then check that non-letter ratio is below threshold.
// Placeholder — real language detection deferred to Phase 3.5.
function spanishLetterRatio(text: string): number {
	const spanishMarkers = (text.match(/[áéíóúñüÁÉÍÓÚÑÜ¿¡]/g) ?? []).length;
	const asciiLetters = (text.match(/[a-zA-Z]/g) ?? []).length;
	const letters = spanishMarkers + asciiLetters;
	return letters / Math.max(text.length, 1);
}

export function checkQuality(entry: QAEntry): QualityResult {
	const reasons: string[] = [];

	if (!entry.id) reasons.push("missing id");
	if (!entry.source) reasons.push("missing source");

	if (!entry.question || entry.question.length === 0) {
		reasons.push("missing question");
	} else {
		if (entry.question.length < 20)
			reasons.push("question too short (< 20 chars)");
		if (!/[a-zA-ZáéíóúñüÁÉÍÓÚÑÜ]/.test(entry.question))
			reasons.push("question contains no alphabetic characters");
	}

	if (!entry.answer || entry.answer.length === 0) {
		reasons.push("missing answer");
	} else {
		if (entry.answer.length < 100)
			reasons.push("answer too short (< 100 chars)");
	}

	// Language check on question + answer combined (short-circuit if already failed)
	if (reasons.length === 0 || !reasons.some((r) => r.includes("missing"))) {
		const combined = `${entry.question ?? ""} ${entry.answer ?? ""}`;
		const ratio = spanishLetterRatio(combined);
		if (ratio < 0.6) {
			reasons.push(
				`non-letter ratio too high (letter ratio=${ratio.toFixed(2)} < 0.60)`,
			);
		}
	}

	return { pass: reasons.length === 0, reasons };
}
