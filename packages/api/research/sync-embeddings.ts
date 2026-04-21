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
	generateEmbeddings,
	insertEmbeddingsBatch,
	loadEmbeddings,
} from "../src/services/rag/embeddings.ts";
import { splitByApartados } from "../src/services/rag/subchunk.ts";

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

	// Generate in batches and INSERT into SQLite after each API batch.
	// This means each batch of 50 articles is committed immediately.
	// If the process crashes, we lose at most 50 articles (~$0.0025).
	const dims = EMBEDDING_MODELS[MODEL_KEY]!.dimensions;
	let totalInserted = 0;

	const insertStmt = db.prepare(
		"INSERT OR REPLACE INTO embeddings (norm_id, block_id, model, vector) VALUES (?, ?, ?, ?)",
	);

	const store = await generateEmbeddings(
		apiKey!,
		MODEL_KEY,
		prepared,
		(done, total) => {
			process.stdout.write(
				`\r  Progress: ${done}/${total} (${((done / total) * 100).toFixed(0)}%)`,
			);
		},
		async (checkpoint) => {
			// Insert new articles from this checkpoint into SQLite.
			// We insert everything from the checkpoint (which accumulates),
			// using INSERT OR REPLACE to handle re-runs safely.
			const newArticles = checkpoint.meta.slice(totalInserted);
			const newStart = totalInserted;

			if (newArticles.length > 0) {
				db.exec("BEGIN");
				try {
					for (let j = 0; j < newArticles.length; j++) {
						const a = newArticles[j]!;
						const vecIdx = newStart + j;
						const offset = vecIdx * checkpoint.dims;
						const vec = checkpoint.vectors.subarray(
							offset,
							offset + checkpoint.dims,
						);
						insertStmt.run(
							a.normId,
							a.blockId,
							MODEL_KEY,
							Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
						);
					}
					db.exec("COMMIT");
					totalInserted = checkpoint.meta.length;
					console.log(
						`\n  💾 Committed to SQLite: ${totalInserted}/${prepared.length} articles`,
					);
				} catch (err) {
					db.exec("ROLLBACK");
					throw err;
				}
			}
		},
	);

	// Insert any remaining articles after the last checkpoint
	if (store.count > totalInserted) {
		const remaining = store.articles.slice(totalInserted);
		const remainingVectors = store.vectors.subarray(totalInserted * dims);
		insertEmbeddingsBatch(db, MODEL_KEY, remaining, remainingVectors, dims);
		totalInserted = store.count;
	}

	console.log(
		`\n  Added ${totalInserted} articles from ${missingVigente.length} norms`,
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
