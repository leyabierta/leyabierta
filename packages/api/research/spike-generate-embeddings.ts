/**
 * Generate embeddings for the spike subset articles.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-generate-embeddings.ts
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-generate-embeddings.ts --model openai-small
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-generate-embeddings.ts --model qwen3
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-generate-embeddings.ts --dry-run
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import {
	EMBEDDING_MODELS,
	generateEmbeddings,
	saveEmbeddings,
} from "../src/services/rag/embeddings.ts";
import { splitByApartados } from "../src/services/rag/subchunk.ts";
import { SPIKE_LAW_IDS } from "./spike-laws.ts";

const args = process.argv.slice(2);
const getArg = (name: string) => {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(`--${name}`);

const modelKey = getArg("model") ?? "openai-small";
const topN = getArg("top") ? Number(getArg("top")) : undefined;
const fromRank = getArg("from") ? Number(getArg("from")) : 0;
const countN = getArg("count") ? Number(getArg("count")) : undefined;
const mergeFiles = hasFlag("merge");
const dryRun = hasFlag("dry-run");

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey && !dryRun) {
	console.error("Set OPENROUTER_API_KEY");
	process.exit(1);
}

const model = EMBEDDING_MODELS[modelKey];
if (!model) {
	console.error(
		`Unknown model: ${modelKey}. Available: ${Object.keys(EMBEDDING_MODELS).join(", ")}`,
	);
	process.exit(1);
}

// ── DB ──

const repoRoot = join(import.meta.dir, "../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// ── Get articles ──

// Law selection modes:
//   --top N              → top N laws ranked by (reforms*2 + blocks)
//   --from F --count C   → laws ranked F..F+C (for batch runs)
//   (default)            → SPIKE_LAW_IDS hardcoded list
//   --merge              → merge batch files into one (no generation)
let lawIds: string[];

if (mergeFiles) {
	// Merge mode — handled after this block
	lawIds = [];
} else if (countN !== undefined) {
	const topLaws = db
		.query<{ id: string }, [number, number]>(
			`SELECT n.id FROM norms n
			 ORDER BY (SELECT COUNT(*) FROM reforms r WHERE r.norm_id = n.id) * 2
			        + (SELECT COUNT(*) FROM blocks b WHERE b.norm_id = n.id) DESC
			 LIMIT ? OFFSET ?`,
		)
		.all(countN, fromRank);
	lawIds = topLaws.map((r) => r.id);
} else if (topN) {
	const topLaws = db
		.query<{ id: string }, [number]>(
			`SELECT n.id FROM norms n
			 ORDER BY (SELECT COUNT(*) FROM reforms r WHERE r.norm_id = n.id) * 2
			        + (SELECT COUNT(*) FROM blocks b WHERE b.norm_id = n.id) DESC
			 LIMIT ?`,
		)
		.all(topN);
	lawIds = topLaws.map((r) => r.id);
} else {
	lawIds = SPIKE_LAW_IDS;
}

const placeholders = lawIds.map(() => "?").join(",");
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
     WHERE b.norm_id IN (${placeholders})
       AND b.block_type = 'precepto'
       AND b.current_text != ''
     ORDER BY b.norm_id, b.position`,
	)
	.all(...lawIds);

// ── Merge mode ──
if (mergeFiles) {
	const { loadEmbeddings, saveEmbeddings } = await import(
		"../src/services/rag/embeddings.ts"
	);
	const glob = new Bun.Glob(`spike-embeddings-${modelKey}-batch-*.meta.json`);
	const dataDir = join(repoRoot, "data");
	const batchFiles = [...glob.scanSync(dataDir)].sort();

	if (batchFiles.length === 0) {
		console.error("No batch files found to merge.");
		process.exit(1);
	}

	console.log(`\nMerging ${batchFiles.length} batch files...`);
	const allArticles: Array<{ normId: string; blockId: string; index: number }> =
		[];
	const allVectors: Float32Array[] = [];
	let dims = 0;

	for (const metaFile of batchFiles) {
		const basePath = join(dataDir, metaFile.replace(".meta.json", ""));
		const store = await loadEmbeddings(basePath);
		dims = store.dimensions;
		const offset = allArticles.length;
		for (const a of store.articles) {
			allArticles.push({
				normId: a.normId,
				blockId: a.blockId,
				index: offset + a.index,
			});
		}
		allVectors.push(store.vectors);
		console.log(`  ${metaFile}: ${store.count} articles`);
	}

	// Deduplicate by normId:blockId (batches may overlap if re-run)
	const seen = new Set<string>();
	const uniqueArticles: typeof allArticles = [];
	const uniqueEmbeddings: Float32Array[] = [];
	const globalIdx = 0;
	for (let batchIdx = 0; batchIdx < allVectors.length; batchIdx++) {
		const batchStart =
			batchIdx === 0
				? 0
				: allArticles.findIndex(
						(a) =>
							a.index >=
							allVectors
								.slice(0, batchIdx)
								.reduce((s, v) => s + v.length / dims, 0),
					);
		// simpler: iterate all articles in order
	}
	// Actually simpler approach: iterate allArticles + extract from concatenated vectors
	const totalCount = allArticles.length;
	const mergedVectors = new Float32Array(totalCount * dims);
	let vecOffset = 0;
	for (const v of allVectors) {
		mergedVectors.set(v, vecOffset);
		vecOffset += v.length;
	}

	for (let i = 0; i < allArticles.length; i++) {
		const a = allArticles[i]!;
		const key = `${a.normId}:${a.blockId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		uniqueArticles.push({ ...a, index: uniqueArticles.length });
		const src = mergedVectors.subarray(i * dims, (i + 1) * dims);
		uniqueEmbeddings.push(new Float32Array(src));
	}

	const finalVectors = new Float32Array(uniqueArticles.length * dims);
	for (let i = 0; i < uniqueEmbeddings.length; i++) {
		finalVectors.set(uniqueEmbeddings[i]!, i * dims);
	}

	const outputName = `spike-embeddings-${modelKey}-top500`;
	const outputMergePath = join(dataDir, outputName);
	await saveEmbeddings(
		{
			articles: uniqueArticles,
			vectors: finalVectors,
			dimensions: dims,
			count: uniqueArticles.length,
			model: modelKey,
			norms: new Float32Array(0),
		},
		outputMergePath,
	);

	const size = (finalVectors.byteLength / 1024 / 1024).toFixed(1);
	console.log(`\n  Merged: ${uniqueArticles.length} unique articles`);
	console.log(`  Saved to: ${outputMergePath}.{meta.json,vectors.bin}`);
	console.log(`  Size: ${size} MB`);
	process.exit(0);
}

console.log(`\n╔══════════════════════════════════════════════╗`);
console.log(`║  Generate Embeddings for RAG Spike            ║`);
console.log(`╚══════════════════════════════════════════════╝`);
console.log(`  Model:    ${modelKey} (${model.id})`);
console.log(`  Dims:     ${model.dimensions}`);
console.log(`  Articles: ${articles.length.toLocaleString()}`);
const rangeLabel = countN
	? `ranks ${fromRank}-${fromRank + countN}`
	: topN
		? `top ${topN}`
		: "spike subset";
console.log(`  Laws:     ${lawIds.length} (${rangeLabel})`);

if (dryRun) {
	// Estimate cost: ~500 tokens per article average
	const estimatedTokens = articles.length * 250;
	console.log(`\n  [DRY RUN]`);
	console.log(`  Estimated tokens: ${estimatedTokens.toLocaleString()}`);
	console.log(`  Estimated batches: ${Math.ceil(articles.length / 50)}`);
	// Show sample articles
	console.log(`\n  Sample articles:`);
	for (const a of articles.slice(0, 5)) {
		console.log(
			`    ${a.norm_id} / ${a.block_id}: ${a.title} (${a.current_text.length} chars)`,
		);
	}
	process.exit(0);
}

// ── Generate ──

const startTime = Date.now();

// Enrich embedding text with law name for better semantic separation.
// "Estatuto de los Trabajadores — Artículo 48" embeds differently from
// "EBEP — Artículo 48", helping retrieval distinguish which law applies.
//
// Format follows Gemini Embedding 2 recommendation for asymmetric retrieval:
//   title: {norm_title} | text: {article_title}\n\n{article_text}
// See: https://ai.google.dev/gemini-api/docs/embeddings
//
// Sub-chunking: long articles (>3000 chars) with numbered apartados are
// split into sub-chunks. Each sub-chunk gets its own embedding with a
// synthetic title (e.g. "Artículo 48.4 — El nacimiento...").
// Short articles and unchunkable ones keep their single embedding.
const preparedArticles: Array<{
	normId: string;
	blockId: string;
	text: string;
}> = [];
let subchunkedCount = 0;
let subchunkTotal = 0;

for (const a of articles) {
	const chunks = splitByApartados(a.block_id, a.title, a.current_text);
	if (chunks) {
		subchunkedCount++;
		subchunkTotal += chunks.length;
		for (const chunk of chunks) {
			preparedArticles.push({
				normId: a.norm_id,
				blockId: chunk.blockId,
				text: `title: ${a.norm_title} | text: ${chunk.title}\n\n${chunk.text}`,
			});
		}
	} else {
		preparedArticles.push({
			normId: a.norm_id,
			blockId: a.block_id,
			text: `title: ${a.norm_title} | text: ${a.title}\n\n${a.current_text}`,
		});
	}
}

console.log(
	`  Sub-chunked: ${subchunkedCount} articles → ${subchunkTotal} sub-chunks (+${subchunkTotal - subchunkedCount} net)`,
);

// ── Generate with checkpointing ──

const suffix = countN
	? `-batch-${fromRank}-${fromRank + countN}`
	: topN
		? `-top${topN}`
		: "";
const outputPath = join(
	repoRoot,
	"data",
	`spike-embeddings-${modelKey}${suffix}`,
);
const checkpointMetaPath = `${outputPath}.checkpoint.json`;
const checkpointVectorsPath = `${outputPath}.checkpoint.vectors.bin`;

// Try to resume from checkpoint
let startIndex = 0;
let resumedMeta: Array<{ normId: string; blockId: string }> = [];
let resumedVectors: Float32Array | null = null;

if (await Bun.file(checkpointMetaPath).exists()) {
	const cp = JSON.parse(await Bun.file(checkpointMetaPath).text()) as {
		completedArticles: number;
		meta: Array<{ normId: string; blockId: string }>;
	};
	startIndex = cp.completedArticles;
	resumedMeta = cp.meta;
	if (await Bun.file(checkpointVectorsPath).exists()) {
		resumedVectors = new Float32Array(
			await Bun.file(checkpointVectorsPath).arrayBuffer(),
		);
	}
	console.log(
		`  Resuming from checkpoint: ${startIndex}/${preparedArticles.length} already done`,
	);
}

const remaining = preparedArticles.slice(startIndex);

const store = await generateEmbeddings(
	apiKey!,
	modelKey,
	remaining,
	(done, total) => {
		const globalDone = startIndex + done;
		const globalTotal = startIndex + total;
		const pct = ((globalDone / globalTotal) * 100).toFixed(1);
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
		process.stdout.write(
			`\r  Progress: ${globalDone}/${globalTotal} (${pct}%) — ${elapsed}s`,
		);
	},
	async (cp) => {
		// Save checkpoint: meta + vectors to disk
		const globalMeta = [...resumedMeta, ...cp.meta];
		await Bun.write(
			checkpointMetaPath,
			JSON.stringify({
				completedArticles: startIndex + cp.completedArticles,
				meta: globalMeta,
			}),
		);
		if (resumedVectors) {
			const merged = new Float32Array(
				resumedVectors.length + cp.vectors.length,
			);
			merged.set(resumedVectors, 0);
			merged.set(cp.vectors, resumedVectors.length);
			await Bun.write(checkpointVectorsPath, merged.buffer);
		} else {
			await Bun.write(checkpointVectorsPath, cp.vectors.buffer);
		}
		console.log(
			`\n  Checkpoint saved: ${startIndex + cp.completedArticles} articles`,
		);
	},
);

// Merge with resumed data
if (resumedVectors && resumedMeta.length > 0) {
	const dims = store.dimensions;
	const mergedCount = resumedMeta.length + store.count;
	const mergedVectors = new Float32Array(mergedCount * dims);
	mergedVectors.set(resumedVectors, 0);
	mergedVectors.set(store.vectors, resumedMeta.length * dims);

	store.articles = [
		...resumedMeta.map((m, i) => ({ ...m, index: i })),
		...store.articles.map((a) => ({
			...a,
			index: a.index + resumedMeta.length,
		})),
	];
	store.vectors = mergedVectors;
	store.count = mergedCount;
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n  Completed in ${elapsed}s`);

// ── Save final ──

await saveEmbeddings(store, outputPath);

// Clean up checkpoints
const { unlink } = await import("node:fs/promises");
await unlink(checkpointMetaPath).catch(() => {});
await unlink(checkpointVectorsPath).catch(() => {});

const vectorsSize = (store.vectors.byteLength / 1024 / 1024).toFixed(1);
console.log(`  Saved to: ${outputPath}.{meta.json,vectors.bin}`);
console.log(`  Vectors size: ${vectorsSize} MB`);
console.log(`  Dimensions: ${store.dimensions}`);
console.log(`  Articles: ${store.count.toLocaleString()}`);
