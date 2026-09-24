/**
 * Prompt, output schema and diff queries for reform summaries
 * (generate-reform-summaries.ts).
 *
 * Kept in its own module, without the script's top-level CLI/DB code, so the
 * exact production prompt can be reused by tests and model evaluations.
 */

import type { Database } from "bun:sqlite";
import { diffWordsWithSpace } from "diff";

export interface BlockDiff {
	block_id: string;
	title: string;
	change_type: "modified" | "new";
	previous_text: string;
	current_text: string;
	/** A version was longer than queryBlockDiffs' cap and was cut. */
	truncated?: boolean;
}

/**
 * Bump when the prompt text or its inputs change: the offline import compares
 * it before the prompt hash, to tell "the code changed" from "the data changed".
 */
export const PROMPT_VERSION = "2026-09-24.1";

export interface ReformRow {
	norm_id: string;
	title: string;
	rank: string;
	date: string;
	source_id: string;
}

export const SUMMARY_SCHEMA = {
	type: "object",
	properties: {
		headline: {
			type: "string",
			description:
				"Titular claro en lenguaje ciudadano. Ejemplo: 'La factura electrónica será obligatoria entre empresas'",
		},
		summary: {
			type: "string",
			description:
				"Resumen de 1-4 frases explicando qué cambió y por qué importa al ciudadano.",
		},
		importance: {
			type: "string",
			enum: ["high", "normal", "low", "skip"],
			description:
				"high: ley orgánica, reforma fiscal importante. normal: mayoría. low: erratas, cambios menores. skip: puramente administrativo.",
		},
		reform_type: {
			type: "string",
			enum: ["new_law", "modification", "correction", "derogation"],
			description:
				"new_law: ley nueva. modification: cambio en ley existente. correction: corrección de erratas. derogation: derogación.",
		},
	},
	required: ["headline", "summary", "importance", "reform_type"],
	additionalProperties: false,
} as const;

// ── Diff computation ──

/** Max blocks whose text goes into the prompt; the rest are listed by title. */
export const MAX_DIFF_BLOCKS = 15;

export function queryBlockDiffs(
	db: Database,
	normId: string,
	sourceId: string,
	reformDate: string,
	// Full texts by default: formatBlockChange extracts what changed. The cap
	// only guards against pathological blocks (whole codes in one "artículo").
	maxTextLen = 50_000,
): BlockDiff[] {
	const blocks = db
		.query<{ block_id: string; title: string }, [string, string, string]>(
			`SELECT b.block_id, b.title
       FROM reform_blocks rb
       JOIN blocks b ON b.norm_id = rb.norm_id AND b.block_id = rb.block_id
       WHERE rb.reform_source_id = ? AND rb.norm_id = ? AND rb.reform_date = ?
       ORDER BY b.position`,
		)
		.all(sourceId, normId, reformDate);

	const diffs: BlockDiff[] = [];
	for (const block of blocks) {
		if (!block.title) continue;
		const versions = db
			.query<{ date: string; text: string }, [string, string, string]>(
				`SELECT v.date, v.text
         FROM versions v
         WHERE v.norm_id = ? AND v.block_id = ? AND v.date <= ?
         ORDER BY v.date DESC
         LIMIT 2`,
			)
			.all(normId, block.block_id, reformDate);

		const truncate = (s: string) =>
			s.length > maxTextLen ? `${s.slice(0, maxTextLen)}...` : s;

		if (versions.length === 0) continue;
		if (versions.length === 1) {
			diffs.push({
				block_id: block.block_id,
				title: block.title,
				change_type: "new",
				previous_text: "",
				current_text: truncate(versions[0]!.text),
				truncated: versions[0]!.text.length > maxTextLen,
			});
		} else {
			diffs.push({
				block_id: block.block_id,
				title: block.title,
				change_type: "modified",
				previous_text: truncate(versions[1]!.text),
				current_text: truncate(versions[0]!.text),
				truncated:
					versions[0]!.text.length > maxTextLen ||
					versions[1]!.text.length > maxTextLen,
			});
		}
	}
	return diffs;
}

// Markdown emphasis and runs of whitespace carry no meaning for the diff and
// would otherwise show up as spurious changes.
function normalizeText(s: string): string {
	return (
		s
			// Images are shown as links to BOE files ("![imagen](/datos/…/26182_001.png)"):
			// a new file path is not a text change the model can describe.
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "[imagen]")
			.replace(/\*\*/g, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

function truncateChars(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

const CONTEXT_WORDS = 12;
const MERGE_GAP_WORDS = 2;

function firstWords(s: string, n: number): string {
	const words = s.trim().split(" ");
	return words.length > n ? `${words.slice(0, n).join(" ")} …` : s.trim();
}

function lastWords(s: string, n: number): string {
	const words = s.trim().split(" ");
	return words.length > n ? `… ${words.slice(-n).join(" ")}` : s.trim();
}

// Bound on the word diff's edit distance (in tokens, words and spaces). A
// deterministic limit, unlike jsdiff's clock-based `timeout`: the offline
// import rebuilds the prompt and compares its hash, so the same input must
// always give the same prompt. Beyond it the change is shown as a rewrite.
const MAX_EDIT_LENGTH = 1500;

/**
 * What changed in a modified block, in words, for the prompt: unchanged text
 * is reduced to a few words of context around each change, deletions are
 * written [-así-] and insertions {+así+}. A near-total rewrite (or one too
 * large to diff) falls back to the beginning of both versions. The old prompt
 * sent only the first 500 characters of each version: in half of the modified
 * articles both fragments were identical and the model had to guess.
 */
export function formatBlockChange(
	previous: string,
	current: string,
	maxChars = 1200,
	truncated = false,
): string {
	const a = normalizeText(previous);
	const b = normalizeText(current);
	if (a === b)
		return truncated
			? "(artículo muy largo: el cambio no está en la parte analizada del texto)"
			: "(el texto de este artículo es idéntico antes y después: el cambio no se ve en el texto)";

	// A rewrite often keeps the heading ("Artículo 5. Plazos. 1. …"): start
	// both versions where they diverge, so the fragments shown differ.
	const rewrite = () => {
		let common = 0;
		while (common < a.length && a[common] === b[common]) common++;
		const cut = common > 80 ? a.lastIndexOf(" ", common - 40) : -1;
		const from = (s: string) => (cut > 0 ? `… ${s.slice(cut + 1)}` : s);
		return `(texto reescrito casi por completo)\n  antes: ${truncateChars(from(a), Math.floor(maxChars * 0.4)) || "(vacío)"}\n  ahora: ${truncateChars(from(b), Math.floor(maxChars * 0.6)) || "(vacío)"}`;
	};

	const parts = diffWordsWithSpace(a, b, { maxEditLength: MAX_EDIT_LENGTH });
	if (!parts) return rewrite();

	const changed = parts
		.filter((p) => p.added || p.removed)
		.reduce((n, p) => n + p.value.length, 0);
	if (changed / (a.length + b.length) > 0.6) return rewrite();

	// Group nearby changes: runs of changes separated by at most
	// MERGE_GAP_WORDS unchanged words become one [-old phrase-] {+new phrase+},
	// instead of word-by-word interleaving ("[-Las-] {+Se+} [-ayudas-] {+crea+}")
	// that is hard to read.
	type Segment =
		| { kind: "same"; text: string }
		| { kind: "change"; removed: string; added: string };
	const segments: Segment[] = [];
	for (const p of parts) {
		const last = segments[segments.length - 1];
		if (p.removed || p.added) {
			if (last?.kind === "change") {
				if (p.removed) last.removed += p.value;
				else last.added += p.value;
			} else {
				segments.push({
					kind: "change",
					removed: p.removed ? p.value : "",
					added: p.added ? p.value : "",
				});
			}
			continue;
		}
		segments.push({ kind: "same", text: p.value });
	}
	// Fold "change, short same, change" into a single change.
	const merged: Segment[] = [];
	for (const seg of segments) {
		const last = merged[merged.length - 1];
		const beforeLast = merged[merged.length - 2];
		if (
			seg.kind === "change" &&
			last?.kind === "same" &&
			beforeLast?.kind === "change" &&
			last.text.trim().split(" ").filter(Boolean).length <= MERGE_GAP_WORDS
		) {
			beforeLast.removed += last.text + seg.removed;
			beforeLast.added += last.text + seg.added;
			merged.pop();
			continue;
		}
		merged.push(seg);
	}

	const out: string[] = [];
	merged.forEach((seg, i) => {
		if (seg.kind === "change") {
			// A change of whitespace only ("ciudadanos, en" → "ciudadanos,en").
			const removed = seg.removed.trim();
			const added = seg.added.trim();
			if (removed) out.push(`[-${removed}-]`);
			if (added) out.push(`{+${added}+}`);
			return;
		}
		const value = seg.text.trim();
		if (i === 0) out.push(lastWords(seg.text, CONTEXT_WORDS));
		else if (i === merged.length - 1)
			out.push(firstWords(seg.text, CONTEXT_WORDS));
		else {
			const words = value.split(" ");
			out.push(
				words.length > 2 * CONTEXT_WORDS
					? `${words.slice(0, CONTEXT_WORDS).join(" ")} … ${words.slice(-CONTEXT_WORDS).join(" ")}`
					: value,
			);
		}
	});
	// No space before punctuation that follows a marker: "{+diecisiete+}."
	const text = out
		.filter(Boolean)
		.join(" ")
		.replace(/([+-][}\]]) ([.,;:)])/g, "$1$2");
	return truncateChars(text, maxChars);
}

/** The law that makes the change (reforms.source_id). */
export interface SourceInfo {
	id: string;
	title: string | null;
	/** Distinct laws in the corpus this source modifies. */
	lawsModified: number;
	/** Materias of the source, if it is itself a consolidated law. */
	materiaCount: number;
}

/**
 * An omnibus law modifies many unrelated laws at once (budget laws, "medidas
 * fiscales, administrativas y del orden social"...). Before 2026-09 the note
 * was decided by the materias of the law being MODIFIED, which flagged every
 * reform of the Código Penal, the LGT or the LOREG (7,342 reforms), whatever
 * law made it.
 */
export const OMNIBUS_MIN_LAWS_MODIFIED = 10;
export const OMNIBUS_MIN_MATERIAS = 15;

export function isOmnibusSource(source: SourceInfo): boolean {
	return (
		source.lawsModified >= OMNIBUS_MIN_LAWS_MODIFIED ||
		source.materiaCount >= OMNIBUS_MIN_MATERIAS
	);
}

export function getSourceInfo(db: Database, sourceId: string): SourceInfo {
	const title =
		db
			.query<{ title: string }, [string]>(
				"SELECT title FROM norms WHERE id = ?",
			)
			.get(sourceId)?.title ?? null;
	const lawsModified =
		db
			.query<{ n: number }, [string]>(
				"SELECT count(DISTINCT norm_id) AS n FROM reforms WHERE source_id = ? AND norm_id != source_id",
			)
			.get(sourceId)?.n ?? 0;
	const materiaCount =
		db
			.query<{ n: number }, [string]>(
				"SELECT count(*) AS n FROM materias WHERE norm_id = ?",
			)
			.get(sourceId)?.n ?? 0;
	return { id: sourceId, title, lawsModified, materiaCount };
}

export function getMaterias(db: Database, normId: string): string[] {
	return db
		.query<{ materia: string }, [string]>(
			"SELECT materia FROM materias WHERE norm_id = ? ORDER BY materia",
		)
		.all(normId)
		.map((r) => r.materia);
}

export function isOriginalPublication(
	db: Database,
	normId: string,
	sourceId: string,
	reformDate: string,
): boolean {
	if (sourceId !== normId) return false;
	const earliest = db
		.query<{ date: string }, [string]>(
			"SELECT MIN(date) as date FROM reforms WHERE norm_id = ?",
		)
		.get(normId);
	return earliest?.date === reformDate;
}

// ── Model settings ──

/**
 * Reasoning settings for a reform-summary model on OpenRouter, as evaluated:
 * openai/* (gpt-6-luna) with minimal effort (its default is medium: slower
 * and costlier for no measured gain), Qwen with thinking off. Other models
 * get the provider default.
 */
export function reformReasoning(
	model: string,
): { effort: "minimal" } | { enabled: false } | undefined {
	if (model.startsWith("openai/")) return { effort: "minimal" };
	if (model.startsWith("qwen/")) return { enabled: false };
	return undefined;
}

/**
 * Request settings of a reform summary, shared by the daily cron
 * (generate-reform-summaries.ts, through callOpenRouter) and the Batch API
 * reprocessing (reform-batch.ts): both must send the model the same request.
 */
export const REFORM_TEMPERATURE = 0.2;
export const REFORM_MAX_TOKENS = 4000;
export const REFORM_JSON_SCHEMA = {
	name: "reform_summary",
	schema: SUMMARY_SCHEMA,
};

// ── Prompt construction ──

const REFORM_BASE_PROMPT = `Eres un periodista legislativo español. Generas resúmenes claros y precisos de cambios legislativos para ciudadanos.

Responde SOLO con JSON:
{
  "headline": "máximo 15 palabras, titular claro",
  "summary": "1-4 frases explicando qué cambió y por qué importa al ciudadano",
  "importance": "high" | "normal" | "low" | "skip",
  "reform_type": "new_law" | "modification" | "correction" | "derogation"
}

Importancia:
- high: cambio constitucional, ley orgánica nueva, reforma fiscal importante
- normal: la mayoría de reformas
- low: correcciones de erratas, cambios menores de redacción
- skip: cambios puramente administrativos sin impacto ciudadano (aun así rellena headline y summary con una descripción breve)

Cómo leer los cambios:
- En cada artículo modificado se muestra solo lo que cambia, con unas palabras de contexto: [-texto-] es texto suprimido y {+texto+} es texto añadido. "…" indica texto sin cambios omitido.
- Si un artículo se reescribió casi por completo, se muestra el principio de la versión anterior ("antes") y de la nueva ("ahora").
- [NUEVO] es un artículo que no existía antes.
- Si un artículo aparece como idéntico antes y después, NO supongas en qué consistió el cambio (ni "formal", ni "de numeración", ni "sin efectos"): di solo que se modifica ese artículo sin cambios visibles en su texto.

Reglas:
- Español correcto con acentos (á, é, í, ó, ú, ñ, ¿, ¡)
- NO inventes datos: describe solo cambios que se vean en el material. Si no se ve en qué consiste un cambio, usa "se actualizan", "se modifican"
- Explica el cambio concreto (cifras, plazos, sujetos, requisitos) cuando se vea: de qué a qué pasa
- Lenguaje ciudadano, no jurídico
- Sé preciso: qué cambió, para quién, desde cuándo`;

/**
 * Style rules (2026-09-24), appended to the base prompt. Written after the
 * Qwen 3.8 backfill, whose style (short, plain, impersonal) read best, so that
 * openai/gpt-6-luna writes the same way. Blind judge on 40 held-out reforms
 * never used for tuning: 8.70 vs 8.18 for Qwen, fidelity 1.68 vs 1.38
 * (packages/eval/results/2026-09-23-reform-cron-model.md).
 */
export const REFORM_STYLE_RULES = `

ESTILO DE REDACCIÓN (obligatorio, además de todo lo anterior):
- Escribe como un buen periodista de servicio público: frases completas, cortas y naturales, en voz activa y con un sujeto claro (quién hace qué).
- Titular: 8 a 13 palabras que digan el cambio concreto. Resumen: 2 o 3 frases, entre 200 y 320 caracteres.
- Sin punto y coma, sin comillas, sin paréntesis y sin listas.
- No cites números de artículos, apartados ni letras salvo que sean imprescindibles para entender el cambio: describe lo que regulan.
- Nunca hables del material ni de tu tarea ("el texto facilitado", "el material", "no se puede precisar"). Si el cambio no se aprecia en la redacción, dilo con naturalidad en una frase.
- No uses "la ciudadanía", "tú" ni "usted": nombra a quien afecta (trabajadores, empresas, contribuyentes, ayuntamientos...).
- Precisión ante todo: no añadas valoraciones ni efectos que el texto no diga (agiliza, mejora, moderniza, refuerza).`;

export const REFORM_SYSTEM_PROMPT = `${REFORM_BASE_PROMPT}${REFORM_STYLE_RULES}`;

// Some laws have hundreds of materias (a 11,800-character line was seen).
const MAX_MATERIAS_SHOWN = 25;

function materiasLine(materias: string[]): string {
	if (materias.length === 0) return "";
	const shown = materias.slice(0, MAX_MATERIAS_SHOWN).join(", ");
	const rest = materias.length - MAX_MATERIAS_SHOWN;
	return `Materias: ${shown}${rest > 0 ? ` y ${rest} más` : ""}`;
}

/** Total characters of changes sent per reform (≈ 2K tokens). */
export const MAX_CHANGES_CHARS = 7000;

export function buildPrompt(
	reform: ReformRow,
	diffs: BlockDiff[],
	materias: string[],
	isNewLaw: boolean,
	source: SourceInfo,
): { system: string; user: string } {
	const system = REFORM_SYSTEM_PROMPT;

	let user: string;
	if (isNewLaw) {
		// Each block cut on its own (as before the word diff): one long preamble
		// must not hide the articles that follow it.
		const text = diffs
			.slice(0, 10)
			.map((d) => truncateChars(normalizeText(d.current_text), 500))
			.join("\n\n")
			.slice(0, 3000);
		user = `NUEVA LEY publicada el ${reform.date}

Título: ${reform.title}
Rango: ${reform.rank}
${materiasLine(materias)}

Primeros artículos:
${text || "(sin texto disponible)"}`;
	} else {
		const parts: string[] = [];
		let used = 0;
		let shown = 0;
		const toShow = diffs.slice(0, MAX_DIFF_BLOCKS);
		for (const d of toShow) {
			// Too little room left to show a change: list it by title instead.
			if (MAX_CHANGES_CHARS - used < 200) break;
			// At least 1,200 characters per block; with few blocks each one gets
			// its share of the total (a single long article was cut at 1,200
			// with 7,000 available).
			const left = MAX_CHANGES_CHARS - used;
			const budget = Math.min(
				left,
				Math.max(1200, Math.floor(left / (toShow.length - shown))),
			);
			const part =
				d.change_type === "new"
					? `[NUEVO] ${d.title}: ${truncateChars(normalizeText(d.current_text), budget)}`
					: `[MODIFICADO] ${d.title}: ${formatBlockChange(d.previous_text, d.current_text, budget, d.truncated)}`;
			parts.push(part);
			used += part.length;
			shown++;
		}
		const rest = diffs.slice(shown);
		if (rest.length > 0) {
			parts.push(
				`(y ${rest.length} artículos más modificados: ${truncateChars(rest.map((d) => d.title).join("; "), 600)})`,
			);
		}

		const sourceLine =
			source.id === reform.norm_id
				? ""
				: `Norma que introduce el cambio: ${source.title ?? source.id}\n`;

		user = `CAMBIO LEGISLATIVO del ${reform.date}

Ley modificada: ${reform.title}
Rango: ${reform.rank}
${sourceLine}${materiasLine(materias)}

Cambios:
${parts.join("\n\n") || "(sin bloques afectados disponibles)"}`;
	}

	if (isOmnibusSource(source)) {
		const scope =
			source.lawsModified >= OMNIBUS_MIN_LAWS_MODIFIED
				? "modifica a la vez muchas leyes distintas"
				: "abarca muchas materias distintas";
		// Context, not a claim to repeat: "temas no relacionados" is often not
		// true (a child-protection law amending several related laws), and the
		// summary must stay about what changes in THIS law. No counts: the
		// number of laws a source modifies grows as the corpus does, and the
		// prompt must stay stable between an offline export and its import.
		user += `\n\nCONTEXTO: La norma que introduce este cambio es una ley ómnibus: ${scope}. Puedes mencionarlo brevemente, pero el titular y el resumen deben centrarse en lo que cambia en esta ley.`;
	}

	return { system, user };
}

/**
 * Everything the generator needs for one reform, straight from the DB. Shared
 * by the daily generator and the offline export/import (which compares a hash
 * of the prompt to detect that the underlying data changed).
 */
export function buildReformPrompt(
	db: Database,
	reform: ReformRow,
): { system: string; user: string; isNewLaw: boolean; blocks: number } {
	const diffs = queryBlockDiffs(
		db,
		reform.norm_id,
		reform.source_id,
		reform.date,
	);
	const materias = getMaterias(db, reform.norm_id);
	const isNewLaw = isOriginalPublication(
		db,
		reform.norm_id,
		reform.source_id,
		reform.date,
	);
	const source = getSourceInfo(db, reform.source_id);
	return {
		...buildPrompt(reform, diffs, materias, isNewLaw, source),
		isNewLaw,
		blocks: diffs.length,
	};
}
