/**
 * Generate AI reform summaries for reforms missing them.
 *
 * Generates headline, summary, reform_type, and importance for each reform
 * via OpenRouter (model: CONTENT_LLM_MODEL, default google/gemini-2.5-flash-lite).
 * Results cached in reform_summaries table.
 *
 * Gap-filling by design: every run picks up ALL reforms in the window that
 * still lack a summary (newest first), not just yesterday's. The window
 * (--weeks, default 26) and the per-run cap (--limit, default 200) keep a
 * backlog from being processed in one go; the rest is picked up on later runs.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/generate-reform-summaries.ts
 *   ... --weeks 4                 # narrower window
 *   ... --since 2026-08-01        # explicit start date (overrides --weeks)
 *   ... --limit 50                # per-run cap
 *   ... --dry-run                 # list what would be processed, no LLM calls
 *   ... --no-write                # call the LLM but do not write to the DB (smoke test)
 *   ... --force                   # regenerate existing summaries in the window
 *   ... --model <openrouter-id>   # override CONTENT_LLM_MODEL
 *
 * Env: OPENROUTER_API_KEY (required unless --dry-run or a local endpoint),
 * CONTENT_LLM_MODEL, REFORM_SUMMARIES_WEEKS, REFORM_SUMMARIES_LIMIT, DB_PATH.
 *
 * Local backend (opt-in, e.g. a backfill on Ollama; see contentLlmEndpoint in
 * services/openrouter.ts):
 *   CONTENT_LLM_BASE_URL=http://localhost:11434/v1 CONTENT_LLM_MODEL=qwen3.8:27b-mlx \
 *     bun run packages/api/src/scripts/generate-reform-summaries.ts --no-write --limit 5
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import { DbService } from "../services/db.ts";
import {
	callOpenRouter,
	contentLlmEndpoint,
	OpenRouterError,
} from "../services/openrouter.ts";
import {
	buildPrompt,
	getMaterias,
	isOriginalPublication,
	queryBlockDiffs,
	SUMMARY_SCHEMA,
} from "./reform-summary-prompt.ts";
import {
	type SummaryResponse,
	validateReformSummary,
} from "./reform-summary-validation.ts";

// ── CLI ──

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const weeks = Number(
	getArg("weeks") ?? process.env.REFORM_SUMMARIES_WEEKS ?? 26,
);
const sinceArg = getArg("since");
const limitArg = Number(
	getArg("limit") ?? process.env.REFORM_SUMMARIES_LIMIT ?? 200,
);
const endpoint = contentLlmEndpoint();
const modelId = getArg("model") ?? endpoint.model;
const dryRun = hasFlag("dry-run");
const noWrite = hasFlag("no-write");
const force = hasFlag("force");
const omnibusOnly = hasFlag("omnibus-only");

const apiKey = endpoint.apiKey ?? "";
if (!apiKey && !endpoint.baseUrl && !dryRun) {
	console.error(
		"Set OPENROUTER_API_KEY env variable (--no-write still calls the LLM; only --dry-run skips AI)",
	);
	process.exit(1);
}

// ── DB ──

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = process.env.DB_PATH ?? join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
createSchema(db);

const dbService = new DbService(db);

// ── Main ──

async function main() {
	const since = new Date();
	since.setDate(since.getDate() - weeks * 7);
	const sinceStr =
		sinceArg && /^\d{4}-\d{2}-\d{2}$/.test(sinceArg)
			? sinceArg
			: since.toISOString().slice(0, 10);

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

	if (omnibusOnly) {
		const beforeCount = reforms.length;
		reforms = reforms.filter((r) => getMaterias(db, r.norm_id).length >= 15);
		console.log(
			`   Omnibus filter: ${reforms.length}/${beforeCount} reforms from omnibus norms (15+ materias)`,
		);
	}

	console.log(`\n📋 Reform summaries generation`);
	console.log(
		`   Since: ${sinceStr}${sinceArg ? "" : ` (${weeks} weeks)`} | cap: ${limitArg}/run`,
	);
	console.log(
		`   Model: ${modelId}${endpoint.baseUrl ? ` @ ${endpoint.baseUrl}` : ""}`,
	);
	console.log(`   Reforms to process: ${reforms.length}`);
	if (dryRun) console.log(`   Mode: DRY RUN (no LLM calls)`);
	if (noWrite) console.log(`   Mode: NO WRITE (LLM calls, no DB writes)`);
	if (force) console.log(`   Mode: FORCE (regenerate existing)`);
	if (omnibusOnly) console.log(`   Mode: OMNIBUS ONLY (15+ materias)`);
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
			db,
			reform.norm_id,
			reform.source_id,
			reform.date,
		);
		const materias = getMaterias(db, reform.norm_id);
		const isOmnibus = materias.length >= 15;
		const isNewLaw = isOriginalPublication(
			db,
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

		const { system, user } = buildPrompt(
			reform,
			diffs,
			materias,
			isNewLaw,
			isOmnibus,
			materias.length,
		);

		try {
			const result = await callOpenRouter<SummaryResponse>(apiKey, {
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
				baseUrl: endpoint.baseUrl,
				extraBody: endpoint.extraBody,
				timeoutMs: endpoint.timeoutMs,
			});

			const { result: validated, reason } = validateReformSummary(result.data);
			if (!validated) {
				console.error(`  ❌ ${reform.norm_id} ${reform.date}: ${reason}`);
				errors++;
				continue;
			}

			// Override reform_type for confirmed new laws
			if (isNewLaw) {
				validated.reform_type = "new_law";
			}

			if (noWrite) {
				totalCost += result.cost;
				processed++;
				console.log(
					`  🧪 ${reform.norm_id} ${reform.date} | ${validated.reform_type} | ${validated.importance} | $${result.cost.toFixed(6)}\n     ${validated.headline}\n     ${validated.summary}`,
				);
				continue;
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
	// Non-zero exit when every call failed, so the daily pipeline alerts.
	if (!dryRun && reforms.length > 0 && processed === 0 && errors > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
