/**
 * A/B test: old embedding format vs new Gemini-recommended format.
 *
 * Generates embeddings for a small subset of key laws using both formats,
 * then runs the temporal-conflict eval questions against each to compare
 * retrieval quality.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/research/ab-test-embedding-format.ts
 *   OPENROUTER_API_KEY=... bun run packages/api/research/ab-test-embedding-format.ts --dry-run
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import {
	EMBEDDING_MODELS,
	embedQuery,
	generateEmbeddings,
	saveEmbeddings,
	vectorSearch,
} from "../src/services/rag/embeddings.ts";
import { splitByApartados } from "../src/services/rag/subchunk.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey && !dryRun) {
	console.error("Set OPENROUTER_API_KEY");
	process.exit(1);
}

const modelKey = "gemini-embedding-2";
const model = EMBEDDING_MODELS[modelKey]!;
const repoRoot = join(import.meta.dir, "../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

// ── Key laws for the temporal eval subset ──
const TEST_LAW_IDS = [
	"BOE-A-2015-11430", // ET (Estatuto de los Trabajadores)
	"BOE-A-1994-26003", // LAU (Arrendamientos Urbanos)
	"BOE-A-2018-9268", // PGE 2018 (the temporal competitor)
	"BOE-A-2019-7414", // EBEP/Convenio AGE (sectoral competitor for Q1)
	"BOE-A-2006-20764", // IRPF
	"BOE-A-2015-11724", // LGSS
	"BOE-A-1978-31229", // Constitución
	"BOE-A-2023-12203", // Ley Vivienda
	"BOE-A-2018-16673", // LOPDGDD
	"BOE-A-2010-19703", // PGE 2010 (Q12 competitor)
	"BOE-A-2015-11719", // EBEP (Empleado Público)
	"BOE-A-2008-20744", // PGE 2008
];

// ── Test questions (temporal-conflict subset) ──
const TEST_QUESTIONS = [
	{
		id: "Q2",
		question: "¿Cuánto dura la baja por paternidad?",
		expectedNorm: "BOE-A-2015-11430",
		why: "Should find ET art.48, not PGE 2018",
	},
	{
		id: "Q1",
		question: "¿Cuántos días de vacaciones me corresponden al año?",
		expectedNorm: "BOE-A-2015-11430",
		why: "Should find ET art.38, not EBEP/Convenio AGE",
	},
	{
		id: "Q3",
		question: "¿Me puede subir el alquiler mi casero cuando quiera?",
		expectedNorm: "BOE-A-1994-26003",
		why: "Should find LAU art.18 (control question - already works)",
	},
	{
		id: "Q12",
		question:
			"¿Puedo deducirme el alquiler en la declaración de la renta como inquilino?",
		expectedNorm: "BOE-A-2006-20764",
		why: "Should find IRPF, not old PGE fiscal provisions",
	},
	{
		id: "Q7",
		question: "¿Qué derechos tengo si me despiden de forma improcedente?",
		expectedNorm: "BOE-A-2015-11430",
		why: "Should find ET art.55-56 (control question - already works)",
	},
];

// ── Get articles from DB ──
const placeholders = TEST_LAW_IDS.map(() => "?").join(",");
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
	.all(...TEST_LAW_IDS);

console.log(`\n╔══════════════════════════════════════════════════╗`);
console.log(`║  A/B Test: Embedding Format Comparison            ║`);
console.log(`╚══════════════════════════════════════════════════╝`);
console.log(`  Laws:     ${TEST_LAW_IDS.length}`);
console.log(`  Articles: ${articles.length}`);
console.log(`  Model:    ${modelKey} (${model.id})`);
console.log(`  Questions: ${TEST_QUESTIONS.length}`);

// ── Prepare articles in BOTH formats ──

type PreparedArticle = { normId: string; blockId: string; text: string };

function prepareOldFormat(arts: typeof articles): PreparedArticle[] {
	const result: PreparedArticle[] = [];
	for (const a of arts) {
		const chunks = splitByApartados(a.block_id, a.title, a.current_text);
		if (chunks) {
			for (const chunk of chunks) {
				result.push({
					normId: a.norm_id,
					blockId: chunk.blockId,
					text: `[${a.norm_title}]\n${chunk.title}\n\n${chunk.text}`,
				});
			}
		} else {
			result.push({
				normId: a.norm_id,
				blockId: a.block_id,
				text: `[${a.norm_title}]\n${a.title}\n\n${a.current_text}`,
			});
		}
	}
	return result;
}

function prepareNewFormat(arts: typeof articles): PreparedArticle[] {
	const result: PreparedArticle[] = [];
	for (const a of arts) {
		const chunks = splitByApartados(a.block_id, a.title, a.current_text);
		if (chunks) {
			for (const chunk of chunks) {
				result.push({
					normId: a.norm_id,
					blockId: chunk.blockId,
					text: `title: ${a.norm_title} | text: ${chunk.title}\n\n${chunk.text}`,
				});
			}
		} else {
			result.push({
				normId: a.norm_id,
				blockId: a.block_id,
				text: `title: ${a.norm_title} | text: ${a.title}\n\n${a.current_text}`,
			});
		}
	}
	return result;
}

const oldFormatArticles = prepareOldFormat(articles);
const newFormatArticles = prepareNewFormat(articles);

console.log(`\n  Old format articles: ${oldFormatArticles.length}`);
console.log(`  New format articles: ${newFormatArticles.length}`);

// Show sample of each format
console.log(`\n  ── Old format sample (ET art.48 subchunk 4) ──`);
const oldSample = oldFormatArticles.find(
	(a) => a.normId === "BOE-A-2015-11430" && a.blockId === "a48__4",
);
if (oldSample) console.log(`  ${oldSample.text.slice(0, 200)}...`);

console.log(`\n  ── New format sample (ET art.48 subchunk 4) ──`);
const newSample = newFormatArticles.find(
	(a) => a.normId === "BOE-A-2015-11430" && a.blockId === "a48__4",
);
if (newSample) console.log(`  ${newSample.text.slice(0, 200)}...`);

if (dryRun) {
	const estimatedTokens = oldFormatArticles.length * 2 * 300;
	console.log(`\n  [DRY RUN]`);
	console.log(
		`  Estimated tokens (both formats): ~${estimatedTokens.toLocaleString()}`,
	);
	console.log(
		`  Estimated cost: ~$${((estimatedTokens * 0.2) / 1_000_000).toFixed(2)}`,
	);
	console.log(`  + ${TEST_QUESTIONS.length * 2} query embeddings`);
	process.exit(0);
}

// ── Generate embeddings for both formats ──
const dataDir = join(repoRoot, "data");

console.log(`\n  Generating OLD format embeddings...`);
const oldStore = await generateEmbeddings(apiKey!, modelKey, oldFormatArticles);
const oldPath = join(dataDir, "ab-test-old-format");
await saveEmbeddings(oldStore, oldPath);
console.log(`  ✓ ${oldStore.count} embeddings saved`);

console.log(`\n  Generating NEW format embeddings...`);
const newStore = await generateEmbeddings(apiKey!, modelKey, newFormatArticles);
const newPath = join(dataDir, "ab-test-new-format");
await saveEmbeddings(newStore, newPath);
console.log(`  ✓ ${newStore.count} embeddings saved`);

// ── Run test questions against both stores ──
console.log(`\n${"=".repeat(70)}`);
console.log("RETRIEVAL COMPARISON");
console.log("=".repeat(70));

const TOP_K = 15;

for (const q of TEST_QUESTIONS) {
	console.log(`\n--- ${q.id}: ${q.question} ---`);
	console.log(`Expected: ${q.expectedNorm} | ${q.why}`);

	// Query WITHOUT task prefix (old behavior)
	const _oldQueryResult = await embedQuery(apiKey!, modelKey, q.question);
	// Manually create query WITH task prefix for fair comparison
	const newQueryText = `task: question answering | query: ${q.question}`;
	const newQueryResult = await embedQuery(apiKey!, modelKey, newQueryText);

	// Note: embedQuery now adds the prefix automatically for gemini-embedding-2,
	// so we need the raw version for the old format test
	const rawResponse = await fetch("https://openrouter.ai/api/v1/embeddings", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: model.id,
			input: q.question,
		}),
	});
	const rawData = (await rawResponse.json()) as {
		data: Array<{ embedding: number[] }>;
	};
	const oldQueryEmbedding = new Float32Array(rawData.data[0]!.embedding);

	// Search with old query against old store
	const oldResults = vectorSearch(oldQueryEmbedding, oldStore, TOP_K);
	// Search with new query against new store
	const newResults = vectorSearch(newQueryResult.embedding, newStore, TOP_K);

	// Find expected norm rank in each
	function findNormRank(
		results: typeof oldResults,
		normId: string,
	): { rank: number; score: number; blockId: string } | null {
		for (let i = 0; i < results.length; i++) {
			if (results[i]!.normId === normId) {
				return {
					rank: i + 1,
					score: results[i]!.score,
					blockId: results[i]!.blockId,
				};
			}
		}
		return null;
	}

	const oldHit = findNormRank(oldResults, q.expectedNorm);
	const newHit = findNormRank(newResults, q.expectedNorm);

	const oldStatus = oldHit
		? `✓ rank ${oldHit.rank} (score ${oldHit.score.toFixed(4)}, ${oldHit.blockId})`
		: "✗ NOT in top-15";
	const newStatus = newHit
		? `✓ rank ${newHit.rank} (score ${newHit.score.toFixed(4)}, ${newHit.blockId})`
		: "✗ NOT in top-15";

	const improved =
		newHit && oldHit
			? newHit.rank < oldHit.rank
				? " ⬆ IMPROVED"
				: newHit.rank > oldHit.rank
					? " ⬇ WORSE"
					: " = SAME"
			: newHit && !oldHit
				? " ⬆ NEW HIT"
				: !newHit && oldHit
					? " ⬇ LOST"
					: "";

	console.log(`  OLD format: ${oldStatus}`);
	console.log(`  NEW format: ${newStatus}${improved}`);

	// Show top-3 norms for context
	const oldTop3 = [
		...new Set(oldResults.slice(0, 5).map((r) => r.normId)),
	].slice(0, 3);
	const newTop3 = [
		...new Set(newResults.slice(0, 5).map((r) => r.normId)),
	].slice(0, 3);
	console.log(`  OLD top norms: ${oldTop3.join(", ")}`);
	console.log(`  NEW top norms: ${newTop3.join(", ")}`);
}

// ── Summary ──
console.log(`\n${"=".repeat(70)}`);
console.log("SUMMARY");
console.log("=".repeat(70));
console.log(
	`  Old format: [norm_title]\\narticle_title\\n\\ntext (truncated 2000 chars)`,
);
console.log(
	`  New format: title: norm_title | text: article_title\\n\\ntext (truncated 24000 chars)`,
);
console.log(`  Old query:  raw question text`);
console.log(`  New query:  task: question answering | query: question text`);

db.close();
