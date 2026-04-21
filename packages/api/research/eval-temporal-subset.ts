/**
 * Run RAG eval on the temporal-conflict subset only.
 *
 * These are the questions that were identified in RAG-EVAL-REPORT.md as
 * failing due to temporal accuracy issues (outdated modifying laws
 * displacing consolidated text).
 *
 * Usage:
 *   bun run packages/api/research/eval-temporal-subset.ts
 *   bun run packages/api/research/eval-temporal-subset.ts --api-url http://localhost:3000
 */

import { join } from "node:path";
import { SPIKE_QUESTIONS, type SpikeQuestion } from "./spike-questions.ts";
import { HARD_QUESTIONS } from "./spike-questions-hard.ts";

const args = process.argv.slice(2);
const getArg = (name: string) => {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
};

const apiBaseUrl = getArg("api-url") ?? "http://localhost:3000";
const apiBypassKey = process.env.API_BYPASS_KEY ?? "";
const repoRoot = join(import.meta.dir, "../../../");
const outputPath =
	getArg("output") ??
	join(repoRoot, "data", "eval-temporal-subset.json");

interface RagResponse {
	answer?: string;
	declined?: boolean;
	citations?: { normId: string; articleTitle: string; verified?: boolean }[];
	meta?: { model?: string };
	latencyMs: number;
}

// Temporal-conflict question IDs from RAG-EVAL-REPORT.md:
// Q1  — vacaciones: answers 22 días (civil servant) instead of 30 naturales (ET)
// Q2  — paternidad: answers 5 semanas (PGE 2018) instead of 19 semanas (ET)
// Q4  — fianza: buries answer under regional exceptions
// Q9  — alquiler duration: buries answer under regional norms
// Q12 — deducción alquiler: presents eliminated deduction as current
// Q22/Q501 — temporal: paternidad evolution (messy narrative)
// Q502 — temporal: alquiler contract law version
// Q608 — despido estando de baja: misses Ley 15/2022 protection
// Also include "clean" temporal questions as controls:
// Q3  — subida alquiler (excellent baseline answer)
// Q7  — despido improcedente (excellent baseline answer)
const TEMPORAL_SUBSET_IDS = new Set([1, 2, 3, 4, 7, 9, 12, 501, 502, 608]);

const allQuestions = [...SPIKE_QUESTIONS, ...HARD_QUESTIONS];
const questions = allQuestions.filter((q) => TEMPORAL_SUBSET_IDS.has(q.id));

const RETRY_DELAY_MS = 10_000;
const MAX_RETRIES = 3;

async function callRAG(question: string) {
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const start = Date.now();
		const response = await fetch(`${apiBaseUrl}/v1/ask`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiBypassKey ? { "x-api-key": apiBypassKey } : {}),
			},
			body: JSON.stringify({ question }),
		});

		if (response.status === 429 || response.status >= 500) {
			console.log(`    ${response.status} error, retrying in ${RETRY_DELAY_MS}ms...`);
			await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
			continue;
		}

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`);
		}

		const data = (await response.json()) as Record<string, unknown>;
		return { ...data, latencyMs: Date.now() - start } as RagResponse;
	}
	throw new Error("RAG API: max retries exceeded (429)");
}

// ── Main ──

console.log(
	`\n📊 Temporal Accuracy Subset — ${questions.length} questions\n`,
);
console.log(`API: ${apiBaseUrl}\n`);

type Result = {
	id: number;
	question: string;
	category: string;
	expectedAnswer: string;
	expectedNorms: string[];
	ragAnswer: string;
	ragDeclined: boolean;
	ragCitations: Array<{
		normId: string;
		articleTitle: string;
		verified: boolean;
	}>;
	ragLatencyMs: number;
	ragModel: string;
};

const results: Result[] = [];

for (const q of questions) {
	process.stdout.write(`  Q${String(q.id).padStart(3)} `);

	try {
		const rag = await callRAG(q.question);
		results.push({
			id: q.id,
			question: q.question,
			category: q.category,
			expectedAnswer: q.expectedAnswer,
			expectedNorms: q.expectedNorms,
			ragAnswer: rag.answer ?? "",
			ragDeclined: rag.declined ?? false,
			ragCitations: (rag.citations ?? []).map(
				(c: { normId: string; articleTitle: string; verified?: boolean }) => ({
					normId: c.normId,
					articleTitle: c.articleTitle,
					verified: c.verified ?? false,
				}),
			),
			ragLatencyMs: rag.latencyMs,
			ragModel: rag.meta?.model ?? "unknown",
		});

		const citCount = rag.citations?.length ?? 0;
		const declined = rag.declined ? " [DECLINED]" : "";
		console.log(`${rag.latencyMs}ms | ${citCount} citas${declined}`);
	} catch (err) {
		console.log(`ERROR: ${err}`);
	}

	await new Promise((r) => setTimeout(r, 500));
}

// Save
await Bun.write(
	outputPath,
	JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
);
console.log(`\nSaved ${results.length} answers to ${outputPath}`);

// Print answers for quick review
console.log("\n" + "=".repeat(80));
console.log("ANSWERS FOR REVIEW");
console.log("=".repeat(80));

for (const r of results) {
	console.log(`\n--- Q${r.id}: ${r.question} ---`);
	console.log(`Expected: ${r.expectedAnswer}`);
	console.log(`\nRAG answer (${r.ragLatencyMs}ms):`);
	console.log(r.ragAnswer.slice(0, 500));
	if (r.ragAnswer.length > 500) console.log("...[truncated]");
	const norms = r.ragCitations.map((c) => c.normId);
	console.log(`Citations: ${[...new Set(norms)].join(", ") || "(none)"}`);
	console.log();
}
