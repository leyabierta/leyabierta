/**
 * Generate qwen3-nan embeddings for vigente norms via api.nan.builders.
 *
 * Default mode is incremental: scans the `embeddings` table for blocks that
 * already have a `qwen3-nan` row and embeds only the missing ones. Safe to
 * run from cron after the daily ingest — it's a no-op when nothing is missing.
 *
 * Usage:
 *   bun run packages/api/src/scripts/embed-corpus.ts                     # incremental
 *   bun run packages/api/src/scripts/embed-corpus.ts --dry-run           # estimate work
 *   bun run packages/api/src/scripts/embed-corpus.ts --limit 50          # cap chunks
 *   bun run packages/api/src/scripts/embed-corpus.ts --norm-ids ID1,ID2  # specific norms
 *
 * Auth: reads NAN_API_KEY, falls back to HERMES_API_KEY (transitional naming
 * during the OpenRouter → NaN migration; the runtime still uses HERMES_API_KEY).
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { EMBEDDING_MODELS } from "../services/rag/embeddings.ts";
import { splitByApartados } from "../services/rag/subchunk.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;
const normIdsIdx = args.indexOf("--norm-ids");
const explicitNormIds =
	normIdsIdx >= 0
		? args[normIdsIdx + 1]?.split(",").filter(Boolean)
		: undefined;

const MODEL_KEY = "qwen3-nan";
const model = EMBEDDING_MODELS[MODEL_KEY];
if (!model) throw new Error(`Unknown model key: ${MODEL_KEY}`);
const modelId = model.id;
const modelDimensions = model.dimensions;

const NAN_URL = "https://api.nan.builders/v1/embeddings";
const apiKey = process.env.NAN_API_KEY ?? process.env.HERMES_API_KEY;
if (!apiKey && !dryRun) {
	console.error("NAN_API_KEY or HERMES_API_KEY required");
	process.exit(1);
}

const dbPath = process.env.DB_PATH ?? join(process.cwd(), "data/leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 60000");

// ── Discover work: vigente norms missing qwen3-nan embeddings ──

interface ArticleRow {
	norm_id: string;
	norm_title: string;
	block_id: string;
	title: string;
	current_text: string;
}

const articleQuery = explicitNormIds
	? `SELECT b.norm_id, n.title AS norm_title, b.block_id, b.title, b.current_text
	   FROM blocks b
	   JOIN norms n ON n.id = b.norm_id
	   WHERE b.block_type = 'precepto'
	     AND b.current_text != ''
	     AND n.status != 'derogada'
	     AND b.norm_id IN (${explicitNormIds.map(() => "?").join(",")})
	   ORDER BY b.norm_id, b.position`
	: `SELECT b.norm_id, n.title AS norm_title, b.block_id, b.title, b.current_text
	   FROM blocks b
	   JOIN norms n ON n.id = b.norm_id
	   WHERE b.block_type = 'precepto'
	     AND b.current_text != ''
	     AND n.status != 'derogada'
	   ORDER BY b.norm_id, b.position`;

const articles = (
	explicitNormIds
		? db.prepare(articleQuery).all(...explicitNormIds)
		: db.prepare(articleQuery).all()
) as ArticleRow[];

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

const have = new Set(
	db
		.query<{ norm_id: string; block_id: string }, [string]>(
			"SELECT norm_id, block_id FROM embeddings WHERE model = ?",
		)
		.all(MODEL_KEY)
		.map((r) => `${r.norm_id}|${r.block_id}`),
);

let workBlocks = allBlocks.filter((b) => !have.has(`${b.normId}|${b.blockId}`));
if (limit) workBlocks = workBlocks.slice(0, limit);

const distinctMissingNorms = new Set(workBlocks.map((b) => b.normId)).size;
console.log(
	`Corpus: ${articles.length} vigente articles → ${allBlocks.length} chunks ` +
		`(${have.size} already embedded, ${workBlocks.length} missing from ${distinctMissingNorms} norms)`,
);

if (workBlocks.length === 0) {
	console.log("Nothing to embed.");
	process.exit(0);
}

if (dryRun) {
	const totalChars = workBlocks.reduce((s, b) => s + b.text.length, 0);
	const estTokens = Math.round(totalChars / 4);
	console.log(
		`\n[dry-run] Would embed ${workBlocks.length} chunks (~${estTokens.toLocaleString()} tokens, $0 via NaN)`,
	);
	console.log(`Sample chunk:\n${workBlocks[0]?.text.slice(0, 300)}...`);
	process.exit(0);
}

// ── Embed in batched workers ──

const latencyStats = {
	successCount: 0,
	totalMs: 0,
	samples: [] as number[],
};

async function nanEmbed(texts: string[]): Promise<{
	data: Array<{ index: number; embedding: number[] }>;
	usage?: { total_tokens?: number };
} | null> {
	const body = JSON.stringify({
		model: modelId,
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
					`  HTTP ${res.status} — retry ${attempt + 1}/${MAX_ATTEMPTS}`,
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
				usage?: { total_tokens?: number };
			};
			if (!json.data || !Array.isArray(json.data)) continue;
			const reqMs = Date.now() - reqStart;
			latencyStats.successCount += 1;
			latencyStats.totalMs += reqMs;
			latencyStats.samples.push(reqMs);
			return json;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`  Fetch error ${attempt + 1}/${MAX_ATTEMPTS}: ${msg.slice(0, 200)}`,
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
				`\n  ⚠ [w${workerId}] Batch ${batchIdx + 1}: SKIPPED (chunks ${start}-${start + batch.length - 1})`,
			);
			continue;
		}

		totalTokens += data.usage?.total_tokens ?? 0;

		db.exec("BEGIN IMMEDIATE");
		try {
			for (const item of data.data) {
				const article = batch[item.index]!;
				const vec = new Float32Array(item.embedding);
				if (dimsSeen === null) {
					dimsSeen = vec.length;
					if (dimsSeen !== modelDimensions) {
						console.warn(
							`  ⚠ Dim mismatch: expected ${modelDimensions}, got ${dimsSeen}`,
						);
					}
				} else if (vec.length !== dimsSeen) {
					throw new Error(
						`Inconsistent dims at ${article.normId}/${article.blockId}: ${vec.length} != ${dimsSeen}`,
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
	`Starting ${CONCURRENCY} workers, batch=${BATCH_SIZE}, ${totalBatches} batches total`,
);
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

const elapsedMin = (Date.now() - startedAt) / 60000;
console.log(
	`\n\n✅ Done: ${inserted} embeddings in ${elapsedMin.toFixed(1)} min (${dimsSeen} dims, ${totalTokens.toLocaleString()} tokens)`,
);
if (skippedBatches > 0) {
	console.log(
		`  ⚠ ${skippedBatches} batch(es) skipped — re-run to retry the missing ones`,
	);
}

const finalCount = db
	.query<{ c: number }, [string]>(
		"SELECT COUNT(*) AS c FROM embeddings WHERE model = ?",
	)
	.get(MODEL_KEY)!.c;
console.log(`  Total rows for model="${MODEL_KEY}": ${finalCount}`);

db.close();
