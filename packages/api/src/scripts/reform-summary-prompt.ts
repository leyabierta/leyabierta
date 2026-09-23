/**
 * Prompt, output schema and diff queries for reform summaries
 * (generate-reform-summaries.ts).
 *
 * Kept in its own module, without the script's top-level CLI/DB code, so the
 * exact production prompt can be reused by tests and model evaluations.
 */

import type { Database } from "bun:sqlite";

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

export function queryBlockDiffs(
	db: Database,
	normId: string,
	sourceId: string,
	reformDate: string,
	maxTextLen = 500,
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
	for (const block of blocks.slice(0, 10)) {
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

export function buildPrompt(
	reform: ReformRow,
	diffs: BlockDiff[],
	materias: string[],
	isNewLaw: boolean,
	isOmnibus: boolean,
	materiaCount: number,
): { system: string; user: string } {
	const system = `Eres un periodista legislativo español. Generas resúmenes claros y precisos de cambios legislativos para ciudadanos.

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

Reglas:
- Español correcto con acentos (á, é, í, ó, ú, ñ, ¿, ¡)
- NO inventes datos. Si no ves el diff, usa "se actualizan", "se modifican"
- Lenguaje ciudadano, no jurídico
- Sé preciso: qué cambió, para quién, desde cuándo`;

	let user: string;
	if (isNewLaw) {
		const text = diffs
			.map((d) => d.current_text)
			.join("\n\n")
			.slice(0, 2000);
		user = `NUEVA LEY publicada el ${reform.date}

Título: ${reform.title}
Rango: ${reform.rank}
${materias.length > 0 ? `Materias: ${materias.join(", ")}` : ""}

Primeros artículos:
${text || "(sin texto disponible)"}`;
	} else {
		const diffsText = diffs
			.map((d) => {
				if (d.change_type === "new") {
					return `[NUEVO] ${d.title}: ${d.current_text}`;
				}
				return `[MODIFICADO] ${d.title}:\n  antes: ${d.previous_text}\n  ahora: ${d.current_text}`;
			})
			.join("\n\n");

		user = `CAMBIO LEGISLATIVO del ${reform.date}

Ley modificada: ${reform.title}
Rango: ${reform.rank}
${materias.length > 0 ? `Materias: ${materias.join(", ")}` : ""}

Cambios:
${diffsText || "(sin bloques afectados disponibles)"}`;
	}

	if (isOmnibus) {
		user += `\n\nNOTA: Esta norma es una ley ómnibus que abarca ${materiaCount} temas distintos. Contextualiza el titular y resumen mencionando que esta reforma forma parte de una ley más amplia que agrupa múltiples temas no relacionados.`;
	}

	return { system, user };
}
