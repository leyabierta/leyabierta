/**
 * Embed the A/B corpus via a local llama-server (llama.cpp) /v1/embeddings endpoint.
 *
 * Supports both Qwen3-Embedding-8B (4096 dim) and embeddinggemma-300m (768 dim) by
 * passing the model key. dtype, pooling, and padding are controlled by us locally
 * (BF16/Q8_0, last-token, left-pad) — eliminating the OpenRouter opacity that
 * may have biased the previous A/B (2026-04-25).
 *
 * Pre-flight (run separately):
 *   llama-server -m /Volumes/Disco1TB/models/embeddings/qwen3-embedding-8b/Qwen3-Embedding-8B-Q8_0.gguf \
 *     -ngl 99 -c 32768 --embeddings --pooling last --port 8090
 *
 * Usage:
 *   bun packages/api/research/ab/embed-corpus-llamacpp.ts --model qwen3-local-q8 [--port 8090] [--resume] [--limit N] [--dry-run]
 *   bun packages/api/research/ab/embed-corpus-llamacpp.ts --model embgemma-local --port 8091 --resume
 *
 * Documents are embedded raw (no Instruct prefix) — Qwen3-Embedding is asymmetric.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "../../../pipeline/src/db/schema.ts";
import { EMBEDDING_MODELS } from "../../src/services/rag/embeddings.ts";
import { buildCorpusPlan } from "./corpus.ts";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const limitArg = arg("--limit");
const limit = limitArg ? Number(limitArg) : undefined;
const port = Number(arg("--port") ?? "8090");
const modelKey = arg("--model") ?? "qwen3-local-q8";
const batchSize = Number(arg("--batch") ?? "8");

const model = EMBEDDING_MODELS[modelKey];
if (!model) throw new Error(`Unknown model key: ${modelKey}`);

const ENDPOINT = `http://127.0.0.1:${port}/v1/embeddings`;
console.log(`Endpoint: ${ENDPOINT}`);
console.log(`Model: ${modelKey} (${model.dimensions} dims)`);

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
		.all(modelKey);
	const have = new Set(existing.map((r) => `${r.norm_id}|${r.block_id}`));
	const before = workBlocks.length;
	workBlocks = workBlocks.filter((b) => !have.has(`${b.normId}|${b.blockId}`));
	console.log(
		`  Resume: skipping ${before - workBlocks.length} already embedded, ${workBlocks.length} remaining.`,
	);
}

if (dryRun) {
	console.log(
		`\n[dry-run] Would embed ${workBlocks.length} chunks via ${ENDPOINT}`,
	);
	console.log(`Sample chunk:\n${workBlocks[0]?.text.slice(0, 300)}...`);
	process.exit(0);
}

if (workBlocks.length === 0) {
	console.log("Nothing to embed.");
	process.exit(0);
}

// ── Sanity ping ──
async function pingServer(): Promise<void> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
		if (!res.ok) throw new Error(`server returned ${res.status}`);
		const body = (await res.json()) as { data?: Array<{ id: string }> };
		console.log(
			`  Server reachable, models: ${body.data?.map((m) => m.id).join(", ") ?? "<unknown>"}`,
		);
	} catch (err) {
		console.error(
			`✗ llama-server at port ${port} not reachable. Start it first.\n  ${err instanceof Error ? err.message : err}`,
		);
		process.exit(1);
	}
}
await pingServer();

// ── Sanity: embed one and check dim + norm ──
async function embedBatch(texts: string[]): Promise<Float32Array[]> {
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: modelKey, input: texts }),
	});
	if (!res.ok) {
		const txt = await res.text();
		throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
	}
	const data = (await res.json()) as {
		data: Array<{ index: number; embedding: number[] }>;
	};
	// Sort by index in case server returns out of order.
	const sorted = [...data.data].sort((a, b) => a.index - b.index);
	return sorted.map((d) => new Float32Array(d.embedding));
}

const sample = await embedBatch([workBlocks[0]!.text]);
const sv = sample[0]!;
let sampleSum = 0;
let sampleNaN = 0;
for (let i = 0; i < sv.length; i++) {
	const v = sv[i]!;
	if (Number.isNaN(v)) sampleNaN++;
	sampleSum += v * v;
}
const sampleNorm = Math.sqrt(sampleSum);
console.log(
	`  Sanity: dim=${sv.length}, ‖v‖=${sampleNorm.toFixed(4)}, NaN=${sampleNaN}`,
);
if (sv.length !== model.dimensions) {
	console.error(
		`✗ dim mismatch: server returned ${sv.length}, registry expects ${model.dimensions}`,
	);
	process.exit(1);
}
if (sampleNaN > 0) {
	console.error(`✗ ${sampleNaN} NaN values in first vector — dtype problem.`);
	process.exit(1);
}
if (sampleNorm < 0.99 || sampleNorm > 1.01) {
	console.warn(
		`  ⚠ vector not unit-norm (‖v‖=${sampleNorm.toFixed(4)}); will L2-normalize before storing.`,
	);
}

// ── Insert ──
const insertStmt = db.prepare(
	"INSERT OR REPLACE INTO embeddings (norm_id, block_id, model, vector) VALUES (?, ?, ?, ?)",
);

const totalBatches = Math.ceil(workBlocks.length / batchSize);
let inserted = 0;
let nanCount = 0;
let skippedBatches = 0;
const startedAt = Date.now();

for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
	const start = batchIdx * batchSize;
	const batch = workBlocks.slice(start, start + batchSize);
	const texts = batch.map((b) => b.text);

	let vectors: Float32Array[] | null = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt > 0) {
			const delay = 2000 * attempt;
			console.warn(
				`\n  Batch ${batchIdx + 1}: retry ${attempt}/3 after ${delay / 1000}s...`,
			);
			await new Promise((r) => setTimeout(r, delay));
		}
		try {
			vectors = await embedBatch(texts);
			if (vectors.length === batch.length) break;
			console.warn(
				`  Batch ${batchIdx + 1}: got ${vectors.length} vectors for ${batch.length} inputs, retrying.`,
			);
			vectors = null;
		} catch (err) {
			console.warn(
				`  Batch ${batchIdx + 1}: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
			);
		}
	}
	if (!vectors) {
		skippedBatches++;
		console.warn(`  ⚠ Batch ${batchIdx + 1} skipped after retries.`);
		continue;
	}

	db.exec("BEGIN");
	try {
		for (let i = 0; i < batch.length; i++) {
			let vec = vectors[i]!;
			// Defensive: re-normalize (most servers already do, costs nothing)
			let sum = 0;
			let nan = 0;
			for (let j = 0; j < vec.length; j++) {
				if (Number.isNaN(vec[j]!)) nan++;
				sum += vec[j]! * vec[j]!;
			}
			if (nan > 0) {
				nanCount += nan;
				console.warn(
					`  ⚠ batch ${batchIdx + 1} item ${i}: ${nan} NaN values, skipping insert.`,
				);
				continue;
			}
			const n = Math.sqrt(sum);
			if (n > 0 && Math.abs(n - 1) > 0.001) {
				const norm = new Float32Array(vec.length);
				for (let j = 0; j < vec.length; j++) norm[j] = vec[j]! / n;
				vec = norm;
			}
			insertStmt.run(
				batch[i]!.normId,
				batch[i]!.blockId,
				modelKey,
				Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
			);
			inserted++;
		}
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}

	if ((batchIdx + 1) % 10 === 0 || batchIdx + 1 === totalBatches) {
		const elapsed = (Date.now() - startedAt) / 1000;
		const rate = inserted / elapsed;
		const remaining = (workBlocks.length - inserted) / Math.max(rate, 0.01);
		const pct = ((inserted / workBlocks.length) * 100).toFixed(1);
		process.stdout.write(
			`\r  ${inserted}/${workBlocks.length} (${pct}%) — ${rate.toFixed(1)} emb/s — ETA ${(remaining / 60).toFixed(1)}m`,
		);
	}
}

const elapsedMin = (Date.now() - startedAt) / 60000;
console.log(
	`\n\n${nanCount === 0 ? "✅" : "⚠"} Done: ${inserted} embeddings in ${elapsedMin.toFixed(1)} min`,
);
if (nanCount > 0) console.log(`  NaN values seen: ${nanCount}`);
if (skippedBatches > 0) {
	console.log(
		`  ${skippedBatches} batch(es) skipped — re-run with --resume to retry`,
	);
}

const finalCount = db
	.query<{ c: number }, [string]>(
		"SELECT COUNT(*) as c FROM embeddings WHERE model = ?",
	)
	.get(modelKey)!.c;
console.log(`  Total rows in DB for model="${modelKey}": ${finalCount}`);

db.close();
