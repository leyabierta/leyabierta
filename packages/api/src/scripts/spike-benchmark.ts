/**
 * RAG Benchmark — Compares multiple retrieval strategies
 *
 * Tests different retrieval configurations against the same questions
 * and produces a comparison report.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-benchmark.ts
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-benchmark.ts --strategy fts-only
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-benchmark.ts --question 13
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-benchmark.ts --strategy materia-v2 --question 15
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import { callOpenRouter } from "../services/openrouter.ts";
import { SPIKE_LAW_IDS } from "../services/rag/spike-laws.ts";
import {
	SPIKE_QUESTIONS,
	type SpikeQuestion,
} from "../services/rag/spike-questions.ts";

// ── Config ──

const MODEL = "google/gemini-2.5-flash-lite";
const TOP_K = 10;
const MAX_EVIDENCE_TOKENS = 6000;

const args = process.argv.slice(2);
const getArg = (name: string) => {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
};
const strategyFilter = getArg("strategy");
const questionFilter = getArg("question")
	? Number(getArg("question"))
	: undefined;

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
	console.error("Set OPENROUTER_API_KEY");
	process.exit(1);
}

// ── DB ──

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

const spikeFilter = SPIKE_LAW_IDS.map((id) => `'${id}'`).join(",");

// ── Shared helpers ──

const normalize = (s: string) =>
	s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

interface ArticleResult {
	normId: string;
	blockId: string;
	normTitle: string;
	blockTitle: string;
	text: string;
	sourceUrl: string;
}

interface RetrievalResult {
	articles: ArticleResult[];
	method: string;
}

function ftsSearch(query: string): string[] {
	const safeQuery = query
		.replace(/[¿?¡!"'()[\]{},.:;]/g, "")
		.split(/\s+/)
		.filter((t) => t.length > 2)
		.slice(0, 10)
		.map((t) => `"${t}"`)
		.join(" ");
	if (!safeQuery) return [];
	return db
		.query<{ norm_id: string }, [string]>(
			`SELECT DISTINCT norm_id FROM norms_fts
       WHERE norms_fts MATCH ?
         AND norm_id IN (${spikeFilter})
       ORDER BY bm25(norms_fts, 0, 10.0, 1.0, 15.0, 12.0)
       LIMIT 10`,
		)
		.all(safeQuery)
		.map((r) => r.norm_id);
}

function getArticlesFromNorms(
	normIds: string[],
	keywords: string[],
	limit: number = TOP_K,
): ArticleResult[] {
	if (normIds.length === 0) return [];
	const normFilter = normIds.map((id) => `'${id}'`).join(",");
	const allArticles = db
		.query<{
			norm_id: string;
			title: string;
			block_id: string;
			block_title: string;
			current_text: string;
			source_url: string;
		}>(
			`SELECT b.norm_id, n.title, b.block_id, b.title as block_title,
              b.current_text, n.source_url
       FROM blocks b
       JOIN norms n ON n.id = b.norm_id
       WHERE b.norm_id IN (${normFilter})
         AND b.block_type = 'precepto'
         AND b.current_text != ''`,
		)
		.all();

	const kwNorm = keywords.map((k) => normalize(k));
	const scored = allArticles.map((a) => {
		const textNorm = normalize(a.block_title + " " + a.current_text);
		const score = kwNorm.reduce(
			(sum, kw) => sum + (textNorm.includes(kw) ? 1 : 0),
			0,
		);
		return { ...a, score };
	});
	scored.sort((a, b) => b.score - a.score);

	const seen = new Set<string>();
	const results: ArticleResult[] = [];
	for (const a of scored.filter((s) => s.score > 0)) {
		const key = `${a.norm_id}:${a.block_id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		results.push({
			normId: a.norm_id,
			blockId: a.block_id,
			normTitle: a.title,
			blockTitle: a.block_title,
			text: a.current_text,
			sourceUrl: a.source_url,
		});
		if (results.length >= limit) break;
	}
	return results;
}

function extractKeywords(text: string): string[] {
	return text
		.replace(/[¿?¡!"'()[\]{},.:;]/g, "")
		.split(/\s+/)
		.filter((t) => t.length > 2);
}

// ── Query Analyzer (shared) ──

interface AnalyzedQuery {
	keywords: string[];
	materias: string[];
}

let analyzerCost = 0;
let synthCost = 0;
let totalTokensIn = 0;
let totalTokensOut = 0;
let llmCalls = 0;

async function analyzeQuery(question: string): Promise<AnalyzedQuery> {
	const result = await callOpenRouter<{
		keywords: string[];
		materias: string[];
	}>(apiKey!, {
		model: MODEL,
		messages: [
			{
				role: "system",
				content: `Eres un experto en legislación española. Dado una pregunta de un ciudadano, extrae:
1. "keywords": palabras clave para buscar en el texto legal (incluye sinónimos legales). Máximo 8.
2. "materias": categorías temáticas BOE relevantes. Usa nombres EXACTOS de materias del BOE (ej: "Consumidores y usuarios", "Arrendamientos urbanos", "Impuesto sobre la Renta de las Personas Físicas"). Máximo 3.

Responde SOLO con JSON.`,
			},
			{ role: "user", content: question },
		],
		temperature: 0.1,
		maxTokens: 200,
	});
	analyzerCost += result.cost;
	totalTokensIn += result.tokensIn;
	totalTokensOut += result.tokensOut;
	llmCalls++;
	return {
		keywords: result.data.keywords ?? [],
		materias: result.data.materias ?? [],
	};
}

// ── Synthesis (shared) ──

interface SynthResult {
	answer: string;
	citations: Array<{ normId: string; articleTitle: string }>;
	declined: boolean;
}

async function synthesize(
	question: string,
	evidence: ArticleResult[],
): Promise<SynthResult> {
	if (evidence.length === 0) {
		return { answer: "", citations: [], declined: true };
	}

	let evidenceText = "";
	let approxTokens = 0;
	for (const article of evidence) {
		const chunk = `[${article.normId}, ${article.blockTitle}]\n${article.text}\n\n`;
		const chunkTokens = Math.ceil(chunk.length / 4);
		if (approxTokens + chunkTokens > MAX_EVIDENCE_TOKENS) break;
		evidenceText += chunk;
		approxTokens += chunkTokens;
	}

	const result = await callOpenRouter<{
		answer: string;
		citations: Array<{ norm_id: string; article_title: string }>;
		declined: boolean;
	}>(apiKey!, {
		model: MODEL,
		messages: [
			{
				role: "system",
				content: `Eres un asistente legal informativo de Ley Abierta. Respondes preguntas de ciudadanos usando ÚNICAMENTE los artículos proporcionados.

REGLAS ESTRICTAS:
1. Responde SOLO usando la información de los artículos proporcionados.
2. Cita CADA afirmación con el norm_id y título del artículo EXACTO tal como aparecen en los artículos proporcionados.
3. Si los artículos NO contienen la respuesta, responde con declined=true.
4. Usa lenguaje llano que un no-abogado entienda.
5. NUNCA inventes información ni cites artículos que no estén en la lista proporcionada.
6. Si la pregunta no es sobre legislación, responde con declined=true.
7. Los norm_id tienen formato BOE-A-YYYY-NNNNN. Usa EXACTAMENTE los que aparecen en los artículos.

Responde con JSON: {"answer": "...", "citations": [{"norm_id": "...", "article_title": "..."}], "declined": false}`,
			},
			{
				role: "user",
				content: `ARTÍCULOS DISPONIBLES:\n\n${evidenceText}\n\nPREGUNTA: ${question}`,
			},
		],
		temperature: 0.2,
		maxTokens: 1500,
	});
	synthCost += result.cost;
	totalTokensIn += result.tokensIn;
	totalTokensOut += result.tokensOut;
	llmCalls++;

	return {
		answer: result.data.answer ?? "",
		citations: (result.data.citations ?? []).map((c) => ({
			normId: c.norm_id,
			articleTitle: c.article_title,
		})),
		declined: result.data.declined ?? false,
	};
}

// ── Citation verifier ──

function verifyCitations(
	citations: Array<{ normId: string; articleTitle: string }>,
	evidence: ArticleResult[],
): { valid: number; invalid: number; total: number } {
	const evidenceNorms = new Set(evidence.map((e) => e.normId));
	let valid = 0;
	let invalid = 0;
	for (const c of citations) {
		if (evidenceNorms.has(c.normId)) {
			valid++;
		} else {
			invalid++;
		}
	}
	return { valid, invalid, total: citations.length };
}

// ── Retrieval Strategies ──

type Strategy = {
	name: string;
	description: string;
	retrieve: (
		question: string,
		analyzed: AnalyzedQuery,
	) => ArticleResult[];
};

const strategies: Strategy[] = [
	{
		name: "fts-only",
		description: "FTS5 keyword search only (no LLM)",
		retrieve: (question) => {
			const normIds = ftsSearch(question);
			const keywords = extractKeywords(question);
			return getArticlesFromNorms(normIds, keywords);
		},
	},
	{
		name: "fts-llm",
		description: "FTS5 + LLM keyword expansion",
		retrieve: (question, analyzed) => {
			const normIds1 = ftsSearch(question);
			const normIds2 = analyzed.keywords.length > 0
				? ftsSearch(analyzed.keywords.join(" "))
				: [];
			const allNorms = [...new Set([...normIds1, ...normIds2])];
			const allKeywords = [
				...extractKeywords(question),
				...analyzed.keywords,
			];
			return getArticlesFromNorms(allNorms, allKeywords);
		},
	},
	{
		name: "fts-llm-materia",
		description: "FTS5 + LLM keywords + materia matching (word-level)",
		retrieve: (question, analyzed) => {
			// FTS5 retrieval
			const normIds1 = ftsSearch(question);
			const normIds2 = analyzed.keywords.length > 0
				? ftsSearch(analyzed.keywords.join(" "))
				: [];

			// Materia retrieval — match each word in each materia separately
			let materiaNorms: string[] = [];
			if (analyzed.materias.length > 0) {
				const materiaWords = analyzed.materias
					.flatMap((m) => m.split(/\s+/))
					.filter((w) => w.length > 3)
					.map((w) => w.toLowerCase());

				if (materiaWords.length > 0) {
					const conditions = materiaWords
						.map((w) => `lower(m.materia) LIKE '%${w.replace(/'/g, "''")}%'`)
						.join(" OR ");
					materiaNorms = db
						.query<{ norm_id: string }>(
							`SELECT DISTINCT m.norm_id FROM materias m
               WHERE (${conditions})
                 AND m.norm_id IN (${spikeFilter})
               LIMIT 10`,
						)
						.all()
						.map((r) => r.norm_id);
				}
			}

			const allNorms = [...new Set([...normIds1, ...normIds2, ...materiaNorms])];
			const allKeywords = [
				...extractKeywords(question),
				...analyzed.keywords,
			];
			return getArticlesFromNorms(allNorms, allKeywords);
		},
	},
	{
		name: "fts-llm-materia-tags",
		description: "FTS5 + LLM keywords + materia + citizen_tags semantic bridge",
		retrieve: (question, analyzed) => {
			// FTS5 retrieval
			const normIds1 = ftsSearch(question);
			const normIds2 = analyzed.keywords.length > 0
				? ftsSearch(analyzed.keywords.join(" "))
				: [];

			// Materia retrieval (word-level)
			let materiaNorms: string[] = [];
			if (analyzed.materias.length > 0) {
				const materiaWords = analyzed.materias
					.flatMap((m) => m.split(/\s+/))
					.filter((w) => w.length > 3)
					.map((w) => w.toLowerCase());
				if (materiaWords.length > 0) {
					const conditions = materiaWords
						.map((w) => `lower(m.materia) LIKE '%${w.replace(/'/g, "''")}%'`)
						.join(" OR ");
					materiaNorms = db
						.query<{ norm_id: string }>(
							`SELECT DISTINCT m.norm_id FROM materias m
               WHERE (${conditions})
                 AND m.norm_id IN (${spikeFilter})
               LIMIT 10`,
						)
						.all()
						.map((r) => r.norm_id);
				}
			}

			// Citizen tags semantic bridge — search tags for keyword matches
			const tagKeywords = [...extractKeywords(question), ...analyzed.keywords]
				.map((k) => normalize(k))
				.filter((k) => k.length > 3);

			let tagNorms: string[] = [];
			if (tagKeywords.length > 0) {
				const tagConditions = tagKeywords
					.slice(0, 5)
					.map((k) => `lower(ct.tag) LIKE '%${k.replace(/'/g, "''")}%'`)
					.join(" OR ");
				tagNorms = db
					.query<{ norm_id: string }>(
						`SELECT DISTINCT ct.norm_id FROM citizen_tags ct
           WHERE (${tagConditions})
             AND ct.norm_id IN (${spikeFilter})
           LIMIT 10`,
					)
					.all()
					.map((r) => r.norm_id);
			}

			const allNorms = [
				...new Set([...normIds1, ...normIds2, ...materiaNorms, ...tagNorms]),
			];
			const allKeywords = [
				...extractKeywords(question),
				...analyzed.keywords,
			];
			return getArticlesFromNorms(allNorms, allKeywords);
		},
	},
];

// ── Benchmark runner ──

interface BenchmarkResult {
	strategy: string;
	questionId: number;
	question: string;
	category: string;
	retrievedNorms: string[];
	articlesRetrieved: number;
	retrievalHit: boolean;
	answer: string;
	declined: boolean;
	citationsValid: number;
	citationsTotal: number;
	correctDecline: boolean;
	latencyMs: number;
}

async function runBenchmark(
	strategy: Strategy,
	q: SpikeQuestion,
	analyzed: AnalyzedQuery,
): Promise<BenchmarkResult> {
	const start = Date.now();

	const articles = strategy.retrieve(q.question, analyzed);
	const retrievedNorms = [...new Set(articles.map((a) => a.normId))];

	const synthesis = await synthesize(q.question, articles);
	const verification = verifyCitations(synthesis.citations, articles);

	const latencyMs = Date.now() - start;

	const retrievalHit =
		q.expectedNorms.length === 0 ||
		q.expectedNorms.some((n) => retrievedNorms.includes(n));

	const correctDecline =
		q.category === "out-of-scope" ? synthesis.declined : !synthesis.declined;

	return {
		strategy: strategy.name,
		questionId: q.id,
		question: q.question,
		category: q.category,
		retrievedNorms,
		articlesRetrieved: articles.length,
		retrievalHit,
		answer: synthesis.answer,
		declined: synthesis.declined,
		citationsValid: verification.valid,
		citationsTotal: verification.total,
		correctDecline,
		latencyMs,
	};
}

// ── Main ──

async function main() {
	const activeStrategies = strategyFilter
		? strategies.filter((s) => s.name === strategyFilter)
		: strategies;

	const questions = questionFilter
		? SPIKE_QUESTIONS.filter((q) => q.id === questionFilter)
		: SPIKE_QUESTIONS;

	if (activeStrategies.length === 0) {
		console.error(
			`Strategy '${strategyFilter}' not found. Available: ${strategies.map((s) => s.name).join(", ")}`,
		);
		process.exit(1);
	}

	console.log(`\n╔══════════════════════════════════════════════════════════╗`);
	console.log(`║  RAG Benchmark — ${activeStrategies.length} strategies × ${questions.length} questions`);
	console.log(`║  Model: ${MODEL}`);
	console.log(`║  Subset: ${SPIKE_LAW_IDS.length} laws`);
	console.log(`╚══════════════════════════════════════════════════════════╝\n`);

	// Pre-analyze all questions (shared across strategies)
	console.log("Analyzing all questions with LLM...\n");
	const analyzed = new Map<number, AnalyzedQuery>();
	for (const q of questions) {
		analyzed.set(q.id, await analyzeQuery(q.question));
		await new Promise((r) => setTimeout(r, 300));
	}

	const allResults: BenchmarkResult[] = [];

	for (const strategy of activeStrategies) {
		console.log(`\n━━ Strategy: ${strategy.name} ━━━━━━━━━━━━━━━━`);
		console.log(`   ${strategy.description}\n`);

		for (const q of questions) {
			process.stdout.write(`  Q${String(q.id).padStart(2)} [${q.category.padEnd(12)}] `);
			try {
				const result = await runBenchmark(strategy, q, analyzed.get(q.id)!);
				allResults.push(result);

				const status =
					q.category === "out-of-scope"
						? result.correctDecline
							? "✅ DECLINED"
							: "❌ SHOULD DECLINE"
						: result.declined
							? "❌ FALSE DECLINE"
							: result.retrievalHit
								? "✅ HIT"
								: "❌ MISS";

				console.log(
					`${status.padEnd(18)} articles: ${String(result.articlesRetrieved).padStart(2)} citations: ${result.citationsValid}/${result.citationsTotal} ${result.latencyMs}ms`,
				);
			} catch (err) {
				console.log(`⚠️  ERROR: ${err}`);
			}
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	// ── Comparison Report ──

	console.log(`\n╔══════════════════════════════════════════════════════════╗`);
	console.log(`║               BENCHMARK COMPARISON                       ║`);
	console.log(`╚══════════════════════════════════════════════════════════╝\n`);

	const legalQs = SPIKE_QUESTIONS.filter(
		(q) => q.category !== "out-of-scope",
	);
	const oosQs = SPIKE_QUESTIONS.filter((q) => q.category === "out-of-scope");

	console.log(
		`${"Strategy".padEnd(25)} ${"Retrieval".padStart(10)} ${"Citation".padStart(10)} ${"Decline".padStart(10)} ${"Avg Lat".padStart(10)}`,
	);
	console.log("─".repeat(70));

	for (const strategy of activeStrategies) {
		const sResults = allResults.filter((r) => r.strategy === strategy.name);
		const legalResults = sResults.filter(
			(r) => r.category !== "out-of-scope",
		);
		const oosResults = sResults.filter(
			(r) => r.category === "out-of-scope",
		);

		const retrievalRate =
			legalResults.filter((r) => r.retrievalHit).length / Math.max(legalResults.length, 1);

		const answeredResults = legalResults.filter((r) => !r.declined);
		const citationRate =
			answeredResults.length > 0
				? answeredResults.reduce(
						(sum, r) =>
							sum +
							(r.citationsTotal > 0
								? r.citationsValid / r.citationsTotal
								: 0),
						0,
					) / answeredResults.length
				: 0;

		const declineRate =
			oosResults.filter((r) => r.correctDecline).length /
			Math.max(oosResults.length, 1);

		const avgLatency =
			sResults.reduce((sum, r) => sum + r.latencyMs, 0) / sResults.length;

		console.log(
			`${strategy.name.padEnd(25)} ${(retrievalRate * 100).toFixed(0).padStart(9)}% ${(citationRate * 100).toFixed(0).padStart(9)}% ${(declineRate * 100).toFixed(0).padStart(9)}% ${avgLatency.toFixed(0).padStart(8)}ms`,
		);
	}

	console.log(`\n── Per-question comparison (legal questions only) ──\n`);
	console.log(
		`${"Q#".padEnd(4)} ${"Category".padEnd(13)} ${activeStrategies.map((s) => s.name.padEnd(22)).join(" ")}`,
	);
	console.log("─".repeat(4 + 13 + activeStrategies.length * 23));

	for (const q of questions.filter((q) => q.category !== "out-of-scope")) {
		const cells = activeStrategies.map((s) => {
			const r = allResults.find(
				(r) => r.strategy === s.name && r.questionId === q.id,
			);
			if (!r) return "—".padEnd(22);
			if (r.declined) return "❌ DECLINE".padEnd(22);
			if (!r.retrievalHit) return "❌ MISS".padEnd(22);
			return `✅ ${r.citationsValid}/${r.citationsTotal} cit`.padEnd(22);
		});
		console.log(
			`Q${String(q.id).padStart(2, " ")} ${q.category.padEnd(13)} ${cells.join(" ")}`,
		);
	}

	// Cost summary
	console.log(`\n── Cost Summary ──`);
	console.log(`  Analyzer cost:        $${analyzerCost.toFixed(6)}`);
	console.log(`  Synthesis cost:       $${synthCost.toFixed(6)}`);
	console.log(`  Total cost:           $${(analyzerCost + synthCost).toFixed(6)}`);
	console.log(`  Total tokens in:      ${totalTokensIn.toLocaleString()}`);
	console.log(`  Total tokens out:     ${totalTokensOut.toLocaleString()}`);
	console.log(`  LLM calls:            ${llmCalls}`);
	const queriesRun = activeStrategies.length * questions.length;
	const costPerQuery = (analyzerCost + synthCost) / queriesRun;
	console.log(`  Cost per query:       $${costPerQuery.toFixed(6)}`);
	console.log(`  Est. monthly (100q/d): $${(costPerQuery * 100 * 30).toFixed(2)}`);

	// Save results
	const outputPath = join(repoRoot, "data", "spike-benchmark-results.json");
	await Bun.write(outputPath, JSON.stringify(allResults, null, 2));
	console.log(`\n  Results saved to: ${outputPath}`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
