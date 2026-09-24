/**
 * Reform summaries ("qué cambió") generated offline, on a rented GPU, in three
 * steps that never let the GPU box or a laptop write to the production DB:
 *
 *   1. export   (server, read-only)  reforms of in-force laws without a summary,
 *                                    with the exact prompt → JSONL
 *   2. generate (anywhere)           JSONL → OpenAI-compatible endpoint → JSONL
 *   3. import   (server, dry-run by default) validated rows → DB
 *
 * Usage:
 *   bun run packages/api/src/scripts/reform-summaries-offline.ts export <out.jsonl> [--regenerate-existing] [--db PATH]
 *   BASE=http://127.0.0.1:8001/v1 MODEL=qwen3.8-27b CONC=64 \
 *     bun run packages/api/src/scripts/reform-summaries-offline.ts generate <in.jsonl> <out.jsonl> [--limit N]
 *   bun run packages/api/src/scripts/reform-summaries-offline.ts import <generated.jsonl> [--apply]
 *     [--replace-from <export.jsonl>] [--db PATH]
 *
 * Instead of `generate`, the OpenRouter Batch API (openai/gpt-6-luna:batch,
 * the same request as the daily cron; see reform-batch.ts, NOT Zero Data
 * Retention: public legislation only, never user questions):
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/reform-summaries-offline.ts \
 *     batch-submit <export.jsonl> <state.json> [--chunk 2000] [--limit N] [--skip-done <out.jsonl>]
 *       [--once | --max-chunks N]
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/reform-summaries-offline.ts \
 *     batch-collect <state.json> <out.jsonl> [--poll-seconds 300 (min 30)] [--once] [--accept-incomplete]
 * batch-submit resumes from <state.json> if it exists (refusing an export
 * whose content changed); `--once` sends one batch only, to check a real
 * response before sending the rest (rerun without it). batch-collect writes
 * rows in the format of `generate` for `import`, and DELETEs each batch it
 * has read. To send failed rows again: batch-submit the same export with a
 * NEW state file and `--skip-done <out.jsonl>`, once the old state is collected.
 *
 * The prompt is the production one (reform-summary-prompt.ts), built on the
 * server at export time. Each row carries a hash of it; import rebuilds the
 * prompt from the DB and skips the row if anything it was built from changed.
 *
 * Regeneration: `export --regenerate-existing` writes the reforms of in-force
 * laws that already have a summary, each with `previous_summary_hash`. Passing
 * that export to `import --replace-from` replaces those summaries, each only
 * if it is still the one seen at export time. It takes every existing
 * summary, so run it before importing a backfill you do not want to redo.
 *
 * Import marks the summaries it writes for reforms older than
 * ALERT_WINDOW_DAYS as notified: a backfill must not send alert emails.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { hasColumn } from "@leyabierta/pipeline";
import { readJsonl, runGeneration } from "./offline-llm.ts";
import {
	assertSameExport,
	type ExportRow as BatchExportRow,
	collectOnce,
	fileSha256,
	loadState,
	planBatches,
	saveState,
	submitBatches,
} from "./reform-batch.ts";
import {
	importReformRows,
	promptHash,
	summaryHash,
} from "./reform-summary-import.ts";
import {
	buildReformPrompt,
	PROMPT_VERSION,
	REFORM_SYSTEM_PROMPT,
	type ReformRow,
	SUMMARY_SCHEMA,
} from "./reform-summary-prompt.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
const DB_PATH = flag("--db") ?? process.env.DB_PATH ?? "data/leyabierta.db";
const positional = args
	.slice(1)
	.filter(
		(a, i, all) =>
			!a.startsWith("--") &&
			all[i - 1] !== "--db" &&
			all[i - 1] !== "--limit" &&
			all[i - 1] !== "--replace-from" &&
			all[i - 1] !== "--chunk" &&
			all[i - 1] !== "--skip-done" &&
			all[i - 1] !== "--max-chunks" &&
			all[i - 1] !== "--poll-seconds",
	);

interface ExportRow {
	norm_id: string;
	source_id: string;
	reform_date: string;
	is_new_law: boolean;
	user: string;
	input_hash: string;
	prompt_version: string;
	previous_summary_hash?: string;
}

async function exportPending(outFile: string, regenerate: boolean) {
	const db = new Database(DB_PATH, { readonly: true });
	// Newest first: recent changes are what citizens look for first. Dates
	// in the future are corrupt BOE metadata (see list-corrupt-reform-dates.ts).
	// Regeneration takes the reforms that already have a summary instead.
	const reforms = db
		.prepare(
			`SELECT r.norm_id, n.title, n.rank, r.date, r.source_id,
			        rs.headline AS prev_headline, rs.summary AS prev_summary
			 FROM reforms r JOIN norms n ON n.id = r.norm_id
			 LEFT JOIN reform_summaries rs
			   ON rs.norm_id = r.norm_id AND rs.source_id = r.source_id AND rs.reform_date = r.date
			 WHERE rs.norm_id IS ${regenerate ? "NOT NULL" : "NULL"}
			   AND n.status = 'vigente' AND r.date <= date('now')
			 ORDER BY r.date DESC, r.norm_id, r.source_id`,
		)
		.all() as (ReformRow & {
		prev_headline: string | null;
		prev_summary: string | null;
	})[];

	const writer = Bun.file(outFile).writer();
	let written = 0;
	for (const reform of reforms) {
		const prompt = buildReformPrompt(db, reform);
		const row: ExportRow = {
			norm_id: reform.norm_id,
			source_id: reform.source_id,
			reform_date: reform.date,
			is_new_law: prompt.isNewLaw,
			user: prompt.user,
			input_hash: promptHash(prompt),
			prompt_version: PROMPT_VERSION,
		};
		if (regenerate)
			row.previous_summary_hash = summaryHash(
				reform.prev_headline ?? "",
				reform.prev_summary ?? "",
			);
		writer.write(`${JSON.stringify(row)}\n`);
		written++;
	}
	await writer.end();
	console.log(
		`export${regenerate ? " (regenerate)" : ""}: ${written} reforms written to ${outFile}`,
	);
}

async function generate(inFile: string, outFile: string) {
	await runGeneration({
		items: readJsonl<ExportRow>(inFile).rows,
		outFile,
		keyNames: ["norm_id", "source_id", "reform_date"],
		limit: Number(flag("--limit") ?? 0),
		body: (r) => ({
			temperature: 0.2,
			max_tokens: 600,
			messages: [
				{ role: "system", content: REFORM_SYSTEM_PROMPT },
				{ role: "user", content: r.user },
			],
			response_format: {
				type: "json_schema",
				json_schema: { name: "reform_summary", schema: SUMMARY_SCHEMA },
			},
			chat_template_kwargs: { enable_thinking: false },
		}),
		toRow: (r, res, model) => {
			const first = res.text.indexOf("{");
			const last = res.text.lastIndexOf("}");
			if (first === -1 || last <= first) throw new Error("no JSON object");
			return {
				input_hash: r.input_hash,
				prompt_version: r.prompt_version,
				model,
				result: JSON.parse(res.text.slice(first, last + 1)),
				finish: res.finish,
				usage: res.usage,
			};
		},
	});
}

function importGenerated(file: string, apply: boolean) {
	// Dry run never writes; neither mode creates a DB from a mistyped path.
	const db = apply
		? new Database(DB_PATH, { create: false, readwrite: true })
		: new Database(DB_PATH, { readonly: true });
	db.run("PRAGMA busy_timeout = 30000");
	// The import writes prompt_version; the column is added by createSchema,
	// which the API runs at startup. Never migrate from here: fail clearly.
	if (!hasColumn(db, "reform_summaries", "prompt_version")) {
		console.error(
			"reform_summaries.prompt_version is missing: run createSchema first (start the API on this DB, or any script that calls it), then retry.",
		);
		process.exit(1);
	}
	const { rows, badLines } = readJsonl<unknown>(file);
	const replaceFrom = flag("--replace-from");
	let replace: Map<string, string> | undefined;
	if (replaceFrom) {
		replace = new Map();
		for (const e of readJsonl<ExportRow>(replaceFrom).rows)
			if (e.previous_summary_hash)
				replace.set(
					`${e.norm_id}|${e.source_id}|${e.reform_date}`,
					e.previous_summary_hash,
				);
		console.log(`replace mode: ${replace.size} summaries may be replaced`);
	}
	const report = importReformRows(db, rows, { apply, replace });
	console.log(
		`${apply ? "APPLIED" : "DRY RUN (use --apply to write)"}: ${JSON.stringify({ ...report, badLines })}`,
	);
}

function batchApiKey(): string {
	const key = process.env.OPENROUTER_API_KEY ?? "";
	if (!key) {
		console.error("Set OPENROUTER_API_KEY");
		process.exit(1);
	}
	return key;
}

/** Polling faster does not speed up a 24 h batch window. */
const MIN_POLL_SECONDS = 30;

/** A non-negative integer flag, or `fallback`; exits on anything else. */
function intFlag(name: string, fallback: number): number {
	const raw = flag(name);
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		console.error(`${name} must be a non-negative integer, got "${raw}"`);
		process.exit(1);
	}
	return n;
}

async function batchSubmit(exportFile: string, statePath: string) {
	const { rows, badLines } = readJsonl<BatchExportRow>(exportFile);
	const sha256 = fileSha256(exportFile);
	// --once sends a single batch: check the first real response before the rest.
	const maxChunks = args.includes("--once")
		? 1
		: intFlag("--max-chunks", 0) || Number.POSITIVE_INFINITY;
	let state: ReturnType<typeof loadState>;
	if (existsSync(statePath)) {
		state = loadState(statePath);
		// Content, not path: an export regenerated at the same path has other
		// lines, and custom_id is a line number.
		assertSameExport(state, sha256);
		const ignored = ["--chunk", "--limit", "--skip-done"].filter((f) =>
			args.includes(f),
		);
		if (ignored.length > 0)
			console.warn(
				`WARNING: resuming ${statePath}; ${ignored.join(", ")} only apply when planning and are ignored`,
			);
		console.log(`resuming ${statePath}`);
	} else {
		const skipDone = flag("--skip-done");
		const skipKeys = new Set<string>();
		if (skipDone)
			for (const o of readJsonl<Record<string, unknown>>(skipDone).rows)
				if (o.ok === true)
					skipKeys.add(`${o.norm_id}|${o.source_id}|${o.reform_date}`);
		const plan = planBatches(exportFile, sha256, rows, {
			chunk: intFlag("--chunk", 2000),
			limit: intFlag("--limit", 0),
			skipKeys,
		});
		state = plan.state;
		console.log(
			`plan: ${Object.keys(state.items).length} reforms in ${state.batches.length} batches; refused ${JSON.stringify(plan.refused)}; bad lines ${badLines}`,
		);
		if (state.batches.length === 0) return;
		saveState(statePath, state);
	}
	const n = await submitBatches(
		{ apiKey: batchApiKey() },
		statePath,
		state,
		(id) => rows[Number(id.slice(1))],
		console.log,
		maxChunks,
	);
	const left = state.batches.filter((b) => !b.id).length;
	console.log(
		`batch-submit: ${n} batches submitted, ${left} left; state in ${statePath}`,
	);
}

async function batchCollect(statePath: string, outFile: string) {
	const state = loadState(statePath);
	const pollSeconds = intFlag("--poll-seconds", 300);
	if (pollSeconds < MIN_POLL_SECONDS) {
		console.error(`--poll-seconds must be at least ${MIN_POLL_SECONDS}`);
		process.exit(1);
	}
	const api = { apiKey: batchApiKey() };
	const acceptIncomplete = args.includes("--accept-incomplete");
	for (;;) {
		const { pending, unsubmitted, blocked, written, ok } = await collectOnce(
			api,
			statePath,
			state,
			outFile,
			console.log,
			{ acceptIncomplete },
		);
		console.log(
			`[${new Date().toISOString()}] written ${written} (ok ${ok}), batches pending ${pending}, blocked ${blocked}, not submitted ${unsubmitted}`,
		);
		// Unsubmitted and blocked batches never change by waiting: stop once
		// nothing else is left.
		if (pending === 0 || args.includes("--once")) {
			if (blocked > 0)
				console.warn(
					`WARNING: ${blocked} finished batches have incomplete results and were NOT collected or deleted; check them (GET /api/v1/batches/<id>) and rerun with --accept-incomplete to collect what came back`,
				);
			break;
		}
		await Bun.sleep(pollSeconds * 1000);
	}
	const cost = state.batches.reduce((sum, b) => sum + (b.cost ?? 0), 0);
	console.log(`batch-collect: done; reported cost ${cost.toFixed(4)} USD`);
}

const [first, second] = positional;
if (cmd === "export" && first)
	await exportPending(first, args.includes("--regenerate-existing"));
else if (cmd === "generate" && first && second) await generate(first, second);
else if (cmd === "import" && first)
	importGenerated(first, args.includes("--apply"));
else if (cmd === "batch-submit" && first && second)
	await batchSubmit(first, second);
else if (cmd === "batch-collect" && first && second)
	await batchCollect(first, second);
else {
	console.error(
		"Usage: reform-summaries-offline.ts export <out.jsonl> [--regenerate-existing] | generate <in.jsonl> <out.jsonl> [--limit N] | import <generated.jsonl> [--apply] [--replace-from <export.jsonl>] | batch-submit <export.jsonl> <state.json> [--chunk N] [--limit N] [--skip-done <out.jsonl>] [--once | --max-chunks N] | batch-collect <state.json> <out.jsonl> [--poll-seconds N≥30] [--once] [--accept-incomplete]",
	);
	process.exit(1);
}
