/**
 * Collect RAG answers for all eval questions — saves to JSON for external judging.
 *
 * Usage:
 *   bun run packages/api/research/eval-collect-answers.ts
 *   bun run packages/api/research/eval-collect-answers.ts --hard
 *   bun run packages/api/research/eval-collect-answers.ts --output data/eval-answers-top500.json
 */

import { join } from "node:path";
import { SPIKE_QUESTIONS, type SpikeQuestion } from "./spike-questions.ts";
import { HARD_QUESTIONS } from "./spike-questions-hard.ts";

const args = process.argv.slice(2);
const getArg = (name: string) => {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(`--${name}`);

const hardOnly = hasFlag("hard");
const apiBaseUrl = getArg("api-url") ?? "http://localhost:3000";
const apiBypassKey = process.env.API_BYPASS_KEY ?? "";
const repoRoot = join(import.meta.dir, "../../../");
const outputPath =
	getArg("output") ?? join(repoRoot, "data", "eval-answers.json");

interface RagResponse {
	answer?: string;
	declined?: boolean;
	citations?: { normId: string; articleTitle: string; verified?: boolean }[];
	meta?: { model?: string };
	latencyMs: number;
}

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

const allQuestions = [...SPIKE_QUESTIONS, ...HARD_QUESTIONS];
const questions: SpikeQuestion[] = hardOnly ? HARD_QUESTIONS : allQuestions;

console.log(`Collecting RAG answers for ${questions.length} questions...`);
console.log(`API: ${apiBaseUrl}\n`);

const results: Array<{
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
}> = [];

for (const q of questions) {
	process.stdout.write(
		`  Q${String(q.id).padStart(3)} [${q.category.padEnd(12)}] `,
	);

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

	// Brief pause between requests
	await new Promise((r) => setTimeout(r, 500));
}

// Save
await Bun.write(
	outputPath,
	JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
);
console.log(`\nSaved ${results.length} answers to ${outputPath}`);

// Quick stats
const avgLatency =
	results.reduce((s, r) => s + r.ragLatencyMs, 0) / results.length;
const declinedCount = results.filter((r) => r.ragDeclined).length;
console.log(`Avg latency: ${avgLatency.toFixed(0)}ms`);
console.log(`Declined: ${declinedCount}/${results.length}`);

// Norm hit rate — checks both citations array AND inline mentions in answer text.
// Also accepts equivalent norm IDs (e.g. old ET consolidation = new ET).
const EQUIVALENT_NORMS: Record<string, string> = {
	"BOE-A-1995-7730": "BOE-A-2015-11430", // ET 1995 consolidation = ET 2015
};
const NORM_ID_PATTERN = /(?:BOE|BOA|BOJA|DOGC|BOPV|BORM|DOCM|BON|BOC|DOGV)-[A-Za-z]-\d{4}-\d+/g;

function getAllMentionedNorms(r: (typeof results)[0]): Set<string> {
	const cited = new Set(r.ragCitations.map((c) => c.normId));
	// Also find norm IDs mentioned inline in the answer text
	for (const match of r.ragAnswer.matchAll(NORM_ID_PATTERN)) {
		cited.add(match[0]);
	}
	// Expand equivalences
	const expanded = new Set(cited);
	for (const n of cited) {
		if (EQUIVALENT_NORMS[n]) expanded.add(EQUIVALENT_NORMS[n]);
	}
	return expanded;
}

const withExpected = results.filter((r) => r.expectedNorms.length > 0);
const normHits = withExpected.filter((r) => {
	const mentioned = getAllMentionedNorms(r);
	return r.expectedNorms.some((n) => mentioned.has(n));
});
console.log(
	`Norm hits: ${normHits.length}/${withExpected.length} (${((normHits.length / withExpected.length) * 100).toFixed(0)}%)`,
);

// Show failures
const failures = withExpected.filter((r) => {
	const mentioned = getAllMentionedNorms(r);
	return !r.expectedNorms.some((n) => mentioned.has(n));
});
if (failures.length > 0) {
	console.log("\nFailing questions:");
	for (const f of failures) {
		const mentioned = [...getAllMentionedNorms(f)];
		console.log(
			`  Q${f.id}: expected ${f.expectedNorms.join(",")} got ${mentioned.join(",") || "(none)"}`,
		);
	}
}
