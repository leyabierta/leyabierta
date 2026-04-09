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
import { SPIKE_LAW_IDS } from "../services/rag/spike-laws.ts";
import {
	generateEmbeddings,
	saveEmbeddings,
	EMBEDDING_MODELS,
} from "../services/rag/embeddings.ts";

const args = process.argv.slice(2);
const getArg = (name: string) => {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(`--${name}`);

const modelKey = getArg("model") ?? "openai-small";
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

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// ── Get articles ──

const spikeFilter = SPIKE_LAW_IDS.map((id) => `'${id}'`).join(",");

const articles = db
	.query<{
		norm_id: string;
		block_id: string;
		title: string;
		current_text: string;
	}>(
		`SELECT b.norm_id, b.block_id, b.title, b.current_text
     FROM blocks b
     WHERE b.norm_id IN (${spikeFilter})
       AND b.block_type = 'precepto'
       AND b.current_text != ''
     ORDER BY b.norm_id, b.position`,
	)
	.all();

console.log(`\n╔══════════════════════════════════════════════╗`);
console.log(`║  Generate Embeddings for RAG Spike            ║`);
console.log(`╚══════════════════════════════════════════════╝`);
console.log(`  Model:    ${modelKey} (${model.id})`);
console.log(`  Dims:     ${model.dimensions}`);
console.log(`  Articles: ${articles.length.toLocaleString()}`);
console.log(`  Laws:     ${SPIKE_LAW_IDS.length}`);

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

const preparedArticles = articles.map((a) => ({
	normId: a.norm_id,
	blockId: a.block_id,
	text: `${a.title}\n\n${a.current_text}`,
}));

const store = await generateEmbeddings(
	apiKey!,
	modelKey,
	preparedArticles,
	(done, total) => {
		const pct = ((done / total) * 100).toFixed(1);
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
		process.stdout.write(`\r  Progress: ${done}/${total} (${pct}%) — ${elapsed}s`);
	},
);

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n  Completed in ${elapsed}s`);

// ── Save ──

const outputPath = join(repoRoot, "data", `spike-embeddings-${modelKey}`);
await saveEmbeddings(store, outputPath);

const vectorsSize = (store.vectors.byteLength / 1024 / 1024).toFixed(1);
console.log(`  Saved to: ${outputPath}.{meta.json,vectors.bin}`);
console.log(`  Vectors size: ${vectorsSize} MB`);
console.log(`  Dimensions: ${store.dimensions}`);
console.log(`  Articles: ${store.count.toLocaleString()}`);
