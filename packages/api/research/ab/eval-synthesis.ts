/**
 * Phase 6 — synthesis A/B.
 *
 * For each query in the eval set:
 *  1. Run retrieval (NAN_STACK config) once → evidenceText + retrieved articles
 *  2. Send the same evidence to N synthesizer candidates:
 *      - gemini-2.5-flash-lite via OpenRouter (current prod baseline)
 *      - qwen3.6 via NaN
 *      - gemma4 via NaN
 *  3. Per candidate: capture answer, citations, latency, cost, tokens
 *  4. Auto-check citations: each `citations[].norm_id` must exist in the
 *     retrieved evidence pool. Compute citation precision per candidate.
 *  5. Judge with gemma4 NaN (cross-family from qwen3.6 to avoid self-eval bias):
 *     scores answer quality + completeness + style + citation accuracy 1-10
 *     each, with a free-text justification.
 *
 * Output:
 *  data/ab-results/phase6-synthesis-<date>.json — full results per query
 *  data/ab-results/phase6-synthesis-summary.md — aggregated comparison
 *
 * Usage:
 *   bun packages/api/research/ab/eval-synthesis.ts --limit 5    # smoke test
 *   bun packages/api/research/ab/eval-synthesis.ts              # full 50q
 *   bun packages/api/research/ab/eval-synthesis.ts \
 *     --eval packages/api/research/datasets/<new-eval>.json     # alt set
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

import { createSchema } from "../../../pipeline/src/db/schema.ts";
import { callNan } from "../../src/services/nan.ts";
import { callOpenRouter } from "../../src/services/openrouter.ts";
import { embedQuery } from "../../src/services/rag/embeddings.ts";
import { runRetrievalCore } from "../../src/services/rag/retrieval.ts";
import { synthesizeAnswer } from "../../src/services/rag/synthesis.ts";
import {
	_resetSharedVectorIndexForTests,
	getSharedVectorIndex,
} from "../../src/services/rag/vector-index-singleton.ts";

// buildEvidence is not exported — we recreate the minimal evidence formatting
// here (drop temporal-only enrichment for the eval; we want a stable input
// across candidates). Phase 6 isn't measuring evidence formatting.

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}
const limitArg = flag("limit");
const limit = limitArg ? Number(limitArg) : undefined;
const evalPath =
	flag("eval") ?? "packages/api/research/datasets/citizen-queries.json";
const skipJudge = args.includes("--no-judge");

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const outDir = join(repoRoot, "data", "ab-results");

const openrouterKey = process.env.OPENROUTER_API_KEY;
const nanKey = process.env.HERMES_API_KEY;
if (!openrouterKey) {
	console.error("OPENROUTER_API_KEY required (Gemini baseline candidate)");
	process.exit(1);
}
if (!nanKey) {
	console.error(
		"HERMES_API_KEY required (qwen3.6 + gemma4 + judge candidates)",
	);
	process.exit(1);
}

// Force NAN_STACK for retrieval so candidates compete on the same retrieved set.
process.env.NAN_STACK = "true";

// ── Load eval set ──

interface EvalQuery {
	id: number;
	question: string;
	expectedNorms?: string[];
	category?: string;
}
const evalData = (await Bun.file(join(repoRoot, evalPath)).json()) as {
	results: EvalQuery[];
};
let questions = evalData.results.filter(
	(r) => (r.expectedNorms?.length ?? 0) > 0,
);
if (limit) questions = questions.slice(0, limit);
console.log(`Eval set: ${questions.length} queries from ${evalPath}\n`);

// ── DB + retrieval setup ──

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
createSchema(db);

const embeddedNormIds = db
	.query<{ norm_id: string }, [string]>(
		"SELECT DISTINCT norm_id FROM embeddings WHERE model = ?",
	)
	.all("qwen3-nan")
	.map((r) => r.norm_id);
console.log(`Qwen-NAN haystack: ${embeddedNormIds.length} norms`);

_resetSharedVectorIndexForTests();
const vectorIndex = await getSharedVectorIndex(
	db,
	"qwen3-nan",
	join(repoRoot, "data"),
);
console.log(
	`Vector index: ${vectorIndex.vectors.totalVectors} vectors, ${vectorIndex.dims} dims\n`,
);

// ── Synthesizer candidates ──

interface Candidate {
	name: string;
	apiKey: string;
	model: string;
	llmFn?: typeof callOpenRouter;
}
const CANDIDATES: Candidate[] = [
	{
		name: "gemini-2.5-flash-lite (OpenRouter)",
		apiKey: openrouterKey!,
		model: "google/gemini-2.5-flash-lite",
		llmFn: callOpenRouter,
	},
	{
		name: "qwen3.6 (NaN)",
		apiKey: nanKey!,
		model: "qwen3.6",
		// biome-ignore lint/suspicious/noExplicitAny: callNan returns same shape
		llmFn: callNan as any,
	},
	{
		name: "gemma4 (NaN)",
		apiKey: nanKey!,
		model: "gemma4",
		// biome-ignore lint/suspicious/noExplicitAny: callNan returns same shape
		llmFn: callNan as any,
	},
];

// ── Evidence formatting (minimal — same across candidates) ──

interface RetrievedArticle {
	normId: string;
	blockId: string;
	normTitle: string;
	blockTitle: string;
	text: string;
	rank: string;
	sourceUrl: string;
}

function formatEvidence(articles: RetrievedArticle[]): string {
	const parts: string[] = [];
	for (let i = 0; i < articles.length; i++) {
		const a = articles[i]!;
		parts.push(
			`[${i + 1}] ${a.normId}, ${a.blockTitle}\n${a.normTitle}\n\n${a.text.trim()}\n`,
		);
	}
	return parts.join("\n---\n");
}

const SYSTEM_PROMPT = `Eres un asistente jurídico que responde a ciudadanos españoles. Te dan ARTÍCULOS DISPONIBLES (legislación vigente) y una PREGUNTA del ciudadano.

Tu tarea:
1. Lee los artículos
2. Responde la pregunta SOLO con información de los artículos proporcionados
3. Cita inline cada artículo en formato [BOE-A-XXXX-XXXX, Artículo N] (o el ID equivalente)
4. Si los artículos no responden la pregunta, marca declined=true y di amablemente que no encuentras información concreta
5. Lenguaje claro, registro ciudadano, sin jerga innecesaria

Formato JSON estricto:
- "answer": respuesta con citas inline
- "citations": array de {norm_id, article_title} de las normas citadas (deben aparecer en los ARTÍCULOS DISPONIBLES)
- "declined": true si no puedes responder por falta de información
- "tldr": resumen de 1 frase
- "next_questions": 0-3 preguntas relacionadas que podría hacer el ciudadano`;

// ── Main loop ──

interface CandidateResult {
	name: string;
	answer: string;
	tldr: string;
	citations: Array<{ normId: string; articleTitle: string }>;
	declined: boolean;
	citationPrecision: number; // % of citations that exist in retrieved evidence
	citationsCount: number;
	citationsValid: number;
	latencyMs: number;
	cost: number;
	tokensIn: number;
	tokensOut: number;
	error?: string;
}

interface QueryEvalResult {
	id: number;
	question: string;
	expectedNorms: string[];
	retrievedNormIds: string[];
	candidates: CandidateResult[];
	judgeScores?: Record<string, JudgeScore>;
}

interface JudgeScore {
	quality: number;
	completeness: number;
	style: number;
	citationAccuracy: number;
	overall: number;
	justification: string;
}

const results: QueryEvalResult[] = [];

for (let qi = 0; qi < questions.length; qi++) {
	const q = questions[qi]!;
	process.stdout.write(
		`\r[${qi + 1}/${questions.length}] q${q.id}: retrieval...   `,
	);

	// 1) Retrieval (single pass, shared across candidates)
	let retrieved: RetrievedArticle[] = [];
	try {
		const r = await runRetrievalCore({
			db,
			apiKey: openrouterKey!,
			cohereApiKey: null,
			question: q.question,
			embeddingModelKey: "qwen3-nan",
			embedQueryFn: embedQuery,
			lowConfidenceThreshold: 0,
			embeddedNormIds,
			vectorIndex: {
				meta: vectorIndex.meta,
				vectors: vectorIndex.vectors,
				dims: vectorIndex.dims,
			},
		});
		if (r.type === "ready") {
			retrieved = r.articles as RetrievedArticle[];
		}
	} catch (err) {
		console.warn(`\n  q${q.id} retrieval failed: ${err}`);
		continue;
	}

	if (retrieved.length === 0) {
		console.warn(`\n  q${q.id} no retrieval results, skipping`);
		continue;
	}

	const evidenceText = formatEvidence(retrieved);
	const retrievedNormIds = retrieved.map((a) => a.normId);
	const retrievedNormSet = new Set(retrievedNormIds);

	// 2) Synthesis per candidate
	const candidateResults: CandidateResult[] = [];
	for (const cand of CANDIDATES) {
		process.stdout.write(
			`\r[${qi + 1}/${questions.length}] q${q.id}: ${cand.name.split(" ")[0]}...   `,
		);
		const start = Date.now();
		try {
			const synth = await synthesizeAnswer({
				apiKey: cand.apiKey,
				question: q.question,
				evidenceText,
				systemPrompt: SYSTEM_PROMPT,
				model: cand.model,
				llmFn: cand.llmFn,
			});
			const valid = synth.citations.filter((c) =>
				retrievedNormSet.has(c.normId),
			).length;
			candidateResults.push({
				name: cand.name,
				answer: synth.answer,
				tldr: synth.tldr,
				citations: synth.citations,
				declined: synth.declined,
				citationPrecision:
					synth.citations.length > 0
						? (valid / synth.citations.length) * 100
						: 0,
				citationsCount: synth.citations.length,
				citationsValid: valid,
				latencyMs: Date.now() - start,
				cost: synth.cost,
				tokensIn: synth.tokensIn,
				tokensOut: synth.tokensOut,
			});
		} catch (err) {
			candidateResults.push({
				name: cand.name,
				answer: "",
				tldr: "",
				citations: [],
				declined: false,
				citationPrecision: 0,
				citationsCount: 0,
				citationsValid: 0,
				latencyMs: Date.now() - start,
				cost: 0,
				tokensIn: 0,
				tokensOut: 0,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	results.push({
		id: q.id,
		question: q.question,
		expectedNorms: q.expectedNorms ?? [],
		retrievedNormIds,
		candidates: candidateResults,
	});
}
console.log(
	`\n\nSynthesis pass complete: ${results.length} queries × ${CANDIDATES.length} candidates`,
);

// ── Judge phase ──

const JUDGE_SYSTEM = `Eres un juez experto en derecho español que evalúa respuestas de un asistente RAG legal.

Te doy:
- Una PREGUNTA de un ciudadano
- N respuestas-candidatas, cada una con su texto + citas

Evalúa CADA candidata según 4 ejes (escala 1-10):
1. "quality": precisión jurídica + corrección factual
2. "completeness": cubre los puntos principales de la pregunta
3. "style": claro, registro ciudadano, sin jerga innecesaria
4. "citationAccuracy": las citas son específicas y bien usadas (no genéricas)

Y un score general "overall" (1-10) que combina los anteriores.

Devuelve JSON con shape:
{
  "scores": {
    "<candidate-name>": {
      "quality": <1-10>,
      "completeness": <1-10>,
      "style": <1-10>,
      "citationAccuracy": <1-10>,
      "overall": <1-10>,
      "justification": "<2-3 frases>"
    }
  }
}`;

if (!skipJudge) {
	console.log("\nRunning judge (gemma4 NaN, cross-family)...");
	for (let i = 0; i < results.length; i++) {
		const r = results[i]!;
		process.stdout.write(
			`\r  Judge ${i + 1}/${results.length}: q${r.id}...   `,
		);
		const candidatesBlock = r.candidates
			.map((c, ci) => {
				const cites =
					c.citations.map((x) => x.normId).join(", ") || "(ninguna)";
				return `### Candidata ${ci + 1}: ${c.name}\nDeclined: ${c.declined}\nCitas: ${cites}\n\nRespuesta:\n${c.answer || "(error)"}`;
			})
			.join("\n\n---\n\n");

		try {
			const judgeResult = await callNan<{
				scores: Record<string, JudgeScore>;
			}>(nanKey!, {
				model: "gemma4",
				messages: [
					{ role: "system", content: JUDGE_SYSTEM },
					{
						role: "user",
						content: `PREGUNTA: ${r.question}\n\nCANDIDATAS:\n\n${candidatesBlock}\n\nDevuelve el JSON con scores para cada candidata por nombre.`,
					},
				],
				temperature: 0,
				maxTokens: 2500,
				jsonResponse: true,
			});
			r.judgeScores = judgeResult.data.scores;
		} catch (err) {
			console.warn(
				`\n  q${r.id} judge failed: ${err instanceof Error ? err.message : err}`,
			);
		}
	}
	console.log("\n");
}

// ── Save raw results ──

const today = new Date().toISOString().slice(0, 10);
const rawPath = join(outDir, `phase6-synthesis-${today}.json`);
await Bun.write(
	rawPath,
	JSON.stringify({ generated: today, results }, null, 2),
);
console.log(`Saved raw results → ${rawPath}\n`);

// ── Aggregate report ──

interface CandidateAgg {
	name: string;
	count: number;
	citationPrecisionAvg: number;
	citationsAvg: number;
	declinedRate: number;
	latencyMsAvg: number;
	costTotal: number;
	tokensInAvg: number;
	tokensOutAvg: number;
	errors: number;
	judge?: {
		quality: number;
		completeness: number;
		style: number;
		citationAccuracy: number;
		overall: number;
		count: number;
	};
}

const aggs = new Map<string, CandidateAgg>();
for (const cand of CANDIDATES) {
	aggs.set(cand.name, {
		name: cand.name,
		count: 0,
		citationPrecisionAvg: 0,
		citationsAvg: 0,
		declinedRate: 0,
		latencyMsAvg: 0,
		costTotal: 0,
		tokensInAvg: 0,
		tokensOutAvg: 0,
		errors: 0,
	});
}

for (const r of results) {
	for (const c of r.candidates) {
		const a = aggs.get(c.name)!;
		a.count++;
		if (c.error) {
			a.errors++;
			continue;
		}
		a.citationPrecisionAvg += c.citationPrecision;
		a.citationsAvg += c.citationsCount;
		a.declinedRate += c.declined ? 1 : 0;
		a.latencyMsAvg += c.latencyMs;
		a.costTotal += c.cost;
		a.tokensInAvg += c.tokensIn;
		a.tokensOutAvg += c.tokensOut;
	}
	if (r.judgeScores) {
		for (const [name, s] of Object.entries(r.judgeScores)) {
			// Match by case-insensitive substring (judge may shorten names)
			const a = [...aggs.values()].find(
				(x) =>
					x.name.toLowerCase().includes(name.toLowerCase()) ||
					name.toLowerCase().includes(x.name.toLowerCase().split(" ")[0]!),
			);
			if (!a) continue;
			if (!a.judge) {
				a.judge = {
					quality: 0,
					completeness: 0,
					style: 0,
					citationAccuracy: 0,
					overall: 0,
					count: 0,
				};
			}
			a.judge.quality += Number(s.quality ?? 0);
			a.judge.completeness += Number(s.completeness ?? 0);
			a.judge.style += Number(s.style ?? 0);
			a.judge.citationAccuracy += Number(s.citationAccuracy ?? 0);
			a.judge.overall += Number(s.overall ?? 0);
			a.judge.count++;
		}
	}
}

for (const a of aggs.values()) {
	const ok = Math.max(1, a.count - a.errors);
	a.citationPrecisionAvg /= ok;
	a.citationsAvg /= ok;
	a.declinedRate = (a.declinedRate / a.count) * 100;
	a.latencyMsAvg /= ok;
	a.tokensInAvg /= ok;
	a.tokensOutAvg /= ok;
	if (a.judge && a.judge.count > 0) {
		a.judge.quality /= a.judge.count;
		a.judge.completeness /= a.judge.count;
		a.judge.style /= a.judge.count;
		a.judge.citationAccuracy /= a.judge.count;
		a.judge.overall /= a.judge.count;
	}
}

// Print
console.log("=".repeat(96));
console.log("PHASE 6 SYNTHESIS — auto + judge metrics");
console.log("=".repeat(96));
console.log(
	`\n${"Candidate".padEnd(40)} ${"CitePrec".padStart(9)} ${"Cites".padStart(6)} ${"Decl".padStart(6)} ${"Lat".padStart(7)} ${"Cost".padStart(8)} ${"Errors".padStart(7)}`,
);
console.log("-".repeat(96));
for (const a of aggs.values()) {
	console.log(
		`${a.name.padEnd(40)} ${a.citationPrecisionAvg.toFixed(1).padStart(8)}% ${a.citationsAvg.toFixed(1).padStart(6)} ${a.declinedRate.toFixed(0).padStart(5)}% ${a.latencyMsAvg.toFixed(0).padStart(5)}ms $${a.costTotal.toFixed(4).padStart(7)} ${a.errors.toString().padStart(7)}`,
	);
}

if ([...aggs.values()].some((a) => a.judge)) {
	console.log("\nJudge (gemma4 NaN, scale 1-10):");
	console.log(
		`${"Candidate".padEnd(40)} ${"Quality".padStart(8)} ${"Complete".padStart(9)} ${"Style".padStart(7)} ${"Cites".padStart(7)} ${"Overall".padStart(9)}`,
	);
	console.log("-".repeat(96));
	for (const a of aggs.values()) {
		if (!a.judge) continue;
		console.log(
			`${a.name.padEnd(40)} ${a.judge.quality.toFixed(2).padStart(7)} ${a.judge.completeness.toFixed(2).padStart(8)} ${a.judge.style.toFixed(2).padStart(6)} ${a.judge.citationAccuracy.toFixed(2).padStart(6)} ${a.judge.overall.toFixed(2).padStart(8)}`,
		);
	}
}

// ── Markdown summary ──

const md: string[] = [];
md.push(`# Phase 6 — Synthesis A/B (NaN candidates vs Gemini baseline)`);
md.push("");
md.push(`Generated: ${new Date().toISOString()}`);
md.push(`Eval: \`${evalPath}\` (${results.length} queries with retrieval)`);
md.push("");
md.push(`## Auto metrics`);
md.push("");
md.push(
	`| Candidate | Cite precision | Avg cites/query | Declined | Latency | Cost | Errors |`,
);
md.push(`|---|---|---|---|---|---|---|`);
for (const a of aggs.values()) {
	md.push(
		`| ${a.name} | ${a.citationPrecisionAvg.toFixed(1)}% | ${a.citationsAvg.toFixed(1)} | ${a.declinedRate.toFixed(0)}% | ${a.latencyMsAvg.toFixed(0)} ms | $${a.costTotal.toFixed(4)} | ${a.errors} |`,
	);
}
if ([...aggs.values()].some((a) => a.judge)) {
	md.push("");
	md.push(`## Judge metrics (gemma4 NaN, scale 1-10)`);
	md.push("");
	md.push(
		`| Candidate | Quality | Completeness | Style | Citation accuracy | Overall |`,
	);
	md.push(`|---|---|---|---|---|---|`);
	for (const a of aggs.values()) {
		if (!a.judge) {
			md.push(`| ${a.name} | — | — | — | — | — |`);
			continue;
		}
		md.push(
			`| ${a.name} | ${a.judge.quality.toFixed(2)} | ${a.judge.completeness.toFixed(2)} | ${a.judge.style.toFixed(2)} | ${a.judge.citationAccuracy.toFixed(2)} | ${a.judge.overall.toFixed(2)} |`,
		);
	}
}

md.push("");
md.push(`## Notes`);
md.push("");
md.push(
	`- All candidates received the same retrieved evidence (NAN_STACK retrieval).`,
);
md.push(
	`- Cite precision = % of \`citations[].norm_id\` that exist in the retrieved pool.`,
);
md.push(
	`- Judge: gemma4 NaN, cross-family from qwen3.6 to avoid self-eval bias.`,
);
md.push(`- Per-query raw outputs in \`${rawPath}\`.`);

const mdPath = join(outDir, "phase6-synthesis-summary.md");
await Bun.write(mdPath, md.join("\n"));
console.log(`\nSaved markdown summary → ${mdPath}`);

db.close();
