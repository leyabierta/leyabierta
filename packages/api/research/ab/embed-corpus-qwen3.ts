/**
 * Generate Qwen3-Embedding-8B embeddings for the A/B corpus via Ollama (local).
 *
 * Uses the same corpus plan + formatting as production (sync-embeddings.ts)
 * so the comparison is apples-to-apples: only the model changes.
 *
 * Stores vectors in SQLite under model="qwen3-ol-8b" alongside the existing
 * gemini-embedding-2 rows — the composite PK (norm_id, block_id, model) lets
 * both coexist. Re-running skips already-inserted rows (INSERT OR REPLACE).
 *
 * Usage:
 *   bun packages/api/research/ab/embed-corpus-qwen3.ts             # full run
 *   bun packages/api/research/ab/embed-corpus-qwen3.ts --dry-run   # stats only
 *   bun packages/api/research/ab/embed-corpus-qwen3.ts --limit 100 # first 100 chunks only
 *   bun packages/api/research/ab/embed-corpus-qwen3.ts --resume    # skip existing rows
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "../../../pipeline/src/db/schema.ts";
import { buildCorpusPlan } from "./corpus.ts";
import { ollamaEmbed } from "./ollama-embeddings.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;

const MODEL_KEY = "qwen3-ol-8b";
const MODEL_ID = "qwen3-embedding:8b";
const EXPECTED_DIMS = 4096;
const BATCH_SIZE = 8; // Ollama handles its own batching; keep moderate

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// ── Build corpus plan ──────────────────────────────────────────────────────
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

// ── Resume: skip rows already embedded ──
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
	console.log(`\n[dry-run] Would embed ${workBlocks.length} chunks`);
	console.log(
		`  Average text length: ${Math.round(totalChars / Math.max(1, workBlocks.length))} chars`,
	);
	console.log(
		`  Est. tokens (rough, 4 chars/tok): ${Math.round(totalChars / 4)}`,
	);
	console.log(`\nSample formatted chunk:`);
	console.log(`${workBlocks[0]?.text.slice(0, 400)}...\n`);
	process.exit(0);
}

if (workBlocks.length === 0) {
	console.log("Nothing to embed.");
	process.exit(0);
}

// ── Smoke test: one call to verify model + dims ────────────────────────────
console.log("\nSmoke testing Ollama...");
const smoke = await ollamaEmbed(MODEL_ID, "test", { keepAlive: "24h" });
const dims = smoke[0]!.length;
console.log(`  Model returned ${dims}-dim vectors`);
if (dims !== EXPECTED_DIMS) {
	console.warn(
		`  ⚠ Expected ${EXPECTED_DIMS} dims, got ${dims}. Continuing with actual dims.`,
	);
}

// ── Insert prepared statement ──
const insertStmt = db.prepare(
	"INSERT OR REPLACE INTO embeddings (norm_id, block_id, model, vector) VALUES (?, ?, ?, ?)",
);

// ── Main loop: batch through Ollama ────────────────────────────────────────
const totalBatches = Math.ceil(workBlocks.length / BATCH_SIZE);
let completed = 0;
let errors = 0;
const startedAt = Date.now();

for (let i = 0; i < workBlocks.length; i += BATCH_SIZE) {
	const batch = workBlocks.slice(i, i + BATCH_SIZE);
	// Qwen3-Embedding docs embed raw (no instruction prefix); asymmetric retrieval
	// puts the instruction on the QUERY side only.
	const texts = batch.map((b) => b.text.slice(0, 24000)); // same truncation as prod

	let vecs: Float32Array[];
	try {
		vecs = await ollamaEmbed(MODEL_ID, texts, { keepAlive: "24h" });
	} catch (err) {
		errors++;
		console.warn(
			`\n  ⚠ Batch ${i / BATCH_SIZE + 1}: ${err instanceof Error ? err.message : err}`,
		);
		if (errors > 5) {
			console.error("Too many errors, aborting.");
			break;
		}
		continue;
	}

	if (vecs.length !== batch.length) {
		console.warn(
			`\n  ⚠ Batch ${i / BATCH_SIZE + 1}: expected ${batch.length} vectors, got ${vecs.length}`,
		);
		continue;
	}

	db.exec("BEGIN");
	try {
		for (let j = 0; j < batch.length; j++) {
			const b = batch[j]!;
			const v = vecs[j]!;
			insertStmt.run(
				b.normId,
				b.blockId,
				MODEL_KEY,
				Buffer.from(v.buffer, v.byteOffset, v.byteLength),
			);
		}
		db.exec("COMMIT");
		completed += batch.length;
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}

	const batchIdx = Math.floor(i / BATCH_SIZE) + 1;
	if (batchIdx % 5 === 0 || batchIdx === totalBatches) {
		const elapsedS = (Date.now() - startedAt) / 1000;
		const rate = completed / elapsedS;
		const remaining = (workBlocks.length - completed) / Math.max(rate, 0.001);
		const pct = ((completed / workBlocks.length) * 100).toFixed(1);
		process.stdout.write(
			`\r  ${completed}/${workBlocks.length} (${pct}%) — ${rate.toFixed(1)} emb/s — ETA ${(remaining / 60).toFixed(0)}m`,
		);
	}
}

const elapsedS = (Date.now() - startedAt) / 1000;
console.log(
	`\n\n✅ Done: ${completed}/${workBlocks.length} embeddings in ${(elapsedS / 60).toFixed(1)} min (${(completed / elapsedS).toFixed(1)}/s).`,
);
if (errors > 0) console.log(`  ⚠ Errors: ${errors}`);

const finalCount = db
	.query<{ c: number }, [string]>(
		"SELECT COUNT(*) as c FROM embeddings WHERE model = ?",
	)
	.get(MODEL_KEY)!.c;
console.log(`  Total rows in DB for ${MODEL_KEY}: ${finalCount}`);

db.close();
