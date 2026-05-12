/**
 * Embed citizen summaries (qwen3-embedding via NaN) into a separate model key
 * `qwen3-nan-summary` so we can do multi-vector retrieval (max-score over
 * raw_text and summary indexes per article).
 *
 * Citizen summaries are written in plain Spanish vocabulary; embedding them
 * gives a "bridge" between citizen-language queries and ancient legal text.
 *
 * Resume by default: skips chunks already in `embeddings` for model=qwen3-nan-summary.
 *
 * Usage:
 *   HERMES_API_KEY=sk-... bun packages/api/research/ab/embed-citizen-summaries.ts --dry-run
 *   HERMES_API_KEY=sk-... bun packages/api/research/ab/embed-citizen-summaries.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "../../../pipeline/src/db/schema.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : undefined;
// --priority-norms <file>: ordering hint. Norms in this file (one per line)
// are embedded first; everything else follows in default order. Used to get
// quick eval signal on the 33 expected norms before all 9.7k complete.
const priorityIdx = args.indexOf("--priority-norms");
const priorityFile = priorityIdx >= 0 ? args[priorityIdx + 1] : undefined;

const SOURCE_MODEL = "qwen3-nan"; // raw-text embeddings (provides scope)
const TARGET_MODEL = "qwen3-nan-summary";

const NAN_URL = "https://api.nan.builders/v1/embeddings";
const apiKey = process.env.HERMES_API_KEY;
if (!apiKey && !dryRun) {
	console.error("HERMES_API_KEY required");
	process.exit(1);
}

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 60000");
createSchema(db);

console.log("Building citizen-summary corpus (Qwen-scoped norms)...");
// Embed the citizen summary for every (norm, block) that we already have a
// raw-text Qwen embedding for. Keeps scope identical for fair multi-vector.
const rows = db
	.query<
		{
			norm_id: string;
			norm_title: string;
			block_id: string;
			summary: string;
		},
		[]
	>(
		`SELECT s.norm_id, n.title as norm_title, s.block_id, s.summary
		 FROM citizen_article_summaries s
		 JOIN norms n ON n.id = s.norm_id
		 WHERE s.summary != ''
		   AND n.status != 'derogada'
		   AND EXISTS (
		     SELECT 1 FROM embeddings e
		     WHERE e.model = '${SOURCE_MODEL}'
		       AND e.norm_id = s.norm_id
		       AND (e.block_id = s.block_id OR e.block_id LIKE s.block_id || '#%')
		   )
		 ORDER BY s.norm_id, s.block_id`,
	)
	.all();

interface Block {
	normId: string;
	blockId: string;
	text: string;
}
const allBlocks: Block[] = rows.map((r) => ({
	normId: r.norm_id,
	blockId: r.block_id,
	// Same format as raw-text embeddings: title prefix + summary body.
	text: `title: ${r.norm_title}\n\n${r.summary}`,
}));

console.log(
	`  ${allBlocks.length} citizen summaries to embed (target=${TARGET_MODEL})`,
);

// Priority sort: if a priority list is given, those norms go first.
if (priorityFile) {
	const priorityText = await Bun.file(priorityFile).text();
	const priorityNorms = new Set(
		priorityText
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	allBlocks.sort((a, b) => {
		const aP = priorityNorms.has(a.normId) ? 0 : 1;
		const bP = priorityNorms.has(b.normId) ? 0 : 1;
		if (aP !== bP) return aP - bP;
		// Stable secondary sort by normId, blockId
		if (a.normId !== b.normId) return a.normId.localeCompare(b.normId);
		return a.blockId.localeCompare(b.blockId);
	});
	console.log(`  Priority: ${priorityNorms.size} norms placed first`);
}

// Resume: skip already-embedded
const have = new Set(
	db
		.query<{ norm_id: string; block_id: string }, [string]>(
			"SELECT norm_id, block_id FROM embeddings WHERE model = ?",
		)
		.all(TARGET_MODEL)
		.map((r) => `${r.norm_id}|${r.block_id}`),
);
let workBlocks = allBlocks.filter((b) => !have.has(`${b.normId}|${b.blockId}`));
console.log(
	`  Resume: ${have.size} already embedded, ${workBlocks.length} remaining`,
);
if (limit) workBlocks = workBlocks.slice(0, limit);

if (dryRun) {
	const totalChars = workBlocks.reduce((s, b) => s + b.text.length, 0);
	console.log(`\n[dry-run] Would embed ${workBlocks.length} summaries via NaN`);
	console.log(
		`  Avg text length: ${Math.round(totalChars / Math.max(1, workBlocks.length))} chars`,
	);
	console.log(`  Est. tokens: ${Math.round(totalChars / 4).toLocaleString()}`);
	process.exit(0);
}

if (workBlocks.length === 0) {
	console.log("Nothing to embed.");
	process.exit(0);
}

async function nanEmbed(texts: string[]): Promise<{
	data: Array<{ index: number; embedding: number[] }>;
	usage?: Record<string, unknown>;
} | null> {
	const body = JSON.stringify({
		model: "qwen3-embedding",
		input: texts,
		encoding_format: "float",
	});
	const MAX_ATTEMPTS = 8;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			const delay = 30_000 + Math.floor(Math.random() * 20_000);
			await new Promise((r) => setTimeout(r, delay));
		}
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
const startedAt = Date.now();
let nextBatch = 0;
let dimsSeen: number | null = null;

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
			console.warn(`\n  ⚠ [w${workerId}] Batch ${batchIdx + 1}: SKIPPED`);
			continue;
		}

		db.exec("BEGIN IMMEDIATE");
		try {
			for (const item of data.data) {
				const block = batch[item.index]!;
				const vec = new Float32Array(item.embedding);
				if (dimsSeen === null) {
					dimsSeen = vec.length;
					console.log(`  First batch returned ${dimsSeen} dims`);
				}
				insertStmt.run(
					block.normId,
					block.blockId,
					TARGET_MODEL,
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
	.get(TARGET_MODEL)!.c;
console.log(`  Total rows for model="${TARGET_MODEL}": ${finalCount}`);
db.close();
