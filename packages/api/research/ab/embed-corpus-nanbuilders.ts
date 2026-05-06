/**
 * Generate Qwen3-Embedding-8B embeddings via nan.builders (LiteLLM-backed,
 * unmetered). Sibling of `embed-corpus-openrouter.ts` — same corpus + batch +
 * SQLite layout, only the HTTP target changes.
 *
 * Endpoint: https://api.nan.builders/v1/embeddings
 * Model:    qwen3-embedding (returns 4096 dims with encoding_format=float)
 *
 * Important: `encoding_format: "float"` MUST be sent. Without it LiteLLM
 * forwards `null` to the serving model and the request 400s. Confirmed by
 * Cristian Córdova (nan.builders) on 2026-05-05.
 *
 * Usage:
 *   NAN_API_KEY=sk-... bun packages/api/research/ab/embed-corpus-nanbuilders.ts --dry-run
 *   NAN_API_KEY=sk-... bun packages/api/research/ab/embed-corpus-nanbuilders.ts --limit 50
 *   NAN_API_KEY=sk-... bun packages/api/research/ab/embed-corpus-nanbuilders.ts
 *   NAN_API_KEY=sk-... bun packages/api/research/ab/embed-corpus-nanbuilders.ts --resume
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "../../../pipeline/src/db/schema.ts";
import { EMBEDDING_MODELS } from "../../src/services/rag/embeddings.ts";
import { buildCorpusPlan } from "./corpus.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;

const MODEL_KEY = "qwen3-nan";
const model = EMBEDDING_MODELS[MODEL_KEY];
if (!model) throw new Error(`Unknown model key: ${MODEL_KEY}`);

const NAN_URL = "https://api.nan.builders/v1/embeddings";
const apiKey = process.env.NAN_API_KEY;
if (!apiKey && !dryRun) {
	console.error("NAN_API_KEY required");
	process.exit(1);
}

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

console.log("Building corpus plan...");
const plan = await buildCorpusPlan(db);
console.log(
	`  Norms: ${plan.counts.evalNorms} eval + ${plan.counts.distractorNorms} distractors = ${plan.normIds.length}`,
);
console.log(
	`  Articles: ${plan.counts.articles} → Chunks: ${plan.counts.chunks}`,
);

let workBlocks = plan.blocks;
if (limit) workBlocks = workBlocks.slice(0, limit);

if (resume) {
	const existing = db
		.query<{ norm_id: string; block_id: string }, [string]>(
			"SELECT norm_id, block_id FROM embeddings WHERE model = ?",
		)
		.all(MODEL_KEY);
	const have = new Set(existing.map((r) => `${r.norm_id}|${r.block_id}`));
	const before = workBlocks.length;
	workBlocks = workBlocks.filter((b) => !have.has(`${b.normId}|${b.blockId}`));
	console.log(
		`  Resume: skipping ${before - workBlocks.length} already embedded, ${workBlocks.length} remaining.`,
	);
}

if (dryRun) {
	const totalChars = workBlocks.reduce((s, b) => s + b.text.length, 0);
	const estTokens = Math.round(totalChars / 4);
	console.log(
		`\n[dry-run] Would embed ${workBlocks.length} chunks via nan.builders`,
	);
	console.log(
		`  Avg text length: ${Math.round(totalChars / Math.max(1, workBlocks.length))} chars`,
	);
	console.log(`  Est. tokens: ${estTokens.toLocaleString()} (unmetered — $0)`);
	console.log(`\nSample chunk:\n${workBlocks[0]?.text.slice(0, 300)}...`);
	process.exit(0);
}

if (workBlocks.length === 0) {
	console.log("Nothing to embed.");
	process.exit(0);
}

const latencyStats = {
	successCount: 0,
	totalMs: 0,
	min: Number.POSITIVE_INFINITY,
	max: 0,
	samples: [] as number[],
};

async function nanEmbed(texts: string[]): Promise<{
	data: Array<{ index: number; embedding: number[] }>;
	usage?: Record<string, unknown>;
} | null> {
	const body = JSON.stringify({
		model: model.id,
		input: texts,
		encoding_format: "float",
	});

	const MAX_ATTEMPTS = 8;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			// 429 (rate limit) cooldown is ~60s on this server. 524 (CF timeout)
			// also benefits from a long wait so the upstream queue drains. Use
			// 60s base + small jitter to desync workers.
			const delay = 60_000 + Math.floor(Math.random() * 15_000);
			await new Promise((r) => setTimeout(r, delay));
		}
		const reqStart = Date.now();
		try {
			const res = await fetch(NAN_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body,
				signal: AbortSignal.timeout(300_000),
			});
			if (res.status === 429 || res.status >= 500) {
				console.warn(
					`  HTTP ${res.status} — retrying (${attempt + 1}/${MAX_ATTEMPTS})`,
				);
				continue;
			}
			if (!res.ok) {
				const errText = await res.text();
				// 4xx (other than 429) is a client error — no point retrying.
				throw new Error(
					`HTTP ${res.status} (no-retry): ${errText.slice(0, 300)}`,
				);
			}
			const json = (await res.json()) as {
				data: Array<{ index: number; embedding: number[] }>;
				usage?: Record<string, unknown>;
			};
			if (!json.data || !Array.isArray(json.data)) {
				console.warn(`  Bad response shape — retrying`);
				continue;
			}
			const reqMs = Date.now() - reqStart;
			latencyStats.successCount += 1;
			latencyStats.totalMs += reqMs;
			latencyStats.min = Math.min(latencyStats.min, reqMs);
			latencyStats.max = Math.max(latencyStats.max, reqMs);
			latencyStats.samples.push(reqMs);
			const perEmb = (reqMs / texts.length).toFixed(0);
			console.log(
				`  ✓ batch=${texts.length} ${(reqMs / 1000).toFixed(1)}s (${perEmb}ms/emb)`,
			);
			return json;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`  Fetch error attempt ${attempt + 1}/${MAX_ATTEMPTS}: ${msg.slice(0, 200)}`,
			);
			if (msg.includes("(no-retry)")) return null;
		}
	}
	return null;
}

const insertStmt = db.prepare(
	"INSERT OR REPLACE INTO embeddings (norm_id, block_id, model, vector) VALUES (?, ?, ?, ?)",
);

const BATCH_SIZE = 16;
const CONCURRENCY = 3;
const totalBatches = Math.ceil(workBlocks.length / BATCH_SIZE);
let inserted = 0;
let skippedBatches = 0;
let totalTokens = 0;
let dimsSeen: number | null = null;
const startedAt = Date.now();

let nextBatch = 0;

async function worker(workerId: number): Promise<void> {
	while (true) {
		const batchIdx = nextBatch++;
		if (batchIdx >= totalBatches) return;
		const start = batchIdx * BATCH_SIZE;
		const batch = workBlocks.slice(start, start + BATCH_SIZE);
		const texts = batch.map((b) => b.text.slice(0, 24000));

		const data = await nanEmbed(texts);
		if (!data) {
			skippedBatches++;
			console.warn(
				`\n  ⚠ [w${workerId}] Batch ${batchIdx + 1}: SKIPPED (chunks ${start}-${start + batch.length - 1})`,
			);
			continue;
		}

		const usage = (data.usage ?? {}) as { total_tokens?: number };
		totalTokens += usage.total_tokens ?? 0;

		db.exec("BEGIN IMMEDIATE");
		try {
			for (const item of data.data) {
				const article = batch[item.index]!;
				const vec = new Float32Array(item.embedding);
				if (dimsSeen === null) {
					dimsSeen = vec.length;
					console.log(`  First batch returned ${dimsSeen} dims`);
					if (dimsSeen !== model.dimensions) {
						console.warn(
							`  ⚠ Dim mismatch: expected ${model.dimensions}, got ${dimsSeen}`,
						);
					}
				} else if (vec.length !== dimsSeen) {
					throw new Error(
						`Inconsistent dims: ${vec.length} != ${dimsSeen} (chunk ${article.normId}/${article.blockId})`,
					);
				}
				insertStmt.run(
					article.normId,
					article.blockId,
					MODEL_KEY,
					Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
				);
				inserted++;
			}
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}

		if ((batchIdx + 1) % 5 === 0 || batchIdx + 1 === totalBatches) {
			const elapsed = (Date.now() - startedAt) / 1000;
			const rate = inserted / elapsed;
			const remaining = (workBlocks.length - inserted) / Math.max(rate, 0.01);
			const pct = ((inserted / workBlocks.length) * 100).toFixed(1);
			process.stdout.write(
				`\r  ${inserted}/${workBlocks.length} (${pct}%) — ${rate.toFixed(1)} emb/s — ETA ${(remaining / 60).toFixed(1)}m`,
			);
		}
	}
}

console.log(
	`Starting ${CONCURRENCY} concurrent workers, batch=${BATCH_SIZE}, ${totalBatches} batches total`,
);
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

const elapsedMin = (Date.now() - startedAt) / 60000;
console.log(
	`\n\n✅ Done: ${inserted} embeddings in ${elapsedMin.toFixed(1)} min (${dimsSeen} dims)`,
);

if (latencyStats.successCount > 0) {
	const sorted = [...latencyStats.samples].sort((a, b) => a - b);
	const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
	const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
	const avgMs = latencyStats.totalMs / latencyStats.successCount;
	const avgPerEmb = latencyStats.totalMs / inserted;
	console.log(`\n  Latency (successful requests only, excludes retry waits):`);
	console.log(
		`    batches: ${latencyStats.successCount}, avg=${(avgMs / 1000).toFixed(1)}s p50=${(p50 / 1000).toFixed(1)}s p90=${(p90 / 1000).toFixed(1)}s min=${(latencyStats.min / 1000).toFixed(1)}s max=${(latencyStats.max / 1000).toFixed(1)}s`,
	);
	console.log(
		`    per embedding: avg=${avgPerEmb.toFixed(0)}ms (assuming server processes batch in parallel internally)`,
	);
	console.log(
		`    effective throughput (incl. concurrency=${CONCURRENCY}): ${(inserted / ((Date.now() - startedAt) / 1000)).toFixed(2)} emb/s`,
	);
}
console.log(`  Tokens: ${totalTokens.toLocaleString()}`);
if (skippedBatches > 0) {
	console.log(
		`  ⚠ ${skippedBatches} batch(es) skipped — re-run with --resume to retry`,
	);
}

const finalCount = db
	.query<{ c: number }, [string]>(
		"SELECT COUNT(*) as c FROM embeddings WHERE model = ?",
	)
	.get(MODEL_KEY)!.c;
console.log(`  Total rows in DB for model="${MODEL_KEY}": ${finalCount}`);

db.close();
