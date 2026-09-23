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
 *
 * Generation uses the production prompt v10 (citizen-summary-backfill-prompt.ts)
 * with one article per request (the server batches; one article per request
 * avoids the id-mapping failures of multi-article prompts) and thinking off.
 * It is resumable: rows already in <out.jsonl> with ok=true are skipped.
 * Each row carries a hash of the article text; import skips rows whose article
 * changed since the export, and never overwrites an existing summary.
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { importRows, textHash } from "./article-summary-import.ts";
import {
	BATCH_SCHEMA,
	type BackfillArticle,
	buildBatchPrompt,
	parseBatchContent,
	SYSTEM_PROMPT,
} from "./citizen-summary-backfill-prompt.ts";

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
			!a.startsWith("--") && all[i - 1] !== "--db" && all[i - 1] !== "--limit",
	);

type ExportRow = BackfillArticle & { input_hash: string };

// Tolerates malformed lines (e.g. the last one, if generate was killed while
// appending): they are skipped and counted instead of aborting the run.
function readJsonl<T>(path: string): { rows: T[]; badLines: number } {
	const rows: T[] = [];
	let badLines = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as T);
		} catch {
			badLines++;
		}
	}
	return { rows, badLines };
}

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

async function generate(inFile: string, outFile: string) {
	const base = process.env.BASE ?? "http://127.0.0.1:8001/v1";
	const model = process.env.MODEL ?? "qwen3.8-27b";
	const concurrency = Number(process.env.CONC ?? 64);
	const limit = Number(flag("--limit") ?? 0);
	// Local endpoints only: never send a key unless explicitly given.
	const apiKey = process.env.GENERATE_API_KEY;

	const done = new Set<string>();
	if (existsSync(outFile))
		for (const o of readJsonl<{
			ok: boolean;
			norm_id: string;
			block_id: string;
		}>(outFile).rows)
			if (o.ok) done.add(`${o.norm_id}|${o.block_id}`);
	let items = readJsonl<ExportRow>(inFile).rows.filter(
		(a) => !done.has(`${a.norm_id}|${a.block_id}`),
	);
	if (limit > 0) items = items.slice(0, limit);
	console.log(`generate: ${items.length} to do, ${done.size} already done`);

	let next = 0;
	let ok = 0;
	let failed = 0;
	const started = Date.now();

	async function one(a: ExportRow) {
		let lastError = "";
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const res = await fetch(`${base}/chat/completions`, {
					method: "POST",
					signal: AbortSignal.timeout(600_000),
					headers: {
						"Content-Type": "application/json",
						...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
					},
					body: JSON.stringify({
						model,
						temperature: 0.2,
						max_tokens: 1000,
						messages: [
							{ role: "system", content: SYSTEM_PROMPT },
							{ role: "user", content: buildBatchPrompt([a]) },
						],
						response_format: { type: "json_schema", json_schema: BATCH_SCHEMA },
						chat_template_kwargs: { enable_thinking: false },
					}),
				});
				if (!res.ok)
					throw new Error(
						`http_${res.status}: ${(await res.text()).slice(0, 200)}`,
					);
				const data = (await res.json()) as {
					choices?: {
						message?: { content?: string };
						finish_reason?: string;
					}[];
					usage?: unknown;
				};
				const text = (data.choices?.[0]?.message?.content ?? "")
					.replace(/<think>[\s\S]*?<\/think>/g, "")
					.trim();
				const parsed = parseBatchContent(text, 1);
				if ("error" in parsed) throw new Error(parsed.error.slice(0, 200));
				const out = parsed.outputs[0];
				if (!out) throw new Error("empty");
				appendFileSync(
					outFile,
					`${JSON.stringify({
						ok: true,
						norm_id: a.norm_id,
						block_id: a.block_id,
						input_hash: a.input_hash,
						model,
						summary: out.citizen_summary,
						tags: out.citizen_tags,
						finish: data.choices?.[0]?.finish_reason,
						usage: data.usage,
					})}\n`,
				);
				ok++;
				return;
			} catch (e) {
				lastError = (e as Error).message;
			}
		}
		failed++;
		appendFileSync(
			outFile,
			`${JSON.stringify({ ok: false, norm_id: a.norm_id, block_id: a.block_id, error: lastError.slice(0, 300) })}\n`,
		);
	}

	const timer = setInterval(() => {
		const s = (Date.now() - started) / 1000;
		const rate = ok / s;
		console.log(
			`[${s.toFixed(0)}s] ok=${ok} failed=${failed} ${rate.toFixed(2)}/s eta ${((items.length - ok - failed) / Math.max(rate, 0.01) / 60).toFixed(0)} min`,
		);
	}, 30_000);
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (next < items.length) {
				const item = items[next++];
				if (item) await one(item);
			}
		}),
	);
	clearInterval(timer);
	console.log(`generate: done, ok=${ok} failed=${failed}`);
}

function importGenerated(file: string, apply: boolean) {
	// Dry run never writes; neither mode creates a DB from a mistyped path.
	const db = apply
		? new Database(DB_PATH, { create: false, readwrite: true })
		: new Database(DB_PATH, { readonly: true });
	db.run("PRAGMA busy_timeout = 30000");
	const { rows, badLines } = readJsonl<unknown>(file);
	const report = importRows(db, rows, { apply });
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
		"Usage: article-summaries-offline.ts export <out.jsonl> | generate <in.jsonl> <out.jsonl> [--limit N] | import <generated.jsonl> [--apply]",
	);
	process.exit(1);
}
