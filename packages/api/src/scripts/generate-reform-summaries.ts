/**
 * Generate AI reform summaries for reforms missing them.
 *
 * Generates headline, summary, reform_type, and importance for each reform
 * using OpenRouter (Gemini Flash Lite). Results cached in reform_summaries table.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-reform-summaries.ts
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-reform-summaries.ts --weeks 4
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-reform-summaries.ts --limit 50
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-reform-summaries.ts --dry-run
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-reform-summaries.ts --force
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-reform-summaries.ts --model google/gemini-2.0-flash-001
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import { DbService } from "../services/db.ts";
import { callOpenRouter, OpenRouterError } from "../services/openrouter.ts";

// ── CLI ──

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const weeks = Number(getArg("weeks") ?? 4);
const limitArg = Number(getArg("limit") ?? 200);
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

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
createSchema(db);

const dbService = new DbService(db);

// ── Types ──

interface BlockDiff {
	block_id: string;
	title: string;
	change_type: "modified" | "new";
	previous_text: string;
	current_text: string;
}

interface SummaryResponse {
	headline: string;
	summary: string;
	importance: "high" | "normal" | "low" | "skip";
	reform_type: "new_law" | "modification" | "correction" | "derogation";
}

const SUMMARY_SCHEMA = {
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

function queryBlockDiffs(
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
				current_text: truncate(versions[0].text),
			});
		} else {
			diffs.push({
				block_id: block.block_id,
				title: block.title,
				change_type: "modified",
				previous_text: truncate(versions[1].text),
				current_text: truncate(versions[0].text),
			});
		}
	}
	return diffs;
}

function getMaterias(normId: string): string[] {
	return db
		.query<{ materia: string }, [string]>(
			"SELECT materia FROM materias WHERE norm_id = ?",
		)
		.all(normId)
		.map((r) => r.materia);
}

function isOriginalPublication(
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

// ── Validation ──

function validateResponse(data: unknown): {
	result: SummaryResponse | null;
	reason: string;
} {
	if (!data || typeof data !== "object")
		return { result: null, reason: "not an object" };
	const d = data as Record<string, unknown>;

	let headline = typeof d.headline === "string" ? d.headline : "";
	let summary = typeof d.summary === "string" ? d.summary : "";
	const importance = typeof d.importance === "string" ? d.importance : "";
	const reformType = typeof d.reform_type === "string" ? d.reform_type : "";

	// Truncate instead of rejecting — structured outputs should prevent this,
	// but belt-and-suspenders for models that don't fully support json_schema
	if (headline.length > 100) {
		headline = `${headline.slice(0, 97)}...`;
	}
	if (summary.length > 500) {
		summary = `${summary.slice(0, 497)}...`;
	}

	if (!["high", "normal", "low", "skip"].includes(importance))
		return { result: null, reason: `invalid importance: "${importance}"` };
	if (
		!["new_law", "modification", "correction", "derogation"].includes(
			reformType,
		)
	)
		return { result: null, reason: `invalid reform_type: "${reformType}"` };

	return {
		result: {
			headline,
			summary,
			importance: importance as SummaryResponse["importance"],
			reform_type: reformType as SummaryResponse["reform_type"],
		},
		reason: "ok",
	};
}

// ── Prompt construction ──

function buildPrompt(
	reform: {
		norm_id: string;
		title: string;
		rank: string;
		date: string;
		source_id: string;
	},
	diffs: BlockDiff[],
	materias: string[],
	isNewLaw: boolean,
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
- skip: cambios puramente administrativos sin impacto ciudadano

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

	return { system, user };
}

// ── Main ──

async function main() {
	const since = new Date();
	since.setDate(since.getDate() - weeks * 7);
	const sinceStr = since.toISOString().slice(0, 10);

	// Get reforms without summaries
	let reforms: Array<{
		norm_id: string;
		title: string;
		rank: string;
		date: string;
		source_id: string;
	}>;

	if (force) {
		// Re-generate all reforms in the date range
		reforms = db
			.query<
				{
					norm_id: string;
					title: string;
					rank: string;
					date: string;
					source_id: string;
				},
				[string, number]
			>(
				`SELECT r.norm_id, n.title, n.rank, r.date, r.source_id
				 FROM reforms r
				 JOIN norms n ON n.id = r.norm_id
				 WHERE r.date >= ?
				 ORDER BY r.date DESC
				 LIMIT ?`,
			)
			.all(sinceStr, limitArg);
	} else {
		reforms = dbService.getReformsWithoutSummary(sinceStr, limitArg);
	}

	console.log(`\n📋 Reform summaries generation`);
	console.log(`   Since: ${sinceStr} (${weeks} weeks)`);
	console.log(`   Model: ${modelId}`);
	console.log(`   Reforms to process: ${reforms.length}`);
	if (dryRun) console.log(`   Mode: DRY RUN (no LLM calls)`);
	if (force) console.log(`   Mode: FORCE (regenerate existing)`);
	console.log();

	if (reforms.length === 0) {
		console.log("✅ All reforms already have summaries.");
		return;
	}

	let processed = 0;
	let errors = 0;
	let skippedNewLaw = 0;
	let totalCost = 0;

	for (const reform of reforms) {
		const diffs = queryBlockDiffs(
			reform.norm_id,
			reform.source_id,
			reform.date,
		);
		const materias = getMaterias(reform.norm_id);
		const isNewLaw = isOriginalPublication(
			reform.norm_id,
			reform.source_id,
			reform.date,
		);

		if (isNewLaw) skippedNewLaw++;

		if (dryRun) {
			const type = isNewLaw ? "new_law" : "modification";
			console.log(
				`  [dry] ${reform.date} | ${type} | ${diffs.length} blocks | ${reform.title.slice(0, 60)}...`,
			);
			processed++;
			continue;
		}

		const { system, user } = buildPrompt(reform, diffs, materias, isNewLaw);

		try {
			const result = await callOpenRouter<SummaryResponse>(apiKey!, {
				model: modelId,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				temperature: 0.2,
				jsonSchema: {
					name: "reform_summary",
					schema: SUMMARY_SCHEMA,
				},
			});

			const { result: validated, reason } = validateResponse(result.data);
			if (!validated) {
				console.error(`  ❌ ${reform.norm_id} ${reform.date}: ${reason}`);
				errors++;
				continue;
			}

			// Override reform_type for confirmed new laws
			if (isNewLaw) {
				validated.reform_type = "new_law";
			}

			dbService.upsertReformSummary(
				reform.norm_id,
				reform.source_id,
				reform.date,
				{
					reformType: validated.reform_type,
					headline: validated.headline,
					summary: validated.summary,
					importance: validated.importance,
					model: modelId,
				},
			);

			totalCost += result.cost;
			processed++;
			console.log(
				`  ✅ ${reform.date} | ${validated.reform_type} | ${validated.importance} | $${result.cost.toFixed(6)} | ${validated.headline.slice(0, 50)}`,
			);
		} catch (err) {
			if (err instanceof OpenRouterError && err.code.startsWith("http_40")) {
				console.error(`  ❌ Auth error: ${err.message}`);
				process.exit(1);
			}
			console.error(
				`  ❌ ${reform.norm_id} ${reform.date}: ${err instanceof Error ? err.message : err}`,
			);
			errors++;
		}
	}

	console.log(`\n📊 Summary:`);
	console.log(`   Processed: ${processed}/${reforms.length}`);
	console.log(`   Errors: ${errors}`);
	console.log(`   New laws detected: ${skippedNewLaw}`);
	if (!dryRun) console.log(`   Total cost: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
