/**
 * Collect RAG responses for all eval questions.
 * Saves to data/eval-responses.json for manual or Claude-as-judge review.
 *
 * Usage:
 *   bun run packages/api/research/eval-collect.ts
 *   bun run packages/api/research/eval-collect.ts --question 3
 */

import { join } from "node:path";
import { SPIKE_QUESTIONS } from "./spike-questions.ts";
import { HARD_QUESTIONS } from "./spike-questions-hard.ts";

const args = process.argv.slice(2);
const questionFilter = args.includes("--question")
	? Number(args[args.indexOf("--question") + 1])
	: undefined;

const apiBaseUrl = "http://localhost:3000";
const apiBypassKey = process.env.API_BYPASS_KEY ?? "";

const allQuestions = [...SPIKE_QUESTIONS, ...HARD_QUESTIONS];
const questions = questionFilter
	? allQuestions.filter((q) => q.id === questionFilter)
	: allQuestions;

console.log(`Collecting ${questions.length} RAG responses...\n`);

interface CollectedResponse {
	id: number;
	question: string;
	category: string;
	expectedAnswer: string;
	answer: string;
	declined: boolean;
	citations: Array<{
		normId: string;
		normTitle: string;
		articleTitle: string;
		verified: boolean;
	}>;
	model: string;
	latencyMs: number;
	articlesRetrieved: number;
}

const results: CollectedResponse[] = [];
let errors = 0;

for (const q of questions) {
	process.stdout.write(
		`  Q${q.id} [${q.category}]: ${q.question.slice(0, 60)}...`,
	);

	try {
		const start = Date.now();
		const response = await fetch(`${apiBaseUrl}/v1/ask`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiBypassKey ? { "x-api-key": apiBypassKey } : {}),
			},
			body: JSON.stringify({ question: q.question }),
		});

		if (!response.ok) {
			const text = await response.text();
			console.log(` ERROR ${response.status}: ${text.slice(0, 100)}`);
			errors++;
			continue;
		}

		const data = (await response.json()) as {
			answer: string;
			declined: boolean;
			citations: Array<{
				normId: string;
				normTitle: string;
				articleTitle: string;
				verified: boolean;
			}>;
			meta: {
				model: string;
				latencyMs: number;
				articlesRetrieved: number;
			};
		};

		results.push({
			id: q.id,
			question: q.question,
			category: q.category,
			expectedAnswer: q.expectedAnswer,
			answer: data.answer,
			declined: data.declined,
			citations: data.citations ?? [],
			model: data.meta?.model ?? "unknown",
			latencyMs: data.meta?.latencyMs ?? Date.now() - start,
			articlesRetrieved: data.meta?.articlesRetrieved ?? 0,
		});

		const status = data.declined
			? "DECLINED"
			: `${data.citations?.length ?? 0} cites`;
		console.log(` ${status} (${data.meta?.latencyMs ?? 0}ms)`);

		// Small delay between requests
		await new Promise((r) => setTimeout(r, 500));
	} catch (err) {
		console.log(
			` FETCH ERROR: ${err instanceof Error ? err.message : "unknown"}`,
		);
		errors++;
	}
}

// Save results
const outputPath = join(import.meta.dir, "../../../data/eval-responses.json");
const output = {
	timestamp: new Date().toISOString(),
	model: results[0]?.model ?? "unknown",
	totalQuestions: questions.length,
	collected: results.length,
	errors,
	avgLatencyMs: Math.round(
		results.reduce((s, r) => s + r.latencyMs, 0) / results.length,
	),
	results,
};

await Bun.write(outputPath, JSON.stringify(output, null, 2));

console.log(`\n✓ Saved ${results.length} responses to ${outputPath}`);
console.log(`  Model: ${output.model}`);
console.log(`  Avg latency: ${output.avgLatencyMs}ms`);
console.log(`  Errors: ${errors}`);
