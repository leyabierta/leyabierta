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
 *   bun run packages/api/src/scripts/reform-summaries-offline.ts export <out.jsonl> [--db PATH]
 *   BASE=http://127.0.0.1:8001/v1 MODEL=qwen3.8-27b CONC=64 \
 *     bun run packages/api/src/scripts/reform-summaries-offline.ts generate <in.jsonl> <out.jsonl> [--limit N]
 *   bun run packages/api/src/scripts/reform-summaries-offline.ts import <generated.jsonl> [--apply] [--db PATH]
 *
 * The prompt is the production one (reform-summary-prompt.ts), built on the
 * server at export time. Each row carries a hash of it; import rebuilds the
 * prompt from the DB and skips the row if anything it was built from changed.
 */

import { Database } from "bun:sqlite";
import { readJsonl, runGeneration } from "./offline-llm.ts";
import { importReformRows, promptHash } from "./reform-summary-import.ts";
import {
	buildReformPrompt,
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
			!a.startsWith("--") && all[i - 1] !== "--db" && all[i - 1] !== "--limit",
	);

interface ExportRow {
	norm_id: string;
	source_id: string;
	reform_date: string;
	is_new_law: boolean;
	user: string;
	input_hash: string;
}

async function exportPending(outFile: string) {
	const db = new Database(DB_PATH, { readonly: true });
	// Newest first: recent changes are what citizens look for first. Dates
	// in the future are corrupt BOE metadata (see list-corrupt-reform-dates.ts).
	const reforms = db
		.prepare(
			`SELECT r.norm_id, n.title, n.rank, r.date, r.source_id
			 FROM reforms r JOIN norms n ON n.id = r.norm_id
			 LEFT JOIN reform_summaries rs
			   ON rs.norm_id = r.norm_id AND rs.source_id = r.source_id AND rs.reform_date = r.date
			 WHERE rs.norm_id IS NULL AND n.status = 'vigente' AND r.date <= date('now')
			 ORDER BY r.date DESC, r.norm_id, r.source_id`,
		)
		.all() as ReformRow[];

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
		};
		writer.write(`${JSON.stringify(row)}\n`);
		written++;
	}
	await writer.end();
	console.log(`export: ${written} reforms written to ${outFile}`);
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
	const { rows, badLines } = readJsonl<unknown>(file);
	const report = importReformRows(db, rows, { apply });
	console.log(
		`${apply ? "APPLIED" : "DRY RUN (use --apply to write)"}: ${JSON.stringify({ ...report, badLines })}`,
	);
}

const [first, second] = positional;
if (cmd === "export" && first) await exportPending(first);
else if (cmd === "generate" && first && second) await generate(first, second);
else if (cmd === "import" && first)
	importGenerated(first, args.includes("--apply"));
else {
	console.error(
		"Usage: reform-summaries-offline.ts export <out.jsonl> | generate <in.jsonl> <out.jsonl> [--limit N] | import <generated.jsonl> [--apply]",
	);
	process.exit(1);
}
