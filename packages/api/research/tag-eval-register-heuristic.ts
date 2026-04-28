#!/usr/bin/env bun
/**
 * INTERIM heuristic register tagger for the eval-v2 questions.
 *
 * **This script is fragile by design and meant to be deleted.** It exists
 * solely as a one-day stopgap so we could produce a per-register baseline
 * before the agent-based tagger ran. The hardcoded verb lists
 * (PROCEDURAL_ACTION_VERBS, INFORMAL_FIRST_PERSON, etc.) will misclassify
 * any reasonable production query mix at ~10-15% — fine for a sanity
 * check, NOT fine for any decision that depends on per-register accuracy.
 *
 * Replacement plan:
 *   1. Run the agent-based tagger (Claude Code subagent) against eval-v2
 *      to populate the canonical `register` field.
 *   2. Compare `register` vs `register_heuristic` for divergence — if the
 *      heuristic got more than ~85% right, log the disagreements and
 *      delete this file. If less than 85%, the agent's tagging stands and
 *      we delete this file anyway.
 *   3. Either way: delete this file. Don't iterate on the regexes.
 *
 * Output goes to `data/eval-v2.json` under the field `register_heuristic`,
 * not `register`. When the agent run completes it will populate
 * `register` and we keep both for comparison.
 *
 * Heuristic rules (in priority order):
 *
 *   1. **procedural**: starts with `¿?(d[oó]nde|c[oó]mo|cu[aá]ndo|qu[ié]n|...)`
 *      OR contains procedural anchor verbs (solicito|presento|recurro|inscribo|tramito|reclamo|alegan|alego)
 *      OR contains the words `plazo`, `trámite`, `documentos hacen falta`, `qué órgano`.
 *   2. **informal**: matches "Google-style" patterns:
 *      - all-lowercase first word AND missing question marks
 *      - OR contains casual self-reference ("me", "mi casero", "mi trabajo", "mi paro")
 *        AND short (<= 14 words)
 *      - OR contains lowercase question word without ¿ ("cuanto", "donde", "cuando")
 *   3. **formal**: everything else (default).
 *
 * Empirically this misclassifies ~10-15% of questions vs an agent's
 * judgement (the line between "informal-but-punctuated" and "formal" is
 * fuzzy). The agent's tagging is more reliable; this is the fallback.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Question = {
	id: number;
	question: string;
	register?: string;
	register_heuristic?: string;
	[k: string]: unknown;
};

type EvalFile = { results: Question[]; [k: string]: unknown };

export type Register = "formal" | "informal" | "procedural";

// Leader words that *can* introduce procedural questions, but only count
// as procedural when paired with an action verb later in the sentence
// (otherwise "¿Cómo regula X?" gets miscalled).
const PROCEDURAL_LEADERS =
	/^¿?\s*(d[oó]nde|c[oó]mo|cu[aá]ndo|qu[eé]\s+(órgano|organo|tr[aá]mite|documentos|formulario|modelo))/i;

// Procedural action verbs (first-person and infinitive forms). Substantive
// verbs like "reclamar"/"alegar" are NOT here — they're often used in
// substantive legal questions ("¿cuándo prescribe el derecho a reclamar?").
// Infinitives matter for citizen-style "¿cómo puedo presentar...?", "¿dónde
// debo solicitar...?".
const PROCEDURAL_ACTION_VERBS =
	/\b(solicito|presento|tramito|inscribo|recurro|impugno|registro|notifico|aporto|firmo|solicitar|presentar|tramitar|inscribir|recurrir|impugnar|registrar|notificar|aportar|firmar)\b/i;

// Strong procedural keywords: very specific, low false-positive rate.
// "plazo" alone is excluded because it's used heavily in substantive
// formal questions ("¿cuál es el plazo de prescripción...?").
const PROCEDURAL_KEYWORDS =
	/(d[oó]nde\s+(presento|solicito|inscribo|tramito|aporto)|c[oó]mo\s+(solicito|presento|tramito|inscribo|aporto)|tr[aá]mite\s+|documentos\s+hacen\s+falta|qu[eé]\s+(modelo|formulario)\s+|plazo\s+para\s+(recurrir|presentar|impugnar|solicitar|reclamar)|c[oó]mo\s+puedo\s+(ser|trabajar|funcionario))/i;

const INFORMAL_FIRST_PERSON =
	/\b(mi\s+(casero|trabajo|paro|jefe|alquiler|piso|coche|empresa)|me\s+(despide|paga|deja|sube|baja|cobra)|mis\s+(derechos|hijos|padres))\b/i;

const ACCENTLESS_QUESTION_WORDS = /^(cuanto|donde|cuando|que|quien|porque)\b/i;

export function classifyRegister(text: string): Register {
	const t = text.trim();

	// 1. Procedural — leader + action verb, or strong keyword.
	if (PROCEDURAL_LEADERS.test(t) && PROCEDURAL_ACTION_VERBS.test(t)) {
		return "procedural";
	}
	if (PROCEDURAL_KEYWORDS.test(t)) {
		return "procedural";
	}
	if (PROCEDURAL_ACTION_VERBS.test(t)) {
		return "procedural";
	}

	// 2. Informal:
	//   - First word lowercase + no ¿ → Google-style.
	//   - Or contains first-person casual reference + short.
	//   - Or starts with accentless question word ("cuanto", "donde").
	const startsLowerNoOpener = /^[a-z]/.test(t) && !t.startsWith("¿");
	if (startsLowerNoOpener) return "informal";

	if (ACCENTLESS_QUESTION_WORDS.test(t) && !t.startsWith("¿")) {
		return "informal";
	}

	const wordCount = t.split(/\s+/).length;
	if (INFORMAL_FIRST_PERSON.test(t) && wordCount <= 14) {
		return "informal";
	}

	// 3. Formal default.
	return "formal";
}

function main(opts: { evalPath: string }): void {
	const raw = JSON.parse(readFileSync(opts.evalPath, "utf8")) as EvalFile;
	const items = raw.results;
	const counts: Record<Register, number> = {
		formal: 0,
		informal: 0,
		procedural: 0,
	};
	for (const q of items) {
		const r = classifyRegister(q.question);
		q.register_heuristic = r;
		counts[r] += 1;
	}
	writeFileSync(opts.evalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	const total = items.length;
	const pct = (n: number) => `${((n / total) * 100).toFixed(0)}%`;
	console.log(`Tagged ${total} questions in ${opts.evalPath}`);
	console.log(
		`  formal: ${counts.formal} ${pct(counts.formal)} | informal: ${counts.informal} ${pct(counts.informal)} | procedural: ${counts.procedural} ${pct(counts.procedural)}`,
	);
}

if (import.meta.main) {
	const opts = { evalPath: resolve(process.argv[2] ?? "data/eval-v2.json") };
	main(opts);
}
