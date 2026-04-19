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

const spikeFilter = SPIKE_LAW_IDS.map((id) => `'${id}'`).join(",");

const articles = db
	.query<{
		norm_id: string;
		norm_title: string;
		block_id: string;
		title: string;
		current_text: string;
	}>(
		`SELECT b.norm_id, n.title as norm_title, b.block_id, b.title, b.current_text
     FROM blocks b
     JOIN norms n ON n.id = b.norm_id
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

// Enrich embedding text with law name for better semantic separation.
// "Estatuto de los Trabajadores — Artículo 48" embeds differently from
// "EBEP — Artículo 48", helping retrieval distinguish which law applies.
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
				text: `[${a.norm_title}]\n${chunk.title}\n\n${chunk.text}`,
			});
		}
	} else {
		preparedArticles.push({
			normId: a.norm_id,
			blockId: a.block_id,
			text: `[${a.norm_title}]\n${a.title}\n\n${a.current_text}`,
		});
	}
}

console.log(
	`  Sub-chunked: ${subchunkedCount} articles → ${subchunkTotal} sub-chunks (+${subchunkTotal - subchunkedCount} net)`,
);

const store = await generateEmbeddings(
	apiKey!,
	modelKey,
	preparedArticles,
	(done, total) => {
		const pct = ((done / total) * 100).toFixed(1);
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
		process.stdout.write(
			`\r  Progress: ${done}/${total} (${pct}%) — ${elapsed}s`,
		);
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
