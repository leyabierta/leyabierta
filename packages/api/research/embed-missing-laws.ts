/**
 * Generate embeddings for specific missing laws and merge into the top500 store.
 *
 * Usage:
 *   bun run packages/api/research/embed-missing-laws.ts
 *   bun run packages/api/research/embed-missing-laws.ts --dry-run
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
	generateEmbeddings,
	loadEmbeddings,
	saveEmbeddings,
} from "../src/services/rag/embeddings.ts";
import { splitByApartados } from "../src/services/rag/subchunk.ts";

const dryRun = process.argv.includes("--dry-run");
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey && !dryRun) {
	console.error("Set OPENROUTER_API_KEY");
	process.exit(1);
}

const repoRoot = join(import.meta.dir, "../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const storePath = join(
	repoRoot,
	"data",
	"spike-embeddings-gemini-embedding-2-top500",
);

// Laws to add — verified missing from the top500 embedding store
const MISSING_LAWS = [
	"BOE-A-1994-26003", // LAU (Arrendamientos Urbanos)
	"BOE-A-2018-16673", // LOPDGDD (Protección de Datos)
	"BOE-A-2007-13409", // LETA (Trabajo Autónomo)
	"BOE-A-2023-12203", // Ley de Vivienda 2023
];

// ── Load existing store ──

console.log("Loading existing embedding store...");
const existing = await loadEmbeddings(storePath);
const existingNorms = new Set(existing.articles.map((a) => a.normId));
const toEmbed = MISSING_LAWS.filter((id) => !existingNorms.has(id));

if (toEmbed.length === 0) {
	console.log("All laws already in store. Nothing to do.");
	process.exit(0);
}

console.log(
	`Existing: ${existing.count} articles from ${existingNorms.size} norms`,
);
console.log(`Missing laws to embed: ${toEmbed.join(", ")}`);

// ── Get articles from DB ──

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");

const placeholders = toEmbed.map(() => "?").join(",");
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
	.all(...toEmbed);

// ── Prepare with sub-chunking (same logic as spike-generate-embeddings.ts) ──

const prepared: Array<{ normId: string; blockId: string; text: string }> = [];
for (const a of articles) {
	const chunks = splitByApartados(a.block_id, a.title, a.current_text);
	if (chunks) {
		for (const chunk of chunks) {
			prepared.push({
				normId: a.norm_id,
				blockId: chunk.blockId,
				text: `[${a.norm_title}]\n${chunk.title}\n\n${chunk.text}`,
			});
		}
	} else {
		prepared.push({
			normId: a.norm_id,
			blockId: a.block_id,
			text: `[${a.norm_title}]\n${a.title}\n\n${a.current_text}`,
		});
	}
}

console.log(`\nArticles from DB: ${articles.length}`);
console.log(`After sub-chunking: ${prepared.length}`);
console.log(`Estimated tokens: ~${(prepared.length * 250).toLocaleString()}`);
console.log(
	`Estimated cost: ~$${((prepared.length * 250 * 0.2) / 1_000_000).toFixed(4)}`,
);

if (dryRun) {
	for (const id of toEmbed) {
		const count = prepared.filter((a) => a.normId === id).length;
		const title = articles.find((a) => a.norm_id === id)?.norm_title ?? "?";
		console.log(`  ${id}: ${count} chunks — ${title.slice(0, 60)}`);
	}
	process.exit(0);
}

// ── Generate embeddings ──

console.log("\nGenerating embeddings...");
const newStore = await generateEmbeddings(
	apiKey!,
	"gemini-embedding-2",
	prepared,
	(done, total) => {
		process.stdout.write(
			`\r  Progress: ${done}/${total} (${((done / total) * 100).toFixed(0)}%)`,
		);
	},
);
console.log();

// ── Merge with existing store ──

console.log("Merging with existing store...");
const dims = existing.dimensions;
const totalCount = existing.count + newStore.count;
const mergedVectors = new Float32Array(totalCount * dims);

// Copy existing vectors
mergedVectors.set(existing.vectors);
// Append new vectors
mergedVectors.set(newStore.vectors, existing.count * dims);

// Merge article metadata
const mergedArticles = [
	...existing.articles,
	...newStore.articles,
];

// Compute norms for merged vectors
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

await saveEmbeddings(
	{
		model: "gemini-embedding-2",
		dimensions: dims,
		count: totalCount,
		articles: mergedArticles,
		vectors: mergedVectors,
		norms: mergedNorms,
	},
	storePath,
);

const newNorms = new Set(newStore.articles.map((a) => a.normId));
const finalNorms = new Set(mergedArticles.map((a) => a.normId));
const sizeMB = (mergedVectors.byteLength / 1024 / 1024).toFixed(1);

console.log(`\nDone!`);
console.log(`  Added: ${newStore.count} articles from ${newNorms.size} laws`);
console.log(
	`  Total: ${totalCount} articles from ${finalNorms.size} laws (${sizeMB} MB)`,
);
console.log(`  Saved to: ${storePath}.{meta.json,vectors.bin}`);
