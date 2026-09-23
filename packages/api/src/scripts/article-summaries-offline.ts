/**
 * Per-article citizen summaries generated offline, on a rented GPU, in three
 * steps that never let the GPU box or a laptop write to the production DB:
 *
 *   1. export   (server, read-only)  vigente articles without a summary → JSONL
 *   2. generate (anywhere)           JSONL → OpenAI-compatible endpoint → JSONL
 *   3. import   (server, dry-run by default) validated rows → DB
 *
 * Usage:
 *   bun run packages/api/src/scripts/article-summaries-offline.ts export <out.jsonl> [--db PATH]
 *   BASE=http://127.0.0.1:8001/v1 MODEL=qwen3.8-27b CONC=64 \
 *     bun run packages/api/src/scripts/article-summaries-offline.ts generate <in.jsonl> <out.jsonl> [--limit N]
 *   bun run packages/api/src/scripts/article-summaries-offline.ts import <generated.jsonl> [--apply] [--db PATH]
 *     [--replace-from <export.jsonl>]
 *
 * Regeneration of existing (older, lower-quality) summaries of chosen laws:
 *   ... export <out.jsonl> --regenerate <norm-ids.json>
 * writes their articles with `previous_summary_hash`; an export file
 * whose rows carry `previous_summary_hash` (the hash of the summary at export
 * time) can be passed with --replace-from; import then replaces those
 * summaries and their article tags, but only if they are still exactly the
 * ones exported.
 *
 * Generation uses the production prompt v10 (citizen-summary-backfill-prompt.ts)
 * with one article per request (the server batches; one article per request
 * avoids the id-mapping failures of multi-article prompts) and thinking off.
 * It is resumable: rows already in <out.jsonl> with ok=true are skipped.
 * Each row carries a hash of the article text; import skips rows whose article
 * changed since the export, and never overwrites an existing summary.
 */

import { Database } from "bun:sqlite";
import { importRows, textHash } from "./article-summary-import.ts";
import {
	BATCH_SCHEMA,
	type BackfillArticle,
	buildBatchPrompt,
	parseBatchContent,
	SYSTEM_PROMPT,
} from "./citizen-summary-backfill-prompt.ts";
import { readJsonl, runGeneration } from "./offline-llm.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
const DB_PATH = flag("--db") ?? process.env.DB_PATH ?? "data/leyabierta.db";
// Positional arguments after the command, skipping flags and their values.
const positional = args
	.slice(1)
	.filter(
		(a, i, all) =>
			!a.startsWith("--") &&
			all[i - 1] !== "--db" &&
			all[i - 1] !== "--limit" &&
			all[i - 1] !== "--replace-from" &&
			all[i - 1] !== "--regenerate",
	);

type ExportRow = BackfillArticle & { input_hash: string };

// Placeholder articles with nothing to summarize: "(Suprimido)", "(Derogado)",
// or a bare chapter/title heading stored as a precepto.
function hasSubstance(text: string): boolean {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const body = lines.slice(1).join(" ").replace(/\*+/g, "").trim();
	if (body.length < 40) return false;
	if (/^\(?(suprimido|derogad[oa]|sin contenido|anulad[oa])\)?\.?$/i.test(body))
		return false;
	if (
		/^(CAPÍTULO|TÍTULO|SECCIÓN|LIBRO|SUBSECCIÓN)\b/.test(lines[0] ?? "") &&
		lines.length <= 2 &&
		body.length < 120
	)
		return false;
	return true;
}

// Priority: state before autonomic, then by rank, then stable id order.
const RANK_ORDER: Record<string, number> = {
	constitucion: 0,
	ley_organica: 1,
	ley: 2,
	real_decreto_legislativo: 3,
	real_decreto_ley: 4,
	decreto_legislativo: 5,
	decreto_ley: 5,
	real_decreto: 6,
	decreto: 7,
	orden: 8,
};

async function exportPending(outFile: string) {
	const db = new Database(DB_PATH, { readonly: true });
	// Laws with an empty law-level summary are excluded: the daily
	// generate-citizen-tags.ts run regenerates them and deletes their article
	// summaries first, so anything imported there would be thrown away.
	const rows = db
		.prepare(
			`SELECT n.id AS norm_id, n.title AS norm_title, n.jurisdiction, n.rank,
			        b.block_id, b.title AS block_title, b.current_text
			 FROM norms n JOIN blocks b ON b.norm_id = n.id
			 WHERE n.status = 'vigente' AND n.citizen_summary != ''
			   AND b.block_type = 'precepto'
			   AND length(b.current_text) >= 50
			   AND NOT EXISTS (SELECT 1 FROM citizen_article_summaries c
			                   WHERE c.norm_id = n.id AND c.block_id = b.block_id)`,
		)
		.all() as (BackfillArticle & { jurisdiction: string; rank: string })[];

	const prio = (r: { jurisdiction: string; rank: string }) =>
		(r.jurisdiction === "es" ? 0 : 10) + (RANK_ORDER[r.rank] ?? 9);
	const kept = rows
		.filter((r) => hasSubstance(r.current_text))
		.sort(
			(a, b) =>
				prio(a) - prio(b) ||
				a.norm_id.localeCompare(b.norm_id) ||
				a.block_id.localeCompare(b.block_id),
		);
	const out: ExportRow[] = kept.map((r) => ({
		norm_id: r.norm_id,
		norm_title: r.norm_title,
		block_id: r.block_id,
		block_title: r.block_title,
		current_text: r.current_text,
		input_hash: textHash(r.current_text),
	}));
	await Bun.write(
		outFile,
		out.map((o) => JSON.stringify(o)).join("\n") + (out.length ? "\n" : ""),
	);
	console.log(
		`export: ${rows.length} pending, ${rows.length - out.length} without substance, ${out.length} written to ${outFile}`,
	);
}

/**
 * Regeneration export: articles of the given laws that already have a
 * (non-empty) summary, with the hash of that summary so that import
 * --replace-from only replaces it if it is still the same.
 */
async function exportRegenerate(outFile: string, normsFile: string) {
	const db = new Database(DB_PATH, { readonly: true });
	const normIds = JSON.parse(await Bun.file(normsFile).text()) as string[];
	const query = db.prepare(
		`SELECT n.id AS norm_id, n.title AS norm_title, b.block_id,
		        b.title AS block_title, b.current_text, c.summary
		 FROM norms n JOIN blocks b ON b.norm_id = n.id
		 JOIN citizen_article_summaries c ON c.norm_id = n.id AND c.block_id = b.block_id
		 WHERE n.id = ? AND n.status = 'vigente' AND n.citizen_summary != ''
		   AND b.block_type = 'precepto' AND length(b.current_text) >= 50
		   AND c.summary != ''
		 ORDER BY b.position`,
	);
	const out: string[] = [];
	for (const id of normIds)
		for (const r of query.all(id) as (BackfillArticle & { summary: string })[])
			out.push(
				JSON.stringify({
					norm_id: r.norm_id,
					norm_title: r.norm_title,
					block_id: r.block_id,
					block_title: r.block_title,
					current_text: r.current_text,
					input_hash: textHash(r.current_text),
					previous_summary_hash: textHash(r.summary),
				}),
			);
	await Bun.write(outFile, out.join("\n") + (out.length ? "\n" : ""));
	console.log(
		`export (regenerate): ${out.length} articles of ${normIds.length} laws written to ${outFile}`,
	);
}

async function generate(inFile: string, outFile: string) {
	await runGeneration({
		items: readJsonl<ExportRow>(inFile).rows,
		outFile,
		keyNames: ["norm_id", "block_id"],
		limit: Number(flag("--limit") ?? 0),
		body: (a) => ({
			temperature: 0.2,
			max_tokens: 1000,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: buildBatchPrompt([a]) },
			],
			response_format: { type: "json_schema", json_schema: BATCH_SCHEMA },
			chat_template_kwargs: { enable_thinking: false },
		}),
		toRow: (a, result, model) => {
			const parsed = parseBatchContent(result.text, 1);
			if ("error" in parsed) throw new Error(parsed.error.slice(0, 200));
			const out = parsed.outputs[0];
			if (!out) throw new Error("empty");
			return {
				input_hash: a.input_hash,
				model,
				summary: out.citizen_summary,
				tags: out.citizen_tags,
				finish: result.finish,
				usage: result.usage,
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
	const replaceFrom = flag("--replace-from");
	let replace: Map<string, string> | undefined;
	if (replaceFrom) {
		replace = new Map();
		for (const e of readJsonl<{
			norm_id: string;
			block_id: string;
			previous_summary_hash?: string;
		}>(replaceFrom).rows)
			if (e.previous_summary_hash)
				replace.set(`${e.norm_id}|${e.block_id}`, e.previous_summary_hash);
		console.log(`replace mode: ${replace.size} summaries may be replaced`);
	}
	const report = importRows(db, rows, { apply, replace });
	console.log(
		`${apply ? "APPLIED" : "DRY RUN (use --apply to write)"}: ${JSON.stringify({ ...report, badLines })}`,
	);
}

const [first, second] = positional;
const regenerate = flag("--regenerate");
if (cmd === "export" && first && regenerate)
	await exportRegenerate(first, regenerate);
else if (cmd === "export" && first) await exportPending(first);
else if (cmd === "generate" && first && second) await generate(first, second);
else if (cmd === "import" && first)
	importGenerated(first, args.includes("--apply"));
else {
	console.error(
		"Usage: article-summaries-offline.ts export <out.jsonl> | generate <in.jsonl> <out.jsonl> [--limit N] | import <generated.jsonl> [--apply]",
	);
	process.exit(1);
}
