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
}

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
		.query<{ block_id: string; title: string }, [string, string]>(
			`SELECT b.block_id, b.title
       FROM reform_blocks rb
       JOIN blocks b ON b.norm_id = rb.norm_id AND b.block_id = rb.block_id
       WHERE rb.reform_source_id = ? AND rb.norm_id = ?
       ORDER BY b.position`,
		)
		.all(sourceId, normId);

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
			});
		} else {
			diffs.push({
				block_id: block.block_id,
				title: block.title,
				change_type: "modified",
				previous_text: truncate(versions[1]!.text),
				current_text: truncate(versions[0]!.text),
			});
		}
	}
	return diffs;
}

// Markdown emphasis and runs of whitespace carry no meaning for the diff and
// would otherwise show up as spurious changes.
function normalizeText(s: string): string {
	return s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

function truncateChars(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

const CONTEXT_WORDS = 12;

function firstWords(s: string, n: number): string {
	const words = s.trim().split(" ");
	return words.length > n ? `${words.slice(0, n).join(" ")} …` : s.trim();
}

function lastWords(s: string, n: number): string {
	const words = s.trim().split(" ");
	return words.length > n ? `… ${words.slice(-n).join(" ")}` : s.trim();
}

/**
 * What changed in a modified block, in words, for the prompt: unchanged text
 * is reduced to a few words of context around each change, deletions are
 * written [-así-] and insertions {+así+}. A near-total rewrite (or a diff that
 * times out) falls back to the beginning of both versions. The old prompt sent
 * only the first 500 characters of each version: in half of the modified
 * articles both fragments were identical and the model had to guess.
 */
export function formatBlockChange(
	previous: string,
	current: string,
	maxChars = 1200,
): string {
	const a = normalizeText(previous);
	const b = normalizeText(current);
	if (a === b)
		return "(el texto no cambia: posible cambio de numeración, formato o vigencia)";

	const rewrite = () =>
		`(texto reescrito casi por completo)\n  antes: ${truncateChars(a, Math.floor(maxChars * 0.4))}\n  ahora: ${truncateChars(b, Math.floor(maxChars * 0.6))}`;

	const parts = diffWordsWithSpace(a, b, { timeout: 500 });
	if (!parts) return rewrite();

	const changed = parts
		.filter((p) => p.added || p.removed)
		.reduce((n, p) => n + p.value.length, 0);
	if (changed / (a.length + b.length) > 0.6) return rewrite();

	const out: string[] = [];
	parts.forEach((p, i) => {
		if (p.removed) out.push(`[-${p.value.trim()}-]`);
		else if (p.added) out.push(`{+${p.value.trim()}+}`);
		else if (i === 0) out.push(lastWords(p.value, CONTEXT_WORDS));
		else if (i === parts.length - 1)
			out.push(firstWords(p.value, CONTEXT_WORDS));
		else {
			const words = p.value.trim().split(" ");
			out.push(
				words.length > 2 * CONTEXT_WORDS
					? `${words.slice(0, CONTEXT_WORDS).join(" ")} … ${words.slice(-CONTEXT_WORDS).join(" ")}`
					: p.value.trim(),
			);
		}
	});
	return truncateChars(out.filter(Boolean).join(" "), maxChars);
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
			"SELECT materia FROM materias WHERE norm_id = ?",
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

// ── Prompt construction ──

export const REFORM_SYSTEM_PROMPT = `Eres un periodista legislativo español. Generas resúmenes claros y precisos de cambios legislativos para ciudadanos.

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

Reglas:
- Español correcto con acentos (á, é, í, ó, ú, ñ, ¿, ¡)
- NO inventes datos: describe solo cambios que se vean en el material. Si no se ve en qué consiste un cambio, usa "se actualizan", "se modifican"
- Explica el cambio concreto (cifras, plazos, sujetos, requisitos) cuando se vea: de qué a qué pasa
- Lenguaje ciudadano, no jurídico
- Sé preciso: qué cambió, para quién, desde cuándo`;

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
		const text = diffs
			.map((d) => d.current_text)
			.join("\n\n")
			.slice(0, 3000);
		user = `NUEVA LEY publicada el ${reform.date}

Título: ${reform.title}
Rango: ${reform.rank}
${materias.length > 0 ? `Materias: ${materias.join(", ")}` : ""}

Primeros artículos:
${text || "(sin texto disponible)"}`;
	} else {
		const parts: string[] = [];
		let used = 0;
		let shown = 0;
		for (const d of diffs.slice(0, MAX_DIFF_BLOCKS)) {
			if (used >= MAX_CHANGES_CHARS) break;
			const budget = Math.min(1200, MAX_CHANGES_CHARS - used);
			const part =
				d.change_type === "new"
					? `[NUEVO] ${d.title}: ${truncateChars(normalizeText(d.current_text), budget)}`
					: `[MODIFICADO] ${d.title}: ${formatBlockChange(d.previous_text, d.current_text, budget)}`;
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
${sourceLine}${materias.length > 0 ? `Materias: ${materias.join(", ")}` : ""}

Cambios:
${parts.join("\n\n") || "(sin bloques afectados disponibles)"}`;
	}

	if (isOmnibusSource(source)) {
		const scope =
			source.lawsModified >= OMNIBUS_MIN_LAWS_MODIFIED
				? `modifica ${source.lawsModified} leyes distintas`
				: `abarca ${source.materiaCount} temas distintos`;
		user += `\n\nNOTA: La norma que introduce este cambio es una ley ómnibus que ${scope}. Contextualiza el titular y resumen mencionando que esta reforma forma parte de una ley más amplia que agrupa múltiples temas no relacionados.`;
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
