/**
 * Generate AI topic breakdowns for omnibus laws (norms with 15+ materias).
 *
 * Detects omnibus laws via materia count, extracts their structural sections,
 * and uses an LLM to produce per-topic summaries + "medida encubierta" flags.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-omnibus-topics.ts
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-omnibus-topics.ts --limit 10
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-omnibus-topics.ts --since 2026-01-01
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-omnibus-topics.ts --dry-run
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-omnibus-topics.ts --force
 */

import { BASE_MATERIAS } from "../data/materia-mappings.ts";
import { callOpenRouter, OpenRouterError } from "../services/openrouter.ts";
import { getArg, getMaterias, hasFlag, setupDb } from "./shared.ts";

const OMNIBUS_THRESHOLD = 15;

// ── CLI ──

const limitArg = Number(getArg("limit") ?? 20);
const sinceArg = getArg("since");
const modelId = getArg("model") ?? "google/gemini-3.1-flash-lite-preview";
const dryRun = hasFlag("dry-run");
const force = hasFlag("force");

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey && !dryRun) {
	console.error(
		"Set OPENROUTER_API_KEY env variable (or use --dry-run to skip AI)",
	);
	process.exit(1);
}

// ── DB ──

const { db, dbService } = setupDb();

// ── Types ──

interface TopicResponse {
	topic_label: string;
	headline: string;
	summary: string;
	article_count: number;
	sneaked_in: boolean;
	related_materias: string[];
	block_ids: string[];
}

const TOPIC_SCHEMA = {
	type: "object",
	properties: {
		topics: {
			type: "array",
			items: {
				type: "object",
				properties: {
					topic_label: {
						type: "string",
						description:
							"Tema en 2-4 palabras. Ej: 'Fiscalidad', 'Energía eléctrica'",
					},
					headline: {
						type: "string",
						description:
							"Titular de máximo 15 palabras sobre este eje temático",
					},
					summary: {
						type: "string",
						description:
							"Resumen de 1-3 frases sobre qué regula este eje temático",
					},
					article_count: {
						type: "number",
						description: "Número de artículos que cubre este eje temático",
					},
					sneaked_in: {
						type: "boolean",
						description:
							"true si este tema no tiene relación con el título oficial de la ley",
					},
					related_materias: {
						type: "array",
						items: { type: "string" },
						description:
							"Materias exactas del BOE que corresponden a este eje temático. Usa solo nombres de la lista proporcionada.",
					},
					block_ids: {
						type: "array",
						items: { type: "string" },
						description:
							"Identificadores exactos de los bloques (artículos, disposiciones) que pertenecen a este eje temático. Cada block_id debe aparecer en exactamente un tema. Usa los identificadores de la estructura proporcionada.",
					},
				},
				required: [
					"topic_label",
					"headline",
					"summary",
					"article_count",
					"sneaked_in",
					"related_materias",
					"block_ids",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["topics"],
	additionalProperties: false,
} as const;

// ── Block structure extraction ──

interface BlockHeading {
	block_id: string;
	title: string;
	heading_text: string | null;
}

function getBlockStructure(normId: string): BlockHeading[] {
	return db
		.query<BlockHeading, [string]>(
			`SELECT b.block_id, b.title,
				(SELECT substr(v.text, 1, 200) FROM versions v
				 WHERE v.norm_id = b.norm_id AND v.block_id = b.block_id
				 ORDER BY v.date DESC LIMIT 1) as heading_text
			FROM blocks b
			WHERE b.norm_id = ?
			  AND (b.block_id LIKE 'ti%' OR b.block_id LIKE 'ci%'
			       OR b.block_id LIKE 'a%' OR b.block_id LIKE 'da%'
			       OR b.block_id LIKE 'df%')
			ORDER BY b.rowid`,
		)
		.all(normId);
}

// ── Prompt construction ──

function buildPrompt(
	norm: { id: string; title: string; materia_count: number },
	blocks: BlockHeading[],
	materias: string[],
): { system: string; user: string } {
	const system = `Eres un analista legislativo español. Analizas leyes "ómnibus" que agrupan múltiples temas no relacionados en una sola norma.

Responde SOLO con JSON:
{
  "topics": [
    {
      "topic_label": "string (2-4 palabras)",
      "headline": "string (máximo 15 palabras)",
      "summary": "string (1-3 frases)",
      "article_count": number,
      "sneaked_in": boolean
    }
  ]
}

Una "medida encubierta" (sneaked_in=true) es un tema que NO tiene relación con el título oficial de la ley y que podría haberse incluido para aprobarse sin debate independiente.

Reglas:
- Español correcto con acentos (á, é, í, ó, ú, ñ, ¿, ¡)
- Lenguaje ciudadano, no jurídico
- Agrupa artículos por tema, no repitas temas
- Máximo 20 temas por ley
- Para cada tema, incluye un array "related_materias" con las materias EXACTAS del BOE que corresponden. Usa SOLO nombres de la siguiente lista.
- Para cada tema, incluye un array "block_ids" con los identificadores exactos de los bloques que pertenecen a ese tema. Cada block_id debe aparecer en exactamente un tema. Usa los identificadores de la estructura proporcionada (ej: "a1", "a2", "da1", "df3").`;

	const blocksWithText = blocks.filter((b) => b.heading_text);

	let structureText: string;
	if (blocksWithText.length >= 3) {
		structureText = blocksWithText
			.map((b) => {
				const prefix = b.block_id.startsWith("ti")
					? "TÍTULO"
					: b.block_id.startsWith("ci")
						? "  CAPÍTULO"
						: b.block_id.startsWith("da")
							? "  Disp. adicional"
							: b.block_id.startsWith("df")
								? "  Disp. final"
								: "    Art.";
				return `[${b.block_id}] ${prefix}: ${b.heading_text?.trim() || b.title}`;
			})
			.join("\n");
	} else {
		// Fallback: use materias as topic seeds
		structureText = `(Sin estructura interna disponible. Materias asignadas: ${materias.join(", ")})`;
	}

	const user = `LEY ÓMNIBUS con ${norm.materia_count} temas distintos

Título: ${norm.title}

Materias asignadas a esta norma:
${materias.join(", ")}

Estructura:
${structureText}`;

	return { system, user };
}

// ── Validation ──

function validateTopics(data: unknown): {
	result: TopicResponse[] | null;
	reason: string;
} {
	if (!data || typeof data !== "object")
		return { result: null, reason: "not an object" };
	const d = data as Record<string, unknown>;

	if (!Array.isArray(d.topics))
		return { result: null, reason: "topics is not an array" };

	const topics: TopicResponse[] = [];
	for (const t of d.topics.slice(0, 20)) {
		if (!t || typeof t !== "object") continue;
		const topic = t as Record<string, unknown>;

		const topicLabel =
			typeof topic.topic_label === "string" ? topic.topic_label : "";
		let headline = typeof topic.headline === "string" ? topic.headline : "";
		let summary = typeof topic.summary === "string" ? topic.summary : "";
		const articleCount =
			typeof topic.article_count === "number" ? topic.article_count : 0;
		const sneakedIn =
			typeof topic.sneaked_in === "boolean" ? topic.sneaked_in : false;
		const relatedMaterias = Array.isArray(topic.related_materias)
			? (topic.related_materias as unknown[]).filter(
					(m): m is string => typeof m === "string",
				)
			: [];
		const blockIds = Array.isArray(topic.block_ids)
			? (topic.block_ids as unknown[]).filter(
					(id): id is string => typeof id === "string",
				)
			: [];

		if (!topicLabel) continue;

		if (headline.length > 100) headline = `${headline.slice(0, 97)}...`;
		if (summary.length > 500) summary = `${summary.slice(0, 497)}...`;

		topics.push({
			topic_label: topicLabel,
			headline,
			summary,
			article_count: articleCount,
			sneaked_in: sneakedIn,
			related_materias: relatedMaterias,
			block_ids: blockIds,
		});
	}

	if (topics.length === 0) return { result: null, reason: "no valid topics" };

	return { result: topics, reason: "ok" };
}

// ── Main ──

async function main() {
	// Find omnibus norms (15+ materias)
	const sinceClause = sinceArg
		? "HAVING materia_count >= ? AND latest_date >= ?"
		: "HAVING materia_count >= ?";
	const params: unknown[] = sinceArg
		? [OMNIBUS_THRESHOLD, sinceArg, limitArg]
		: [OMNIBUS_THRESHOLD, limitArg];

	const norms = db
		.query<
			{ id: string; title: string; materia_count: number; latest_date: string },
			unknown[]
		>(
			`SELECT n.id, n.title,
				COUNT(DISTINCT m.materia) as materia_count,
				MAX(r.date) as latest_date
			FROM norms n
			JOIN materias m ON m.norm_id = n.id
			JOIN reforms r ON r.norm_id = n.id
			GROUP BY n.id
			${sinceClause}
			ORDER BY latest_date DESC
			LIMIT ?`,
		)
		.all(...params);

	// Filter out norms that already have topics (unless --force)
	const toProcess = force
		? norms
		: norms.filter((n) => dbService.getOmnibusTopics(n.id).length === 0);

	console.log(`\n📋 Omnibus topic generation`);
	console.log(`   Threshold: ${OMNIBUS_THRESHOLD}+ materias`);
	console.log(`   Model: ${modelId}`);
	console.log(`   Omnibus norms found: ${norms.length}`);
	console.log(
		`   To process: ${toProcess.length} (${norms.length - toProcess.length} already have topics)`,
	);
	if (sinceArg) console.log(`   Since: ${sinceArg}`);
	if (dryRun) console.log(`   Mode: DRY RUN`);
	if (force) console.log(`   Mode: FORCE (regenerate existing)`);
	console.log();

	if (toProcess.length === 0) {
		console.log("✅ All omnibus norms already have topics.");
		return;
	}

	let processed = 0;
	let errors = 0;
	let totalCost = 0;

	for (const norm of toProcess) {
		const blocks = getBlockStructure(norm.id);
		const materias = getMaterias(db, norm.id);

		if (dryRun) {
			const blocksWithText = blocks.filter((b) => b.heading_text).length;
			console.log(
				`  [dry] ${norm.materia_count} materias | ${blocksWithText} headings | ${norm.title.slice(0, 60)}...`,
			);
			processed++;
			continue;
		}

		const { system, user } = buildPrompt(norm, blocks, materias);

		try {
			const result = await callOpenRouter<{ topics: TopicResponse[] }>(
				apiKey!,
				{
					model: modelId,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					temperature: 0.2,
					jsonSchema: {
						name: "omnibus_topics",
						schema: TOPIC_SCHEMA,
					},
				},
			);

			const { result: topics, reason } = validateTopics(result.data);
			if (!topics) {
				console.error(`  ❌ ${norm.id}: ${reason}`);
				errors++;
				continue;
			}

			// Validate block_ids against actual blocks in DB
			const validBlockIds = new Set(blocks.map((b) => b.block_id));

			// Wrap delete + upserts in a transaction so --force doesn't lose
			// data if the upsert loop fails partway through.
			db.transaction(() => {
				if (force) {
					db.query("DELETE FROM omnibus_topics WHERE norm_id = ?").run(norm.id);
				}

				for (let i = 0; i < topics.length; i++) {
					const t = topics[i];
					// Filter out BASE_MATERIAS and validate against actual norm materias
					const filteredRelatedMaterias = t.related_materias.filter(
						(m) => !BASE_MATERIAS.includes(m) && materias.includes(m),
					);
					// Validate block_ids against actual blocks
					const filteredBlockIds = t.block_ids.filter((id) =>
						validBlockIds.has(id),
					);
					if (
						t.block_ids.length > 0 &&
						filteredBlockIds.length < t.block_ids.length
					) {
						console.warn(
							`    ⚠ ${norm.id} topic ${i} "${t.topic_label}": ${t.block_ids.length - filteredBlockIds.length} invalid block_ids filtered out`,
						);
					}
					dbService.upsertOmnibusTopic(norm.id, i, {
						topicLabel: t.topic_label,
						headline: t.headline,
						summary: t.summary,
						articleCount: filteredBlockIds.length || t.article_count,
						isSneaked: t.sneaked_in,
						relatedMaterias: JSON.stringify(filteredRelatedMaterias),
						blockIds: JSON.stringify(filteredBlockIds),
						model: modelId,
					});
				}
			})();

			totalCost += result.cost;
			processed++;

			const sneakedCount = topics.filter((t) => t.sneaked_in).length;
			console.log(
				`  ✅ ${norm.materia_count} materias | ${topics.length} topics | ${sneakedCount} sneaked | $${result.cost.toFixed(6)} | ${norm.title.slice(0, 50)}`,
			);
		} catch (err) {
			if (err instanceof OpenRouterError) {
				if (err.code === "http_401" || err.code === "http_403") {
					console.error(`  ❌ Auth error: ${err.message}`);
					process.exit(1);
				}
				if (err.code === "http_429") {
					console.warn(
						`  ⏳ Rate limited on ${norm.id} — waiting 30s before retry...`,
					);
					await Bun.sleep(30_000);
					// Skip error count, norm will be retried on next --force run
				}
			}
			console.error(
				`  ❌ ${norm.id}: ${err instanceof Error ? err.message : err}`,
			);
			errors++;
		}
	}

	console.log(`\n📊 Summary:`);
	console.log(`   Processed: ${processed}/${toProcess.length}`);
	console.log(`   Errors: ${errors}`);
	if (!dryRun) console.log(`   Total cost: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
