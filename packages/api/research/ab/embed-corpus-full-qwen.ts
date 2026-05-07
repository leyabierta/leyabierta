/**
 * Full-corpus Qwen3-Embedding-8B generation via nan.builders for prod-equivalent
 * A/B against Gemini. Embeds the same 9738-norm scope Gemini already covers,
 * sub-chunked by apartados, formatted identically to sync-embeddings.ts.
 *
 * Resume by default: skips chunks already in `embeddings` for model=qwen3-nan.
 *
 * Usage:
 *   NAN_API_KEY=sk-... bun packages/api/research/ab/embed-corpus-full-qwen.ts --dry-run
 *   NAN_API_KEY=sk-... bun packages/api/research/ab/embed-corpus-full-qwen.ts
 *   NAN_API_KEY=sk-... bun packages/api/research/ab/embed-corpus-full-qwen.ts --limit 1000
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "../../../pipeline/src/db/schema.ts";
import { EMBEDDING_MODELS } from "../../src/services/rag/embeddings.ts";
import { splitByApartados } from "../../src/services/rag/subchunk.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
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
db.exec("PRAGMA busy_timeout = 60000");
createSchema(db);

console.log("Building full corpus (Gemini-scoped norms)...");
const articles = db
	.query<
		{
			norm_id: string;
			norm_title: string;
			block_id: string;
			title: string;
			current_text: string;
		},
		[]
	>(
		`SELECT b.norm_id, n.title as norm_title, b.block_id, b.title, b.current_text
		 FROM blocks b
		 JOIN norms n ON n.id = b.norm_id
		 WHERE b.block_type = 'precepto'
		   AND b.current_text != ''
		   AND n.status != 'derogada'
		   AND b.norm_id IN (SELECT DISTINCT norm_id FROM embeddings WHERE model='gemini-embedding-2')
		 ORDER BY b.norm_id, b.position`,
	)
	.all();

interface Block {
	normId: string;
	blockId: string;
	text: string;
}
const allBlocks: Block[] = [];
for (const a of articles) {
	const sub = splitByApartados(a.block_id, a.title, a.current_text);
	if (sub) {
		for (const chunk of sub) {
			allBlocks.push({
				normId: a.norm_id,
				blockId: chunk.blockId,
				text: `title: ${a.norm_title} | text: ${chunk.title}\n\n${chunk.text}`,
			});
		}
	} else {
		allBlocks.push({
			normId: a.norm_id,
			blockId: a.block_id,
			text: `title: ${a.norm_title} | text: ${a.title}\n\n${a.current_text}`,
		});
	}
}
console.log(
	`  ${articles.length} articles → ${allBlocks.length} chunks (full Gemini scope)`,
);

// Resume: skip already-embedded
const have = new Set(
	db
		.query<{ norm_id: string; block_id: string }, [string]>(
			"SELECT norm_id, block_id FROM embeddings WHERE model = ?",
		)
		.all(MODEL_KEY)
		.map((r) => `${r.norm_id}|${r.block_id}`),
);
let workBlocks = allBlocks.filter((b) => !have.has(`${b.normId}|${b.blockId}`));
console.log(
	`  Resume: ${have.size} already embedded, ${workBlocks.length} remaining`,
);
if (limit) workBlocks = workBlocks.slice(0, limit);

if (dryRun) {
	const totalChars = workBlocks.reduce((s, b) => s + b.text.length, 0);
	console.log(
		`\n[dry-run] Would embed ${workBlocks.length} chunks via nan.builders`,
	);
	console.log(
		`  Avg text length: ${Math.round(totalChars / Math.max(1, workBlocks.length))} chars`,
	);
	console.log(
		`  Est. tokens: ${Math.round(totalChars / 4).toLocaleString()} (unmetered — $0)`,
	);
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

const BATCH_SIZE = 32;
const CONCURRENCY = 5;
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
				`\n  ⚠ [w${workerId}] Batch ${batchIdx + 1}: SKIPPED`,
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
				`\r  ${inserted}/${workBlocks.length} (${pct}%) — ${rate.toFixed(1)} emb/s — ETA ${(remaining / 60).toFixed(1)}m   `,
			);
		}
	}
}

console.log(
	`Starting ${CONCURRENCY} workers, batch=${BATCH_SIZE}, ${totalBatches} batches`,
);
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

const elapsedMin = (Date.now() - startedAt) / 60000;
console.log(
	`\n\n✅ Done: ${inserted} embeddings in ${elapsedMin.toFixed(1)} min`,
);
if (skippedBatches > 0) {
	console.log(`  ⚠ ${skippedBatches} batch(es) skipped — re-run to retry`);
}
const finalCount = db
	.query<{ c: number }, [string]>(
		"SELECT COUNT(*) as c FROM embeddings WHERE model = ?",
	)
	.get(MODEL_KEY)!.c;
console.log(`  Total rows for model="${MODEL_KEY}": ${finalCount}`);
db.close();
