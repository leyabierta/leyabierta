/**
 * Sync embeddings in SQLite with database state.
 *
 * Two operations:
 * 1. REMOVE: delete embeddings for derogated norms (instant SQL DELETE)
 * 2. ADD: generate + insert embeddings for missing vigente norms (batch INSERT)
 *
 * Each batch of 50 articles is committed to SQLite immediately. If the process
 * crashes, all previously committed batches are safe. No checkpoint files needed.
 *
 * Usage:
 *   bun run packages/api/research/sync-embeddings.ts                # full sync
 *   bun run packages/api/research/sync-embeddings.ts --dry-run      # show what would change
 *   bun run packages/api/research/sync-embeddings.ts --remove-only  # only remove derogated
 *   bun run packages/api/research/sync-embeddings.ts --add-only     # only add missing vigente
 *   bun run packages/api/research/sync-embeddings.ts --all          # add ALL missing vigente norms
 *   bun run packages/api/research/sync-embeddings.ts --top N        # add top N by reform count
 *   bun run packages/api/research/sync-embeddings.ts --migrate      # import flat file into SQLite
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "../../pipeline/src/db/schema.ts";
import {
	deleteEmbeddingsByNorm,
	EMBEDDING_MODELS,
	fetchWithRetry,
	insertEmbeddingsBatch,
	loadEmbeddings,
} from "../src/services/rag/embeddings.ts";
import { splitByApartados } from "../src/services/rag/subchunk.ts";
import { quantizeVectorsFile } from "./quantize-vectors.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const removeOnly = args.includes("--remove-only");
const addOnly = args.includes("--add-only");
const addAll = args.includes("--all");
const migrate = args.includes("--migrate");
const topNArg = args.indexOf("--top");
const topN = topNArg >= 0 ? Number(args[topNArg + 1]) : undefined;

const MODEL_KEY = "gemini-embedding-2";
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey && !dryRun && !removeOnly && !migrate) {
	console.error(
		"Set OPENROUTER_API_KEY (not needed for --remove-only, --migrate, or --dry-run)",
	);
	process.exit(1);
}

const repoRoot = join(import.meta.dir, "../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// ── Migrate flat file to SQLite ──

if (migrate) {
	const storePath = join(
		repoRoot,
		"data",
		"spike-embeddings-gemini-embedding-2-top500",
	);
	console.log("Migrating flat file embeddings to SQLite...");
	const store = await loadEmbeddings(storePath);
	console.log(
		`  Flat file: ${store.count} articles from ${new Set(store.articles.map((a) => a.normId)).size} norms`,
	);

	const existing = db
		.query<{ cnt: number }, [string]>(
			"SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?",
		)
		.get(MODEL_KEY)!.cnt;

	if (existing > 0) {
		console.log(
			`  SQLite already has ${existing} embeddings. Skipping migration.`,
		);
		console.log("  Use --remove-only or --add-only to modify.");
		process.exit(0);
	}

	console.log(`  Inserting ${store.count} embeddings into SQLite...`);
	insertEmbeddingsBatch(
		db,
		MODEL_KEY,
		store.articles,
		store.vectors,
		store.dimensions,
	);
	console.log(`  ✅ Migration complete: ${store.count} embeddings in SQLite`);
	process.exit(0);
}

// ── Current state ──

const embeddedCount = db
	.query<{ cnt: number }, [string]>(
		"SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?",
	)
	.get(MODEL_KEY)!.cnt;

const embeddedNorms = db
	.query<{ norm_id: string }, [string]>(
		"SELECT DISTINCT norm_id FROM embeddings WHERE model = ?",
	)
	.all(MODEL_KEY)
	.map((r) => r.norm_id);

console.log(`\n📊 Sync Embeddings (SQLite)`);
console.log(
	`  Current: ${embeddedCount} articles from ${embeddedNorms.length} norms\n`,
);

// ── Step 1: Detect derogated norms with embeddings ──

const derogatedInStore = db
	.query<{ id: string; title: string; cnt: number }, [string]>(
		`SELECT n.id, n.title, COUNT(e.block_id) as cnt
		 FROM norms n
		 JOIN embeddings e ON e.norm_id = n.id AND e.model = ?
		 WHERE n.status = 'derogada'
		 GROUP BY n.id`,
	)
	.all(MODEL_KEY);

const derogatedArticleCount = derogatedInStore.reduce((s, r) => s + r.cnt, 0);

console.log(
	`=== REMOVE: ${derogatedInStore.length} derogated norms (${derogatedArticleCount} articles) ===`,
);
if (derogatedInStore.length > 0) {
	for (const r of derogatedInStore.slice(0, 10)) {
		console.log(`  ${r.id}: ${r.cnt} articles — ${r.title.slice(0, 60)}`);
	}
	if (derogatedInStore.length > 10) {
		console.log(`  ... and ${derogatedInStore.length - 10} more`);
	}
} else {
	console.log("  (none — store is clean)");
}

// ── Step 2: Detect missing vigente norms ──

let missingVigente: Array<{ id: string; title: string }> = [];

if (!removeOnly) {
	if (addAll) {
		missingVigente = db
			.query<{ id: string; title: string }, string[]>(
				`SELECT n.id, n.title FROM norms n
				 WHERE n.status != 'derogada'
				   AND n.id NOT IN (${embeddedNorms.map(() => "?").join(",") || "''"})
				 ORDER BY (SELECT COUNT(*) FROM reforms r WHERE r.norm_id = n.id) * 2
				        + (SELECT COUNT(*) FROM blocks b WHERE b.norm_id = n.id) DESC`,
			)
			.all(...embeddedNorms);
	} else if (topN) {
		missingVigente = db
			.query<{ id: string; title: string }, [...string[], number]>(
				`SELECT n.id, n.title FROM norms n
				 WHERE n.status != 'derogada'
				   AND n.id NOT IN (${embeddedNorms.map(() => "?").join(",") || "''"})
				 ORDER BY (SELECT COUNT(*) FROM reforms r WHERE r.norm_id = n.id) * 2
				        + (SELECT COUNT(*) FROM blocks b WHERE b.norm_id = n.id) DESC
				 LIMIT ?`,
			)
			.all(...embeddedNorms, topN);
	}

	// Count articles to embed
	const addIds = missingVigente.map((r) => r.id);
	let articleEstimate = 0;
	if (addIds.length > 0) {
		const ph = addIds.map(() => "?").join(",");
		articleEstimate = db
			.query<{ cnt: number }, string[]>(
				`SELECT COUNT(*) as cnt FROM blocks b
				 JOIN norms n ON n.id = b.norm_id
				 WHERE b.norm_id IN (${ph})
				   AND b.block_type = 'precepto'
				   AND b.current_text != ''
				   AND n.status != 'derogada'`,
			)
			.get(...addIds)!.cnt;
	}

	const estChunks = Math.ceil(articleEstimate * 1.35);
	const estCost = (estChunks * 250 * 0.2) / 1_000_000;

	console.log(
		`\n=== ADD: ${missingVigente.length} vigente norms (${articleEstimate} articles, ~${estChunks} chunks, ~$${estCost.toFixed(2)}) ===`,
	);
	if (missingVigente.length > 0) {
		for (const r of missingVigente.slice(0, 5)) {
			console.log(`  ${r.id}: ${r.title.slice(0, 60)}`);
		}
		if (missingVigente.length > 5) {
			console.log(`  ... and ${missingVigente.length - 5} more`);
		}
	} else {
		console.log("  (none — use --all or --top N to add norms)");
	}
}

// ── Dry run ──

const hasRemovals = derogatedInStore.length > 0 && !addOnly;
const hasAdditions = missingVigente.length > 0 && !removeOnly;

if (!hasRemovals && !hasAdditions) {
	console.log("\n✅ Store is in sync. Nothing to do.");
	process.exit(0);
}

if (dryRun) {
	console.log("\n  (dry run — no changes made)");
	process.exit(0);
}

// ── Step 3: Execute removals (instant SQL DELETE) ──

if (hasRemovals) {
	console.log("\nRemoving derogated norms...");
	let totalRemoved = 0;
	for (const r of derogatedInStore) {
		const removed = deleteEmbeddingsByNorm(db, r.id, MODEL_KEY);
		totalRemoved += removed;
	}
	console.log(
		`  Removed ${totalRemoved} articles from ${derogatedInStore.length} norms`,
	);
}

// ── Step 4: Execute additions (batch INSERT with per-batch commit) ──

if (hasAdditions) {
	console.log("\nGenerating embeddings for new norms...");

	const addIds = missingVigente.map((r) => r.id);
	const ph = addIds.map(() => "?").join(",");
	const articles = db
		.query<
			{
				norm_id: string;
				norm_title: string;
				block_id: string;
				title: string;
				current_text: string;
			},
			string[]
		>(
			`SELECT b.norm_id, n.title as norm_title, b.block_id, b.title, b.current_text
			 FROM blocks b
			 JOIN norms n ON n.id = b.norm_id
			 WHERE b.norm_id IN (${ph})
			   AND b.block_type = 'precepto'
			   AND b.current_text != ''
			   AND n.status != 'derogada'
			 ORDER BY b.norm_id, b.position`,
		)
		.all(...addIds);

	// Sub-chunk + format with Gemini prefixes
	const prepared: Array<{ normId: string; blockId: string; text: string }> = [];
	for (const a of articles) {
		const chunks = splitByApartados(a.block_id, a.title, a.current_text);
		if (chunks) {
			for (const chunk of chunks) {
				prepared.push({
					normId: a.norm_id,
					blockId: chunk.blockId,
					text: `title: ${a.norm_title} | text: ${chunk.title}\n\n${chunk.text}`,
				});
			}
		} else {
			prepared.push({
				normId: a.norm_id,
				blockId: a.block_id,
				text: `title: ${a.norm_title} | text: ${a.title}\n\n${a.current_text}`,
			});
		}
	}

	console.log(`  ${articles.length} articles → ${prepared.length} chunks`);
	console.log(
		`  Estimated cost: ~$${((prepared.length * 250 * 0.2) / 1_000_000).toFixed(2)}`,
	);

	// Sequential embedding generation with immediate SQLite INSERT.
	// No RAM accumulation — each batch is sent to the API, inserted into SQLite,
	// and discarded.
	const model = EMBEDDING_MODELS[MODEL_KEY]!;
	const BATCH_SIZE = 50;
	let completed = 0;
	let inserted = 0;
	const totalBatches = Math.ceil(prepared.length / BATCH_SIZE);

	const insertStmt = db.prepare(
		"INSERT OR REPLACE INTO embeddings (norm_id, block_id, model, vector) VALUES (?, ?, ?, ?)",
	);

	async function processBatch(batchIdx: number): Promise<void> {
		const start = batchIdx * BATCH_SIZE;
		const batch = prepared.slice(start, start + BATCH_SIZE);
		const texts = batch.map((a) => a.text.slice(0, 24000));

		// Call OpenRouter API with retry
		// biome-ignore lint/suspicious/noExplicitAny: OpenRouter API response
		let data: any = null;
		for (let attempt = 0; attempt < 5; attempt++) {
			if (attempt > 0) {
				const delay = 5000 * attempt;
				console.warn(
					`\n  Batch ${batchIdx + 1}: retry ${attempt}/4 after ${delay / 1000}s...`,
				);
				await new Promise((r) => setTimeout(r, delay));
			}
			const response = await fetchWithRetry(apiKey!, model.id, texts);
			data = await response.json();
			if (data.data && Array.isArray(data.data)) break;
			console.warn(
				`\n  Batch ${batchIdx + 1}: API returned no embeddings (${JSON.stringify(data).slice(0, 100)})`,
			);
			data = null;
		}

		if (!data) {
			console.warn(
				`\n  ⚠ Batch ${batchIdx + 1}: SKIPPED after 5 failed attempts`,
			);
			completed++;
			return;
		}

		// INSERT into SQLite immediately (no RAM accumulation)
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

		completed++;
		if (completed % 20 === 0 || completed === totalBatches) {
			const pct = ((completed / totalBatches) * 100).toFixed(0);
			const articles = completed * BATCH_SIZE;
			process.stdout.write(
				`\r  Progress: ${articles}/${prepared.length} (${pct}%) — ${inserted} inserted`,
			);
		}
	}

	// Process all batches sequentially — one API call at a time for reliability.
	// Each batch is committed to SQLite immediately, so if the process crashes
	// re-running resumes from where it left off (INSERT OR REPLACE skips existing).
	for (let idx = 0; idx < totalBatches; idx++) {
		await processBatch(idx);
	}

	console.log(
		`\n  Added ${inserted} articles from ${missingVigente.length} norms`,
	);
}

// ── Summary ──

const finalCount = db
	.query<{ cnt: number }, [string]>(
		"SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?",
	)
	.get(MODEL_KEY)!.cnt;
const finalNorms = db
	.query<{ cnt: number }, [string]>(
		"SELECT COUNT(DISTINCT norm_id) as cnt FROM embeddings WHERE model = ?",
	)
	.get(MODEL_KEY)!.cnt;

console.log(`\n✅ Sync complete!`);
console.log(`  Store: ${finalCount} articles from ${finalNorms} norms`);

// ── Step 5: Regenerate vectors.bin + int8 quantized index ──
//
// SQLite is the source of truth, but the API server reads `vectors.bin`
// (or `vectors-int8.bin` when present) on boot. After any change we
// stream the embeddings table back out to disk and re-quantize so the
// next API restart picks up a consistent triple
// (vectors.bin / vectors-int8.bin / vectors-int8.norms.bin) from a
// single sync run.
//
// Skipped for `--dry-run` (already exited above) and for runs where
// nothing changed in SQLite.

if (hasRemovals || hasAdditions) {
	const dataDir = join(repoRoot, "data");
	const vecPath = join(dataDir, "vectors.bin");
	const metaPath = join(dataDir, "vectors.meta.jsonl");
	const int8Path = join(dataDir, "vectors-int8.bin");
	const model = EMBEDDING_MODELS[MODEL_KEY]!;

	console.log(`\nRebuilding vectors.bin from SQLite → ${vecPath}`);
	const exportStart = Date.now();
	const writer = Bun.file(vecPath).writer();
	const metaLines: string[] = [];
	const stmt = db.query<
		{ norm_id: string; block_id: string; vector: Buffer },
		[string]
	>(
		"SELECT norm_id, block_id, vector FROM embeddings WHERE model = ? ORDER BY norm_id, block_id",
	);
	let exported = 0;
	const expectedBytes = model.dimensions * 4;
	for (const row of stmt.iterate(MODEL_KEY)) {
		// Guard against truncated or wrong-dimension rows. A `new Uint8Array`
		// view past the backing buffer throws RangeError and would crash the
		// whole sync — skip the row with a warning instead.
		if (row.vector.byteLength !== expectedBytes) {
			console.warn(
				`[sync] skipping ${row.norm_id}/${row.block_id}: expected ${expectedBytes}B, got ${row.vector.byteLength}B`,
			);
			continue;
		}
		metaLines.push(JSON.stringify({ n: row.norm_id, b: row.block_id }));
		writer.write(
			new Uint8Array(row.vector.buffer, row.vector.byteOffset, expectedBytes),
		);
		exported++;
		if (exported % 100_000 === 0) {
			writer.flush();
			process.stdout.write(`\r  Exported ${exported.toLocaleString()} vectors`);
		}
	}
	await writer.end();
	await Bun.write(metaPath, metaLines.join("\n"));
	console.log(
		`\n  vectors.bin: ${exported.toLocaleString()} vectors in ${((Date.now() - exportStart) / 1000).toFixed(1)}s`,
	);

	console.log(`\nQuantizing → ${int8Path}`);
	await quantizeVectorsFile({
		inPath: vecPath,
		outPath: int8Path,
		dims: model.dimensions,
	});
	console.log(`\n✅ Vector index files regenerated.`);
}
