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

		if (response.status === 429) {
			console.log(`    429 rate limited, retrying in ${RETRY_DELAY_MS}ms...`);
			await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
			continue;
		}

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`);
		}

		const data = await response.json();
		return { ...data, latencyMs: Date.now() - start };
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

// Norm hit rate
const withExpected = results.filter((r) => r.expectedNorms.length > 0);
const normHits = withExpected.filter((r) => {
	const cited = new Set(r.ragCitations.map((c) => c.normId));
	return r.expectedNorms.some((n) => cited.has(n));
});
console.log(
	`Norm hits: ${normHits.length}/${withExpected.length} (${((normHits.length / withExpected.length) * 100).toFixed(0)}%)`,
);

// Show failures
const failures = withExpected.filter((r) => {
	const cited = new Set(r.ragCitations.map((c) => c.normId));
	return !r.expectedNorms.some((n) => cited.has(n));
});
if (failures.length > 0) {
	console.log("\nFailing questions:");
	for (const f of failures) {
		const cited = f.ragCitations.map((c) => c.normId);
		console.log(`  Q${f.id}: expected ${f.expectedNorms.join(",")} got ${cited.join(",") || "(none)"}`);
	}
}
