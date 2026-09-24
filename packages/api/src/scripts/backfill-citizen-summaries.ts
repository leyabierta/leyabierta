/**
 * Backfill citizen summaries for all articles that don't have one.
 *
 * LLM: OpenRouter, model CONTENT_LLM_MODEL (default google/gemini-2.5-flash-lite).
 * The prompt (iteration 7, few-shot) was tuned on Qwen 3.6 via NaN, which was
 * cancelled in 2026-08. Manual script, NOT run by the daily cron; the full
 * scope is ~335K articles, so always start with --limit.
 *
 * Usage:
 *   bun run packages/api/src/scripts/backfill-citizen-summaries.ts [--limit N] [--dry-run] [--force]
 *
 * - --limit N: process only N articles (for testing)
 * - --dry-run: sample articles but don't write to DB
 * - --force: also reprocess articles that already have a summary (default: skip them)
 *
 * Checkpoints every 100 articles. Resume from last checkpoint on restart.
 *
 * Target scope: vigentes + block_type='precepto' + length >= 200 chars
 * = ~335K articles. Lower bound 200 skips placeholders ("(Derogado)", entry-
 * into-force boilerplate). No upper bound: Qwen 3.6 has 256K context and the
 * longest article in the corpus is ~327K chars; long articles (> 5K chars)
 * are dispatched solo per call, small ones batched in groups of 5.
 *
 * Env: OPENROUTER_API_KEY (required unless a local endpoint is set),
 * CONTENT_LLM_MODEL.
 *
 * Local backend (opt-in; see contentLlmEndpoint in services/openrouter.ts):
 * CONTENT_LLM_BASE_URL=http://localhost:11434/v1 CONTENT_LLM_MODEL=qwen3.8:27b-mlx
 * sends the same prompt to any OpenAI-compatible server (e.g. Ollama) with
 * reasoning disabled. Prompt, schema and parser live in
 * citizen-summary-backfill-prompt.ts.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	ARTICLE_SUMMARY_PROMPT_VERSION,
	hasForeignScript,
	normalizeModelId,
} from "@leyabierta/pipeline";
import { contentLlmEndpoint, stripThinking } from "../services/openrouter.ts";
import {
	BATCH_SCHEMA,
	type BackfillArticle,
	type BatchSummary,
	buildBatchPrompt,
	parseBatchContent,
	SYSTEM_PROMPT,
} from "./citizen-summary-backfill-prompt.ts";

// ── Configuration ──────────────────────────────────────────────────────────

const DB_PATH = "data/leyabierta.db";
const FAILURE_LOG = "data/backfill-failures.jsonl";
const PROGRESS_FILE = "data/backfill-progress.json";

// Qwen rate limit: max 5 concurrent
// Override via QWEN_BATCH_SIZE env var (1-10). Lower batch size avoids the
// position-based-mapping risk when the model returns fewer items than sent.
const API_BATCH_SIZE = Math.max(
	1,
	Math.min(10, Number(process.env.QWEN_BATCH_SIZE ?? 5)),
); // articles per API call (batching)
// Articles longer than this go solo (1 per API call) instead of being grouped
// in a batch of 5. Qwen 3.6 has 256K context so any single article fits, but
// stuffing several huge articles into one call wastes throughput on retries
// when the response gets truncated. 5K chars (~1.7K tokens) is the soft
// threshold where solo dispatch starts paying off.
const SOLO_THRESHOLD_CHARS = Number(process.env.QWEN_SOLO_THRESHOLD ?? 5000);
const CHECKPOINT_INTERVAL = 100; // checkpoint every N articles
const ENDPOINT = contentLlmEndpoint();
// 3 minutes per individual request on OpenRouter; CONTENT_LLM_TIMEOUT_MS locally.
const REQUEST_TIMEOUT_MS = ENDPOINT.timeoutMs ?? 180_000;
const LLM_BASE_URL = ENDPOINT.baseUrl ?? "https://openrouter.ai/api/v1";
const LLM_MODEL = ENDPOINT.model;
const LLM_API_KEY = ENDPOINT.apiKey;
if (!LLM_API_KEY && !ENDPOINT.baseUrl) {
	console.error("Error: OPENROUTER_API_KEY env var is required");
	process.exit(1);
}

// Single-article schema (kept for reference, not used in batch mode)
const _SCHEMA = {
	name: "citizen_metadata",
	strict: true,
	schema: {
		type: "object",
		properties: {
			citizen_tags: { type: "array", items: { type: "string" } },
			citizen_summary: { type: "string" },
		},
		required: ["citizen_tags", "citizen_summary"],
		additionalProperties: false,
	},
};

// ── CLI Arguments ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIMIT = args.includes("--limit")
	? Number(args[args.indexOf("--limit") + 1] ?? 100)
	: 0;
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const CONCURRENCY = args.includes("--concurrency")
	? Math.max(
			1,
			Math.min(10, Number(args[args.indexOf("--concurrency") + 1] ?? 5)),
		)
	: 5;

if ((LIMIT > 0 && !Number.isInteger(LIMIT)) || LIMIT < 0) {
	console.error("Invalid --limit value. Must be a positive integer.");
	process.exit(1);
}

// ── Database Setup ─────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

// Create checkpoint table if not exists (must be before stmt.prepare)
db.exec(`CREATE TABLE IF NOT EXISTS backfill_checkpoint (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	last_norm_id TEXT,
	last_block_id TEXT,
	processed_count INTEGER DEFAULT 0,
	last_updated TEXT
)`);

// Checkpoint schema
const stmtGetCheckpoint = db.prepare(
	"SELECT last_norm_id, last_block_id, processed_count, last_updated FROM backfill_checkpoint LIMIT 1",
);
const stmtUpsertCheckpoint = db.prepare(
	`INSERT OR REPLACE INTO backfill_checkpoint (id, last_norm_id, last_block_id, processed_count, last_updated)
	 VALUES (1, ?, ?, ?, datetime('now'))
	 ON CONFLICT(id) DO UPDATE SET last_norm_id=excluded.last_norm_id,
	                                last_block_id=excluded.last_block_id,
	                                processed_count=excluded.processed_count,
	                                last_updated=excluded.last_updated`,
);

// Write statements: hoisted to module level so we don't recompile the same SQL
// ~1.5M times during a 433K-article run.
const stmtInsertSummary = db.prepare(
	`INSERT OR REPLACE INTO citizen_article_summaries
	   (norm_id, block_id, summary, model, prompt_version, generated_at)
	 VALUES (?, ?, ?, ?, ?, datetime('now'))`,
);
const stmtInsertTag = db.prepare(
	"INSERT OR REPLACE INTO citizen_tags (norm_id, block_id, tag) VALUES (?, ?, ?)",
);

// ── Article Sampling ───────────────────────────────────────────────────────

type Article = BackfillArticle;

function sampleArticles(startFrom?: {
	norm_id: string;
	block_id: string;
}): Article[] {
	// Lower bound 200: articles below that are usually placeholder text
	// ("(Derogado)", "esta Ley entra en vigor...") with no substance to summarize.
	// No upper bound: long articles (Código Penal, leyes orgánicas, "Artículo
	// único" containing whole laws) are exactly where citizens benefit most from
	// a plain-language summary. Qwen 3.6's 256K context fits any article in the
	// corpus (max observed: 327K chars). Long articles are dispatched solo, see
	// SOLO_THRESHOLD_CHARS.
	let where = `
		WHERE n.status = 'vigente'
		  AND b.block_type = 'precepto'
		  AND length(b.current_text) >= 200`;
	const params: (string | number)[] = [];

	if (!FORCE) {
		where += `
		  AND NOT EXISTS (
			SELECT 1 FROM citizen_article_summaries c
			WHERE c.norm_id = n.id AND c.block_id = b.block_id
		  )`;
	}

	if (startFrom) {
		where += ` AND (n.id > ? OR (n.id = ? AND b.block_id > ?))`;
		params.push(startFrom.norm_id, startFrom.norm_id, startFrom.block_id);
	}

	let query = `
		SELECT n.id AS norm_id, n.title AS norm_title, b.block_id, b.title AS block_title, b.current_text
		FROM norms n
		JOIN blocks b ON b.norm_id = n.id
		${where}
		ORDER BY n.id, b.block_id`;

	if (LIMIT > 0) {
		query += ` LIMIT ?`;
		params.push(LIMIT);
	}

	return db.prepare(query).all(...params) as Article[];
}

// ── Qwen API (Batch Mode) ──────────────────────────────────────────────────

async function callQwenBatch(
	articles: Article[],
): Promise<{ outputs: (BatchSummary | null)[]; error: string | null }> {
	const prompt = buildBatchPrompt(articles);
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
				"HTTP-Referer": "https://leyabierta.es",
				"X-Title": "Ley Abierta",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: LLM_MODEL,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: prompt },
				],
				temperature: 0.2,
				// Output is ~500 tokens per summary. A solo huge article still
				// produces only one summary, so 2K is enough for any solo call;
				// keep the cap as a safety against runaway generation.
				max_tokens: 2000,
				response_format: { type: "json_schema", json_schema: BATCH_SCHEMA },
				...ENDPOINT.extraBody,
			}),
		});

		if (!res.ok) {
			const body = await res.text();
			return {
				outputs: [],
				error: `http_${res.status}: ${body.slice(0, 200)}`,
			};
		}

		const data = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
		};

		const text = data.choices?.[0]?.message?.content ?? "";
		const parsedBatch = parseBatchContent(stripThinking(text), articles.length);
		if ("error" in parsedBatch) {
			return { outputs: [], error: parsedBatch.error };
		}
		const { outputs } = parsedBatch;

		return { outputs, error: null };
	} catch (e) {
		if ((e as Error).name === "AbortError") {
			return {
				outputs: [],
				error: `timeout: request exceeded ${REQUEST_TIMEOUT_MS}ms`,
			};
		}
		return { outputs: [], error: `fetch_error: ${(e as Error).message}` };
	} finally {
		clearTimeout(timeoutId);
	}
}

// Single-article fallback: if the batch left some positions as null
// (the model occasionally returns N-1 items for a batch of N), retry the
// missing items one by one before giving up.
async function fillMissingWithSingles(
	articles: Article[],
	outputs: (BatchSummary | null)[],
): Promise<(BatchSummary | null)[]> {
	for (let i = 0; i < articles.length; i++) {
		if (outputs[i] !== null) continue;
		const article = articles[i];
		if (!article) continue;
		// Single-article batch retains the same prompt/schema and lets the
		// id-based mapping resolve the result back into position i.
		const single = await callQwenBatch([article]);
		if (!single.error && single.outputs[0]) {
			outputs[i] = single.outputs[0];
		}
	}
	return outputs;
}

async function callQwenBatchWithRetry(
	articles: Article[],
): Promise<{ outputs: (BatchSummary | null)[]; error: string | null }> {
	const result = await callQwenBatch(articles);

	if (!result.error) {
		// Fill in any missing items the batch dropped.
		const hasMissing = result.outputs.some((o) => o === null);
		if (hasMissing) {
			result.outputs = await fillMissingWithSingles(articles, result.outputs);
		}
		return result;
	}

	// Aggressive retry strategy: timeout/5xx → long exponential backoff up to
	// 6 attempts (NaN endpoint occasionally serves persistent 502s for ~1-2
	// minutes when the upstream is overloaded); 429 → fixed 65s wait;
	// json_parse → quick retries.
	let last = result;
	for (let attempt = 1; attempt <= 6; attempt++) {
		const err = last.error ?? "";
		let waitMs: number;
		if (err.includes("429")) {
			waitMs = 65_000 + Math.random() * 5000;
		} else if (
			err.includes("timeout") ||
			err.includes("524") ||
			/http_5\d\d/.test(err)
		) {
			// 10s, 30s, 60s, 120s, 180s, 240s with jitter — total ~10min
			const schedule = [10_000, 30_000, 60_000, 120_000, 180_000, 240_000];
			const base =
				schedule[Math.min(attempt - 1, schedule.length - 1)] ?? 10_000;
			waitMs = base + Math.random() * (base / 4);
		} else if (err.includes("json_parse")) {
			waitMs = 1500 + Math.random() * 1500 + attempt * 1000;
		} else {
			waitMs = 1000 + Math.random() * 1000;
		}
		await new Promise((r) => setTimeout(r, waitMs));
		const next = await callQwenBatch(articles);
		if (!next.error) {
			const hasMissing = next.outputs.some((o) => o === null);
			if (hasMissing) {
				next.outputs = await fillMissingWithSingles(articles, next.outputs);
			}
			return next;
		}
		last = next;
	}

	// All batch retries exhausted. Last resort: try each article individually.
	// A persistent 5xx on a 5-item batch sometimes succeeds when split (one
	// of the articles may be triggering server-side issues).
	const singles: (BatchSummary | null)[] = articles.map(() => null);
	const filled = await fillMissingWithSingles(articles, singles);
	const recovered = filled.filter((o) => o !== null).length;
	if (recovered > 0) {
		// At least one recovered → return without error so writes happen.
		// Items still null become per-article errors via the existing
		// missing_in_batch_response path in main.
		return { outputs: filled, error: null };
	}
	return last;
}

// ── Concurrency Pool ───────────────────────────────────────────────────────

interface BatchProgress {
	completed: number;
	total: number;
	processed: number;
	startedAt: number;
}

function _drawProgressBar(p: BatchProgress, width: number = 50): string {
	const frac = p.completed / p.total;
	const filled = Math.round(width * frac);
	const bar = "█".repeat(filled) + "░".repeat(width - filled);
	const pct = (frac * 100).toFixed(1).padStart(5);
	const elapsed = ((Date.now() - p.startedAt) / 1000).toFixed(0);
	const rate =
		p.completed > 0
			? (p.completed / ((Date.now() - p.startedAt) / 1000)).toFixed(2)
			: "0.00";
	const remaining = p.total - p.completed;
	const eta =
		p.completed > 0
			? (
					remaining /
					(p.completed / ((Date.now() - p.startedAt) / 1000)) /
					60
				).toFixed(1)
			: "∞";

	return (
		`[${bar}] ${pct}% ` +
		`(${p.completed}/${p.total}) ` +
		`${rate}/s ` +
		`eta ~${eta}m ` +
		`(${elapsed}s elapsed)`
	);
}

async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, idx: number) => Promise<R>,
	onProgress?: (p: BatchProgress) => void,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	let completed = 0;
	const startedAt = Date.now();

	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const i = cursor++;
				if (i >= items.length) return;
				// Bounds already checked above, so items[i] is always defined here.
				results[i] = await fn(items[i]!, i);
				completed++;

				if (onProgress) {
					onProgress({
						completed,
						total: items.length,
						processed: completed,
						startedAt,
					});
				}
			}
		},
	);

	await Promise.all(workers);
	return results;
}

// ── Progress Tracking ──────────────────────────────────────────────────────

interface Progress {
	total: number;
	processed: number;
	success: number;
	empty: number;
	errors: number;
	startedAt: string;
	finishedAt?: string;
}

function loadProgress(): Progress | null {
	try {
		const existing = readFileSync(PROGRESS_FILE, "utf-8");
		return JSON.parse(existing) as Progress;
	} catch (e) {
		// Corrupted/partial file from a crash mid-write: fall back to a fresh
		// Progress instead of crashing the resume.
		console.warn(
			`Could not load progress file (${(e as Error).message}); starting fresh.`,
		);
		return null;
	}
}

function saveProgress(p: Progress) {
	writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function createProgress(total: number): Progress {
	return {
		total,
		processed: 0,
		success: 0,
		empty: 0,
		errors: 0,
		startedAt: new Date().toISOString(),
	};
}

// ── Main ───────────────────────────────────────────────────────────────────

function getTargetTotal(): number {
	// Total articles matching the same WHERE clause as `sampleArticles`, ignoring
	// the resume checkpoint and the FORCE flag. Used to render an absolute
	// progress bar (X/335K) instead of one relative to the current run only.
	return (
		db
			.query<{ c: number }, []>(
				`SELECT COUNT(*) c FROM norms n JOIN blocks b ON b.norm_id=n.id
				 WHERE n.status='vigente' AND b.block_type='precepto'
				   AND length(b.current_text) >= 200`,
			)
			.get()?.c ?? 0
	);
}

function getDoneTotal(): number {
	// Only count summaries on articles still in scope. Without this the absolute
	// bar drifts when the scope changes (e.g. lifting the upper bound).
	return (
		db
			.query<{ c: number }, []>(
				`SELECT COUNT(*) c FROM citizen_article_summaries c
				 JOIN norms n ON n.id = c.norm_id
				 JOIN blocks b ON b.norm_id = c.norm_id AND b.block_id = c.block_id
				 WHERE n.status='vigente' AND b.block_type='precepto'
				   AND length(b.current_text) >= 200`,
			)
			.get()?.c ?? 0
	);
}

function renderGlobalBar(opts: {
	doneAbs: number;
	targetAbs: number;
	successRun: number;
	errorsRun: number;
	emptyRun: number;
	processedRun: number;
	totalRun: number;
	startedAt: string;
}): void {
	const pct = opts.targetAbs > 0 ? (opts.doneAbs / opts.targetAbs) * 100 : 0;
	const filled = Math.round(40 * (pct / 100));
	const bar = "█".repeat(filled) + "░".repeat(40 - filled);
	const elapsed = Math.max(
		(Date.now() - new Date(opts.startedAt).getTime()) / 1000,
		1,
	);
	const rate = opts.processedRun / elapsed;
	const remaining = opts.targetAbs - opts.doneAbs;
	const etaH = rate > 0 ? remaining / rate / 3600 : 0;
	const line = `[${bar}] ${pct.toFixed(1).padStart(5)}%  ${opts.doneAbs.toLocaleString()}/${opts.targetAbs.toLocaleString()}  ✓${opts.successRun} ✗${opts.errorsRun} ○${opts.emptyRun}  ${rate.toFixed(1)}/s  ETA ${etaH.toFixed(1)}h`;
	process.stdout.write(`\r${line}   `);
}

async function main() {
	console.log(`=== Citizen Summaries Backfill ===`);
	const targetTotal = getTargetTotal();
	const doneAtStart = getDoneTotal();
	console.log(
		`Target scope: ${targetTotal.toLocaleString()} vigentes (≥200 chars, no upper bound)`,
	);
	console.log(
		`Already done: ${doneAtStart.toLocaleString()} (${((doneAtStart / Math.max(targetTotal, 1)) * 100).toFixed(1)}%)`,
	);
	console.log(`Limit: ${LIMIT > 0 ? LIMIT : "all"}`);
	console.log(`Dry run: ${DRY_RUN}`);
	console.log(
		`Batching: groups of ${API_BATCH_SIZE}, articles > ${SOLO_THRESHOLD_CHARS.toLocaleString()} chars go solo`,
	);
	console.log(`Concurrency: ${CONCURRENCY}`);
	console.log(``);

	// Load checkpoint
	interface CheckpointRow {
		last_norm_id: string;
		last_block_id: string;
		processed_count: number;
	}

	const checkpoint = stmtGetCheckpoint.get() as CheckpointRow | null;

	const startFrom = checkpoint
		? { norm_id: checkpoint.last_norm_id, block_id: checkpoint.last_block_id }
		: undefined;

	if (startFrom && checkpoint) {
		console.log(
			`Resuming from checkpoint: ${startFrom.norm_id}::${startFrom.block_id} (processed ${checkpoint.processed_count})`,
		);
	}

	// Sample articles
	const articles = sampleArticles(startFrom);
	console.log(`Found ${articles.length} articles to process.`);

	if (articles.length === 0) {
		console.log("No articles to process. Done.");
		return;
	}

	// Load or create progress. The persisted counters (`progress.success`,
	// `progress.errors`, `progress.processed`, `progress.empty`) are CUMULATIVE
	// across runs — they survive in `data/backfill-progress.json`. For the
	// progress bar we need the *current run's* deltas, so capture a baseline
	// here and subtract it whenever we render.
	let progress: Progress;
	const existing = existsSync(PROGRESS_FILE) ? loadProgress() : null;
	if (existing) {
		progress = existing;
		// Reset startedAt to now so ETA is based on current run
		progress.startedAt = new Date().toISOString();
		console.log(
			`Resuming progress: ${progress.success} success, ${progress.errors} errors, ${progress.empty} empty`,
		);
	} else {
		progress = createProgress(articles.length);
	}
	const baselineSuccess = progress.success;
	const baselineErrors = progress.errors;
	const baselineEmpty = progress.empty;
	const baselineProcessed = progress.processed;

	// Render initial bar so the user sees something immediately.
	renderGlobalBar({
		doneAbs: doneAtStart,
		targetAbs: targetTotal,
		successRun: 0,
		errorsRun: 0,
		emptyRun: 0,
		processedRun: 0,
		totalRun: articles.length,
		startedAt: progress.startedAt,
	});

	// Process in batches
	for (
		let batchStart = 0;
		batchStart < articles.length;
		batchStart += CHECKPOINT_INTERVAL
	) {
		const batchEnd = Math.min(
			batchStart + CHECKPOINT_INTERVAL,
			articles.length,
		);
		const batch = articles.slice(batchStart, batchEnd);

		// Dynamic batching: long articles (> SOLO_THRESHOLD_CHARS) are dispatched
		// solo, small articles are grouped up to API_BATCH_SIZE. Order is
		// preserved so the checkpoint cursor stays meaningful.
		const apiBatches: Article[][] = [];
		let acc: Article[] = [];
		for (const article of batch) {
			if (article.current_text.length > SOLO_THRESHOLD_CHARS) {
				if (acc.length > 0) {
					apiBatches.push(acc);
					acc = [];
				}
				apiBatches.push([article]);
			} else {
				acc.push(article);
				if (acc.length >= API_BATCH_SIZE) {
					apiBatches.push(acc);
					acc = [];
				}
			}
		}
		if (acc.length > 0) apiBatches.push(acc);

		// Process API batches concurrently. Progress is rendered after the whole
		// checkpoint batch finishes — per-API-batch updates were too noisy.
		const allResults: {
			article: Article;
			outputs: (BatchSummary | null)[];
			error: string | null;
		}[] = [];

		await mapPool(apiBatches, CONCURRENCY, async (apiBatch, idx) => {
			const result = await callQwenBatchWithRetry(apiBatch);
			const firstArticle = apiBatch[0];
			if (!firstArticle) throw new Error("apiBatch must not be empty");
			allResults[idx] = {
				article: firstArticle,
				outputs: result.outputs,
				error: result.error,
			};
			return allResults[idx];
		});

		// Flatten results: map each article to its summary
		const flatResults: {
			article: Article;
			output: BatchSummary | null;
			error: string | null;
		}[] = [];
		for (let apiBatchIdx = 0; apiBatchIdx < allResults.length; apiBatchIdx++) {
			const apiBatch = apiBatches[apiBatchIdx];
			const batchResult = allResults[apiBatchIdx];
			if (!apiBatch || !batchResult) continue;
			const { outputs, error } = batchResult;

			for (let i = 0; i < apiBatch.length; i++) {
				const article = apiBatch[i];
				if (!article) continue;
				flatResults.push({
					article,
					output: outputs[i] ?? null,
					error: error ?? null,
				});
			}
		}

		// Write results
		for (const { article, output, error } of flatResults) {
			progress.processed++;

			// `null` output means the model dropped this article from the batch
			// (article_id mismatch, partial response, etc). Treat as error so it
			// gets logged and retried — never as a silent "empty".
			const realError =
				error ?? (output === null ? "missing_in_batch_response" : null);

			if (realError) {
				progress.errors++;
				writeFileSync(
					FAILURE_LOG,
					`${JSON.stringify({
						norm_id: article.norm_id,
						block_id: article.block_id,
						error: realError,
						timestamp: new Date().toISOString(),
					})}\n`,
					{ flag: "a" },
				);
			} else if (output && output.citizen_summary === "") {
				// True empty: model explicitly returned "". With minLength:10 in the
				// schema this should be unreachable, but kept as a safety net.
				progress.empty++;
			} else if (
				output &&
				hasForeignScript(output.citizen_summary, ...(output.citizen_tags ?? []))
			) {
				// Model switched language ("…por servicio军事"): never stored, and
				// logged like any other failure so it can be retried.
				progress.errors++;
				writeFileSync(
					FAILURE_LOG,
					`${JSON.stringify({
						norm_id: article.norm_id,
						block_id: article.block_id,
						error: "foreign_script",
						timestamp: new Date().toISOString(),
					})}\n`,
					{ flag: "a" },
				);
			} else if (output) {
				progress.success++;

				if (!DRY_RUN) {
					stmtInsertSummary.run(
						article.norm_id,
						article.block_id,
						output.citizen_summary,
						normalizeModelId(LLM_MODEL),
						ARTICLE_SUMMARY_PROMPT_VERSION,
					);
					for (const tag of output.citizen_tags) {
						stmtInsertTag.run(article.norm_id, article.block_id, tag);
					}
				}
			}
		}

		// Checkpoint
		const lastArticle = batch[batch.length - 1];
		if (!DRY_RUN && lastArticle) {
			const totalProcessed = (checkpoint?.processed_count ?? 0) + batchEnd;
			stmtUpsertCheckpoint.run(
				lastArticle.norm_id,
				lastArticle.block_id,
				totalProcessed,
			);
		}

		if (!DRY_RUN) {
			saveProgress(progress);
		}

		// Re-render the global progress bar after each checkpoint batch.
		// `*Run` counters are deltas vs the resume baseline, so the bar reflects
		// THIS run's throughput while `doneAbs` reflects total completion.
		renderGlobalBar({
			doneAbs: doneAtStart + (progress.success - baselineSuccess),
			targetAbs: targetTotal,
			successRun: progress.success - baselineSuccess,
			errorsRun: progress.errors - baselineErrors,
			emptyRun: progress.empty - baselineEmpty,
			processedRun: progress.processed - baselineProcessed,
			totalRun: articles.length,
			startedAt: progress.startedAt,
		});
	}
	// Newline after the final bar so the summary that follows is on its own line.
	console.log();

	// Final summary
	console.log(`\n=== Backfill Complete ===`);
	console.log(`Total: ${articles.length}`);
	console.log(
		`Success: ${progress.success} (${((progress.success / articles.length) * 100).toFixed(1)}%)`,
	);
	console.log(
		`Empty: ${progress.empty} (${((progress.empty / articles.length) * 100).toFixed(1)}%)`,
	);
	console.log(
		`Errors: ${progress.errors} (${((progress.errors / articles.length) * 100).toFixed(1)}%)`,
	);
	console.log(`Failure log: ${FAILURE_LOG}`);
}

// Write real-time error log for debugging
const ERROR_LOG = "data/backfill-error-debug.log";
function logError(msg: string) {
	try {
		writeFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`, {
			flag: "a",
		});
	} catch {}
}

main().catch((err) => {
	logError(`Fatal error: ${(err as Error).message}\n${(err as Error).stack}`);
	process.exit(1);
});
