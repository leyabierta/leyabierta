/**
 * Test sub-chunking on ET art.48 (paternidad).
 *
 * Verifies:
 * 1. Splitting by numbered apartados works
 * 2. Sub-chunk 4 contains "nacimiento"/"paternidad"
 * 3. Embedding the sub-chunk gets better cosine similarity for "baja paternidad"
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath, { readonly: true });

// ── Sub-chunk logic ──

interface SubChunk {
	/** e.g. "a48__4" */
	blockId: string;
	/** e.g. "Artículo 48.4 — Nacimiento y cuidado de menor" */
	title: string;
	/** Sub-chunk text */
	text: string;
	/** 1-based apartado number */
	apartado: number;
}

/**
 * Split an article's text by numbered apartados (e.g. "1. ...", "2. ...").
 * Only splits if the article is longer than `threshold` chars AND has at least 2 apartados.
 */
function splitByApartados(
	blockId: string,
	blockTitle: string,
	text: string,
	threshold = 3000,
): SubChunk[] | null {
	if (text.length <= threshold) return null;

	// Match numbered apartados at line start: "1. ", "2. ", ..., "10. "
	const pattern = /^(\d+)\.\s/gm;
	const matches: Array<{ index: number; num: number }> = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		matches.push({ index: match.index, num: parseInt(match[1], 10) });
	}

	// Need at least 2 apartados, and they should start from 1
	if (matches.length < 2 || matches[0].num !== 1) return null;

	// Filter to only sequential apartados (1, 2, 3... — skip false positives like "20.000 euros")
	const validMatches: typeof matches = [matches[0]];
	for (let i = 1; i < matches.length; i++) {
		const expected = validMatches[validMatches.length - 1].num + 1;
		if (matches[i].num === expected) {
			validMatches.push(matches[i]);
		}
	}

	if (validMatches.length < 2) return null;

	// Extract base article name (e.g. "Artículo 48" from "Artículo 48. Suspensión con reserva...")
	const baseTitle = blockTitle.replace(/\.\s.*$/, "");

	const chunks: SubChunk[] = [];
	for (let i = 0; i < validMatches.length; i++) {
		const start = validMatches[i].index;
		const end =
			i + 1 < validMatches.length ? validMatches[i + 1].index : text.length;
		const chunkText = text.slice(start, end).trim();

		// Synthetic title: first sentence (up to 100 chars) of the chunk
		const firstSentence = chunkText
			.replace(/^\d+\.\s*/, "") // remove "4. " prefix
			.split(/\.\s/)[0]; // first sentence
		const synopsis =
			firstSentence.length > 100
				? `${firstSentence.slice(0, 97)}...`
				: firstSentence;

		chunks.push({
			blockId: `${blockId}__${validMatches[i].num}`,
			title: `${baseTitle}.${validMatches[i].num} — ${synopsis}`,
			text: chunkText,
			apartado: validMatches[i].num,
		});
	}

	return chunks;
}

// ── Test on ET art.48 ──

const row = db
	.query<{ block_id: string; title: string; current_text: string }, string>(
		"SELECT block_id, title, current_text FROM blocks WHERE norm_id=? AND block_id='a48'",
	)
	.get("BOE-A-2015-11430");

if (!row) {
	console.error("ET art.48 not found!");
	process.exit(1);
}

console.log(`\n=== ET Artículo 48 ===`);
console.log(`Title: ${row.title}`);
console.log(`Total length: ${row.current_text.length} chars\n`);

const chunks = splitByApartados(row.block_id, row.title, row.current_text);

if (!chunks) {
	console.error("No chunks produced!");
	process.exit(1);
}

console.log(`Sub-chunks: ${chunks.length}\n`);

for (const chunk of chunks) {
	const keywords = [
		"nacimiento",
		"paternidad",
		"maternidad",
		"progenitor",
		"parto",
	];
	const found = keywords.filter((kw) => chunk.text.toLowerCase().includes(kw));
	console.log(
		`  ${chunk.blockId.padEnd(8)} | ${chunk.text.length.toString().padStart(5)} chars | ${chunk.title.slice(0, 80)}`,
	);
	if (found.length > 0) {
		console.log(`           ↳ keywords: ${found.join(", ")}`);
	}
}

// ── Test on more ET articles ──

console.log(`\n=== Sub-chunking all long ET articles ===\n`);

const longArticles = db
	.query<{ block_id: string; title: string; current_text: string }, [string]>(
		`SELECT block_id, title, current_text FROM blocks
     WHERE norm_id=? AND block_type='precepto' AND length(current_text) > 3000
     ORDER BY length(current_text) DESC`,
	)
	.all("BOE-A-2015-11430");

let totalOriginal = 0;
let totalChunks = 0;
let unchunkable = 0;

for (const art of longArticles) {
	const chunks = splitByApartados(art.block_id, art.title, art.current_text);
	totalOriginal++;
	if (chunks) {
		totalChunks += chunks.length;
		console.log(
			`  ${art.block_id.padEnd(8)} ${art.current_text.length.toString().padStart(6)} chars → ${chunks.length} sub-chunks (avg ${Math.round(art.current_text.length / chunks.length)} chars)`,
		);
	} else {
		unchunkable++;
		console.log(
			`  ${art.block_id.padEnd(8)} ${art.current_text.length.toString().padStart(6)} chars → unchunkable (no sequential apartados)`,
		);
	}
}

console.log(`\nSummary:`);
console.log(`  Long articles: ${totalOriginal}`);
console.log(`  Chunkable:     ${totalOriginal - unchunkable}`);
console.log(`  Unchunkable:   ${unchunkable}`);
console.log(`  Total chunks:  ${totalChunks}`);
console.log(
	`  Avg chunks/article: ${(totalChunks / (totalOriginal - unchunkable)).toFixed(1)}`,
);

// ── Embedding test: compare cosine similarity ──

const apiKey = process.env.OPENROUTER_API_KEY;
if (apiKey) {
	console.log(`\n=== Embedding similarity test ===\n`);

	const { embedQuery, loadEmbeddings, vectorSearch } = await import(
		"../src/services/rag/embeddings.ts"
	);

	const EMBEDDING_MODEL_KEY = "gemini-embedding-2";

	// Embed the test query
	const query = "¿Cuánto dura la baja por paternidad?";
	const queryResult = await embedQuery(apiKey, EMBEDDING_MODEL_KEY, query);
	console.log(`Query: "${query}"`);
	console.log(`Query embedding cost: $${queryResult.cost.toFixed(8)}\n`);

	// Load current embeddings and search
	const embeddingsPath = join(
		repoRoot,
		"data",
		"spike-embeddings-gemini-embedding-2",
	);
	const store = await loadEmbeddings(embeddingsPath);
	const results = vectorSearch(queryResult.embedding, store, 15);

	console.log(`Current top-15 retrieval (NO sub-chunking):`);
	for (const r of results) {
		const art = db
			.query<{ title: string }, [string, string]>(
				"SELECT title FROM blocks WHERE norm_id=? AND block_id=?",
			)
			.get(r.normId, r.blockId);
		const marker =
			r.normId === "BOE-A-2015-11430" && r.blockId === "a48" ? " ★" : "";
		console.log(
			`  ${r.score.toFixed(4)} | ${r.normId} / ${r.blockId} — ${art?.title ?? "?"}${marker}`,
		);
	}

	// Now embed sub-chunk 4 and compare
	const chunk4 = chunks.find((c) => c.apartado === 4);
	if (chunk4) {
		const subchunkText = `[Estatuto de los Trabajadores]\n${chunk4.title}\n\n${chunk4.text}`;
		// Embed the sub-chunk text (truncated like generateEmbeddings does)
		const truncated = subchunkText.slice(0, 2000);
		const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://leyabierta.es",
				"X-Title": "Ley Abierta RAG test",
			},
			body: JSON.stringify({
				model: "google/gemini-embedding-2-preview",
				input: truncated,
			}),
		});

		const data: any = await response.json();
		const subchunkEmb = new Float32Array(data.data[0].embedding);

		// Cosine similarity between query and sub-chunk embedding
		let dot = 0,
			normA = 0,
			normB = 0;
		for (let i = 0; i < queryResult.embedding.length; i++) {
			dot += queryResult.embedding[i] * subchunkEmb[i];
			normA += queryResult.embedding[i] * queryResult.embedding[i];
			normB += subchunkEmb[i] * subchunkEmb[i];
		}
		const cosineSim = dot / (Math.sqrt(normA) * Math.sqrt(normB));

		// Also get current art.48 full embedding similarity
		const a48idx = store.articles.findIndex(
			(a) => a.normId === "BOE-A-2015-11430" && a.blockId === "a48",
		);
		let a48Sim = 0;
		if (a48idx >= 0) {
			const result = results.find(
				(r) => r.normId === "BOE-A-2015-11430" && r.blockId === "a48",
			);
			a48Sim = result?.score ?? 0;
		}

		console.log(`\nSub-chunk comparison for "baja paternidad":`);
		console.log(
			`  Full art.48 embedding:  ${a48Sim > 0 ? a48Sim.toFixed(4) : "NOT IN TOP 15"} ${a48Sim > 0 ? "" : "(below 0.35 threshold)"}`,
		);
		console.log(`  Sub-chunk 48.4 embedding: ${cosineSim.toFixed(4)}`);
		console.log(
			`  Improvement: ${a48Sim > 0 ? `+${((cosineSim - a48Sim) * 100).toFixed(1)}%` : `from unranked to ${cosineSim.toFixed(4)}`}`,
		);
		console.log(
			`\n  Sub-chunk 48.4 text preview:\n    ${chunk4.text.slice(0, 200)}...`,
		);
	}
} else {
	console.log(
		"\nSkipping embedding test (no OPENROUTER_API_KEY). Run with env var to test similarity.",
	);
}
