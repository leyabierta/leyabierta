/**
 * Sync embedding store with database state.
 *
 * Two operations:
 * 1. REMOVE: filter out norms that are now derogada in the DB ($0, local only)
 * 2. ADD: generate embeddings for vigente norms not yet in the store (~$0.01/norm)
 *
 * The flat array store format makes both operations trivial:
 * - Remove = filter arrays + rewrite file
 * - Add = generate new vectors + append + rewrite file
 *
 * Usage:
 *   bun run packages/api/research/sync-embeddings.ts              # full sync
 *   bun run packages/api/research/sync-embeddings.ts --dry-run    # show what would change
 *   bun run packages/api/research/sync-embeddings.ts --remove-only # only remove derogated
 *   bun run packages/api/research/sync-embeddings.ts --add-only   # only add missing vigente
 *   bun run packages/api/research/sync-embeddings.ts --top N      # add top N vigente norms by reform count
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
	type EmbeddingStore,
	generateEmbeddings,
	loadEmbeddings,
	saveEmbeddings,
} from "../src/services/rag/embeddings.ts";
import { createSchema } from "../../pipeline/src/db/schema.ts";
import { splitByApartados } from "../src/services/rag/subchunk.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const removeOnly = args.includes("--remove-only");
const addOnly = args.includes("--add-only");
const topNArg = args.indexOf("--top");
const topN = topNArg >= 0 ? Number(args[topNArg + 1]) : undefined;

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey && !dryRun && !removeOnly) {
	console.error("Set OPENROUTER_API_KEY (not needed for --remove-only or --dry-run)");
	process.exit(1);
}

const repoRoot = join(import.meta.dir, "../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const storePath = join(repoRoot, "data", "spike-embeddings-gemini-embedding-2-top500");

// ── DB ──

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// ── Load current store ──

console.log("Loading embedding store...");
const store = await loadEmbeddings(storePath);
const storeNormIds = new Set(store.articles.map((a) => a.normId));
console.log(`  ${store.count} articles from ${storeNormIds.size} norms\n`);

// ── Step 1: Detect derogated norms in store ──

const derogatedInStore = db
	.query<{ id: string; title: string }, string[]>(
		`SELECT id, title FROM norms
		 WHERE id IN (${[...storeNormIds].map(() => "?").join(",")})
		   AND status = 'derogada'`,
	)
	.all(...storeNormIds);

const derogatedIds = new Set(derogatedInStore.map((r) => r.id));

console.log(`=== REMOVE: ${derogatedInStore.length} derogated norms in store ===`);
if (derogatedInStore.length > 0) {
	const articlesToRemove = store.articles.filter((a) => derogatedIds.has(a.normId)).length;
	console.log(`  ${articlesToRemove} articles to remove`);
	for (const r of derogatedInStore.slice(0, 10)) {
		const count = store.articles.filter((a) => a.normId === r.id).length;
		console.log(`  ${r.id}: ${count} articles — ${r.title.slice(0, 60)}`);
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
	if (topN) {
		// Add top N vigente norms by reform count (that aren't already in store)
		const storeList = [...storeNormIds];
		const excludePlaceholders = storeList.map(() => "?").join(",");
		missingVigente = db
			.query<{ id: string; title: string }, [...string[], number]>(
				`SELECT n.id, n.title FROM norms n
				 WHERE n.status != 'derogada'
				   AND n.id NOT IN (${excludePlaceholders})
				 ORDER BY (SELECT COUNT(*) FROM reforms r WHERE r.norm_id = n.id) * 2
				        + (SELECT COUNT(*) FROM blocks b WHERE b.norm_id = n.id) DESC
				 LIMIT ?`,
			)
			.all(...storeList, topN);
	} else {
		// Only check for norms that SHOULD be in the store (same selection criteria)
		// but aren't yet. For now, just report — adding new norms requires --top N.
		missingVigente = [];
	}

	console.log(`\n=== ADD: ${missingVigente.length} vigente norms to embed ===`);
	if (missingVigente.length > 0) {
		for (const r of missingVigente.slice(0, 10)) {
			console.log(`  ${r.id}: ${r.title.slice(0, 60)}`);
		}
		if (missingVigente.length > 10) {
			console.log(`  ... and ${missingVigente.length - 10} more`);
		}
	} else {
		console.log("  (none — use --top N to add new norms)");
	}
}

// ── Dry run summary ──

const hasRemovals = derogatedInStore.length > 0 && !addOnly;
const hasAdditions = missingVigente.length > 0 && !removeOnly;

if (!hasRemovals && !hasAdditions) {
	console.log("\n✅ Store is in sync. Nothing to do.");
	process.exit(0);
}

if (dryRun) {
	if (hasAdditions) {
		// Estimate cost
		const addIds = missingVigente.map((r) => r.id);
		const ph = addIds.map(() => "?").join(",");
		const articleCount = db
			.query<{ cnt: number }, string[]>(
				`SELECT COUNT(*) as cnt FROM blocks b
				 JOIN norms n ON n.id = b.norm_id
				 WHERE b.norm_id IN (${ph})
				   AND b.block_type = 'precepto'
				   AND b.current_text != ''
				   AND n.status != 'derogada'`,
			)
			.get(...addIds)!.cnt;
		const estChunks = Math.ceil(articleCount * 1.35);
		const estCost = (estChunks * 250 * 0.2) / 1_000_000;
		console.log(`\n  Estimated: ~${estChunks} chunks, ~$${estCost.toFixed(4)}`);
	}
	console.log("\n  (dry run — no changes made)");
	process.exit(0);
}

// ── Step 3: Execute removals ──

let currentStore = store;

if (hasRemovals) {
	console.log("\nRemoving derogated norms...");
	const dims = currentStore.dimensions;
	const keepIndices: number[] = [];

	for (let i = 0; i < currentStore.articles.length; i++) {
		if (!derogatedIds.has(currentStore.articles[i]!.normId)) {
			keepIndices.push(i);
		}
	}

	const newArticles = keepIndices.map((i) => currentStore.articles[i]!);
	const newVectors = new Float32Array(keepIndices.length * dims);
	for (let j = 0; j < keepIndices.length; j++) {
		const srcOffset = keepIndices[j]! * dims;
		newVectors.set(
			currentStore.vectors.subarray(srcOffset, srcOffset + dims),
			j * dims,
		);
	}

	const newNorms = new Float32Array(keepIndices.length);
	for (let i = 0; i < keepIndices.length; i++) {
		const offset = i * dims;
		let sum = 0;
		for (let j = 0; j < dims; j++) {
			const v = newVectors[offset + j] ?? 0;
			sum += v * v;
		}
		newNorms[i] = Math.sqrt(sum);
	}

	currentStore = {
		model: currentStore.model,
		dimensions: dims,
		count: newArticles.length,
		articles: newArticles,
		vectors: newVectors,
		norms: newNorms,
	};

	const removed = store.count - currentStore.count;
	console.log(`  Removed ${removed} articles (${derogatedIds.size} norms)`);
	console.log(`  Store: ${store.count} → ${currentStore.count} articles`);
}

// ── Step 4: Execute additions ──

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
	console.log(`  Estimated cost: ~$${((prepared.length * 250 * 0.2) / 1_000_000).toFixed(4)}`);

	const newStore = await generateEmbeddings(
		apiKey!,
		"gemini-embedding-2",
		prepared,
		(done, total) => {
			process.stdout.write(`\r  Progress: ${done}/${total} (${((done / total) * 100).toFixed(0)}%)`);
		},
	);
	console.log();

	// Merge
	const dims = currentStore.dimensions;
	const totalCount = currentStore.count + newStore.count;
	const mergedVectors = new Float32Array(totalCount * dims);
	mergedVectors.set(currentStore.vectors);
	mergedVectors.set(newStore.vectors, currentStore.count * dims);

	const mergedArticles = [...currentStore.articles, ...newStore.articles];

	const mergedNorms = new Float32Array(totalCount);
	for (let i = 0; i < totalCount; i++) {
		const offset = i * dims;
		let sum = 0;
		for (let j = 0; j < dims; j++) {
			const v = mergedVectors[offset + j] ?? 0;
			sum += v * v;
		}
		mergedNorms[i] = Math.sqrt(sum);
	}

	currentStore = {
		model: "gemini-embedding-2",
		dimensions: dims,
		count: totalCount,
		articles: mergedArticles,
		vectors: mergedVectors,
		norms: mergedNorms,
	};

	console.log(`  Added ${newStore.count} articles from ${missingVigente.length} norms`);
}

// ── Step 5: Save ──

console.log("\nSaving store...");
await saveEmbeddings(currentStore, storePath);

const finalNorms = new Set(currentStore.articles.map((a) => a.normId));
const sizeMB = (currentStore.vectors.byteLength / 1024 / 1024).toFixed(1);

console.log(`\n✅ Sync complete!`);
console.log(`  Store: ${currentStore.count} articles from ${finalNorms.size} norms (${sizeMB} MB)`);
console.log(`  Saved to: ${storePath}.{meta.json,vectors.bin}`);

if (hasRemovals) {
	console.log(`  Removed: ${derogatedIds.size} derogated norms (${store.count - (hasAdditions ? currentStore.count - (currentStore.count - store.count) : currentStore.count)} articles)`);
}
