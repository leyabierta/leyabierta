/**
 * Backfill block_ids for existing omnibus topics that don't have them.
 *
 * Instead of regenerating everything (headlines, summaries, materias),
 * this script only asks the LLM to assign block_ids to existing topics.
 * Much cheaper and preserves existing data.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/backfill-topic-block-ids.ts
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/backfill-topic-block-ids.ts --limit 5
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/backfill-topic-block-ids.ts --dry-run
 */

import { callOpenRouter, OpenRouterError } from "../services/openrouter.ts";
import { getArg, hasFlag, setupDb } from "./shared.ts";

const limitArg = Number(getArg("limit") ?? 100);
const modelId = getArg("model") ?? "google/gemini-3.1-flash-lite-preview";
const dryRun = hasFlag("dry-run");

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey && !dryRun) {
	console.error("Set OPENROUTER_API_KEY (or use --dry-run)");
	process.exit(1);
}

const { db, dbService } = setupDb();

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

const ASSIGNMENT_SCHEMA = {
	type: "object",
	properties: {
		assignments: {
			type: "array",
			items: {
				type: "object",
				properties: {
					topic_index: {
						type: "number",
						description: "Índice del tema (0, 1, 2...)",
					},
					block_ids: {
						type: "array",
						items: { type: "string" },
						description: "block_ids que pertenecen a este tema",
					},
				},
				required: ["topic_index", "block_ids"],
				additionalProperties: false,
			},
		},
	},
	required: ["assignments"],
	additionalProperties: false,
} as const;

async function main() {
	// Find norms with topics that have empty block_ids
	const normsWithEmptyBlockIds = db
		.query<{ norm_id: string; topic_count: number }, [number]>(
			`SELECT norm_id, COUNT(*) as topic_count
			 FROM omnibus_topics
			 WHERE block_ids = '' OR block_ids = '[]'
			 GROUP BY norm_id
			 LIMIT ?`,
		)
		.all(limitArg);

	console.log(`\n📋 Backfill block_ids for existing topics`);
	console.log(`   Model: ${modelId}`);
	console.log(`   Norms to process: ${normsWithEmptyBlockIds.length}`);
	if (dryRun) console.log(`   Mode: DRY RUN`);
	console.log();

	if (normsWithEmptyBlockIds.length === 0) {
		console.log("✅ All topics already have block_ids.");
		return;
	}

	let processed = 0;
	let errors = 0;
	let totalCost = 0;

	for (const {
		norm_id: normId,
		topic_count: topicCount,
	} of normsWithEmptyBlockIds) {
		const topics = dbService.getOmnibusTopics(normId);
		const allBlocks = getBlockStructure(normId);

		if (allBlocks.length === 0) {
			console.log(`  ⏭ ${normId}: no block structure, skipping`);
			continue;
		}

		// Only assign articles and dispositions (not structural containers)
		const assignableBlocks = allBlocks.filter(
			(b) =>
				b.block_id.startsWith("a") ||
				b.block_id.startsWith("da") ||
				b.block_id.startsWith("df") ||
				b.block_id.startsWith("dt"),
		);

		if (assignableBlocks.length === 0) {
			console.log(`  ⏭ ${normId}: no assignable blocks, skipping`);
			continue;
		}

		// For large norms (>200 assignable blocks), use compact format
		const isLarge = assignableBlocks.length > 200;
		const structureText = assignableBlocks
			.filter((b) => isLarge || b.heading_text)
			.map((b) => {
				const label =
					b.heading_text?.trim().slice(0, isLarge ? 80 : 200) || b.title;
				return `[${b.block_id}] ${label}`;
			})
			.join("\n");

		const topicsText = topics
			.map((t, i) => `  ${i}. "${t.topic_label}" — ${t.headline}`)
			.join("\n");

		if (dryRun) {
			console.log(
				`  [dry] ${normId}: ${topicCount} topics, ${assignableBlocks.length} assignable blocks (${allBlocks.length} total)`,
			);
			processed++;
			continue;
		}

		const system = `Eres un analista legislativo. Se te da la lista de artículos de una ley y los ejes temáticos ya identificados. Tu tarea es asignar cada artículo al tema que le corresponde.

Responde SOLO con JSON:
{
  "assignments": [
    { "topic_index": 0, "block_ids": ["a1", "a2"] },
    { "topic_index": 1, "block_ids": ["a3", "da1"] }
  ]
}

Reglas:
- Cada block_id debe aparecer en exactamente un tema
- Usa solo block_ids de la lista proporcionada
- Si un artículo no encaja claramente en ningún tema, asígnalo al tema más cercano
- IMPORTANTE: Debes asignar TODOS los block_ids, no dejes ninguno sin asignar`;

		const user = `ARTÍCULOS DE LA LEY (${assignableBlocks.length} bloques):
${structureText}

TEMAS IDENTIFICADOS (${topics.length} temas):
${topicsText}

Asigna cada block_id a su tema correspondiente. Todos deben quedar asignados.`;

		// Scale max tokens based on block count
		const maxTokens = Math.min(
			16000,
			Math.max(4000, assignableBlocks.length * 15),
		);

		try {
			const result = await callOpenRouter<{
				assignments: Array<{ topic_index: number; block_ids: string[] }>;
			}>(apiKey!, {
				model: modelId,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				temperature: 0.1,
				maxTokens,
				jsonSchema: { name: "block_assignments", schema: ASSIGNMENT_SCHEMA },
			});

			const assignments = result.data?.assignments;
			if (!Array.isArray(assignments)) {
				console.error(`  ❌ ${normId}: invalid response`);
				errors++;
				continue;
			}

			// Validate and update
			const validBlockIds = new Set(assignableBlocks.map((b) => b.block_id));
			let updated = 0;
			let totalAssigned = 0;

			db.transaction(() => {
				for (const assignment of assignments) {
					const idx = assignment.topic_index;
					if (idx < 0 || idx >= topics.length) continue;

					const filteredIds = (assignment.block_ids || []).filter((id) =>
						validBlockIds.has(id),
					);
					totalAssigned += filteredIds.length;

					db.query(
						"UPDATE omnibus_topics SET block_ids = ?, article_count = ? WHERE norm_id = ? AND topic_index = ?",
					).run(JSON.stringify(filteredIds), filteredIds.length, normId, idx);
					updated++;
				}
			})();

			totalCost += result.cost;
			processed++;
			const coverage = Math.round(
				(totalAssigned / assignableBlocks.length) * 100,
			);
			const warn = coverage < 80 ? ` ⚠ ${coverage}% coverage` : "";
			console.log(
				`  ✅ ${normId}: ${updated}/${topicCount} topics | ${totalAssigned}/${assignableBlocks.length} blocks assigned | $${result.cost.toFixed(6)}${warn}`,
			);
		} catch (err) {
			if (
				err instanceof OpenRouterError &&
				(err.code === "http_401" || err.code === "http_403")
			) {
				console.error(`  ❌ Auth error: ${err.message}`);
				process.exit(1);
			}
			console.error(
				`  ❌ ${normId}: ${err instanceof Error ? err.message : err}`,
			);
			errors++;
		}
	}

	console.log(`\n📊 Summary:`);
	console.log(`   Processed: ${processed}/${normsWithEmptyBlockIds.length}`);
	console.log(`   Errors: ${errors}`);
	if (!dryRun) console.log(`   Total cost: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
