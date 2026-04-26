/**
 * Generate Qwen3-Embedding-8B embeddings via OpenRouter (not local Ollama).
 *
 * Uses the production `generateEmbeddings` path so it's the same code + batch
 * size + retry logic that production uses for Gemini — only the model key
 * changes. Stores under model="qwen3" (already registered in EMBEDDING_MODELS).
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun packages/api/research/ab/embed-corpus-openrouter.ts
 *   OPENROUTER_API_KEY=... bun packages/api/research/ab/embed-corpus-openrouter.ts --dry-run
 *   OPENROUTER_API_KEY=... bun packages/api/research/ab/embed-corpus-openrouter.ts --resume
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "../../../pipeline/src/db/schema.ts";
import {
	EMBEDDING_MODELS,
	fetchWithRetry,
} from "../../src/services/rag/embeddings.ts";
import { buildCorpusPlan } from "./corpus.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;

const MODEL_KEY = "qwen3";
const model = EMBEDDING_MODELS[MODEL_KEY];
if (!model) throw new Error(`Unknown model key: ${MODEL_KEY}`);

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey && !dryRun) {
	console.error("OPENROUTER_API_KEY required");
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
	// Qwen3 OpenRouter pricing unknown upfront; assume similar to Gemini ($0.10–0.20/M tokens)
	const estTokens = Math.round(totalChars / 4);
	console.log(
		`\n[dry-run] Would embed ${workBlocks.length} chunks via OpenRouter`,
	);
	console.log(
		`  Avg text length: ${Math.round(totalChars / Math.max(1, workBlocks.length))} chars`,
	);
	console.log(
		`  Est. tokens: ${estTokens.toLocaleString()} (~${((estTokens * 0.1) / 1_000_000).toFixed(2)}–${((estTokens * 0.2) / 1_000_000).toFixed(2)} USD at $0.10–0.20/M)`,
	);
	console.log(`\nSample chunk:\n${workBlocks[0]?.text.slice(0, 300)}...`);
	process.exit(0);
}

if (workBlocks.length === 0) {
	console.log("Nothing to embed.");
	process.exit(0);
}

// ── Insert statement ──
const insertStmt = db.prepare(
	"INSERT OR REPLACE INTO embeddings (norm_id, block_id, model, vector) VALUES (?, ?, ?, ?)",
);

const BATCH_SIZE = 50;
const totalBatches = Math.ceil(workBlocks.length / BATCH_SIZE);
let inserted = 0;
let skippedBatches = 0;
let totalTokens = 0;
let totalCost = 0;
const startedAt = Date.now();

for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
	const start = batchIdx * BATCH_SIZE;
	const batch = workBlocks.slice(start, start + BATCH_SIZE);
	const texts = batch.map((b) => b.text.slice(0, 24000));

	// biome-ignore lint/suspicious/noExplicitAny: OpenRouter response shape
	let data: any = null;
	for (let attempt = 0; attempt < 5; attempt++) {
		if (attempt > 0) {
			const delay = 5000 * attempt;
			console.warn(
				`\n  Batch ${batchIdx + 1}: retry ${attempt}/4 after ${delay / 1000}s...`,
			);
			await new Promise((r) => setTimeout(r, delay));
		}
		try {
			const response = await fetchWithRetry(apiKey!, model.id, texts);
			data = await response.json();
			if (data.data && Array.isArray(data.data)) break;
			console.warn(
				`  Batch ${batchIdx + 1}: API returned no embeddings (${JSON.stringify(data).slice(0, 150)})`,
			);
			data = null;
		} catch (err) {
			console.warn(
				`  Batch ${batchIdx + 1}: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
			);
			data = null;
		}
	}

	if (!data) {
		skippedBatches++;
		console.warn(
			`  ⚠ Batch ${batchIdx + 1}: SKIPPED (articles ${start}-${start + batch.length - 1})`,
		);
		continue;
	}

	const usage = data.usage ?? {};
	totalTokens += usage.total_tokens ?? 0;
	totalCost += usage.cost ?? 0;

	db.exec("BEGIN");
	try {
		for (const item of data.data) {
			const article = batch[item.index]!;
			const vec = new Float32Array(item.embedding);
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
			`\r  ${inserted}/${workBlocks.length} (${pct}%) — ${rate.toFixed(1)} emb/s — ETA ${(remaining / 60).toFixed(1)}m — $${totalCost.toFixed(4)}`,
		);
	}
}

const elapsedMin = (Date.now() - startedAt) / 60000;
console.log(
	`\n\n✅ Done: ${inserted} embeddings in ${elapsedMin.toFixed(1)} min`,
);
console.log(`  Tokens: ${totalTokens.toLocaleString()}`);
console.log(`  Cost: $${totalCost.toFixed(4)}`);
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
