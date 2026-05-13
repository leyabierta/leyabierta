/**
 * Eval judge — two-layer evaluation for RAG quality.
 *
 * Layer 1: Retrieval quality (deterministic, no LLM)
 *   - norm_hit: expected norm appears in citations
 *   - citation_count, unique_norms, all_verified
 *
 * Layer 2: Answer quality (Claude Code as judge — NOT OpenRouter)
 *   - correctness (1-5): factual accuracy
 *   - completeness (1-5): covers key points from expected answer
 *   - faithfulness (1-5): every claim grounded in evidence/citations
 *   - clarity (1-5): understandable by a non-lawyer citizen
 *
 * Usage:
 *   # Step 1: Compute retrieval + generate review report
 *   bun run packages/api/research/eval-judge.ts --input data/eval-phase1-clean-data.json
 *
 *   # Step 2: Claude Code reads report and creates scores JSON
 *   # (manual, in conversation)
 *
 *   # Step 3: Aggregate final metrics
 *   bun run packages/api/research/eval-judge.ts --input data/eval-phase1-clean-data.json --scores data/eval-scores.json
 */

import { join } from "node:path";

const args = process.argv.slice(2);
const getArg = (name: string) => {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
};

const repoRoot = join(import.meta.dir, "../../../");
const inputPath =
	getArg("input") ?? join(repoRoot, "data", "eval-phase1-clean-data.json");
const scoresPath = getArg("scores");
const outputPath =
	getArg("output") ?? join(repoRoot, "data", "eval-judged.json");

interface EvalResult {
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
}

interface AnswerScores {
	correctness: number;
	completeness: number;
	faithfulness: number;
	clarity: number;
	notes?: string;
}

interface RetrievalMetrics {
	normHit: boolean;
	expectedNormsCited: string[];
	expectedNormsMissed: string[];
	citationCount: number;
	uniqueNorms: number;
	allVerified: boolean;
}

function computeRetrieval(r: EvalResult): RetrievalMetrics {
	const citedNorms = new Set(r.ragCitations.map((c) => c.normId));
	const expectedCited = r.expectedNorms.filter((n) => citedNorms.has(n));
	const expectedMissed = r.expectedNorms.filter((n) => !citedNorms.has(n));

	return {
		normHit: expectedCited.length > 0 || r.expectedNorms.length === 0,
		expectedNormsCited: expectedCited,
		expectedNormsMissed: expectedMissed,
		citationCount: r.ragCitations.length,
		uniqueNorms: citedNorms.size,
		allVerified: r.ragCitations.every((c) => c.verified),
	};
}

// ── Main ──

const raw = await Bun.file(inputPath).text();
const data = JSON.parse(raw) as { timestamp: string; results: EvalResult[] };
const results = data.results;

console.log(
	`\n📊 Eval Judge — ${results.length} questions from ${inputPath}\n`,
);

const retrievalResults = results.map((r) => ({
	...r,
	retrieval: computeRetrieval(r),
}));

const answered = retrievalResults.filter((r) => !r.ragDeclined);
const declined = retrievalResults.filter((r) => r.ragDeclined);
const withExpected = answered.filter((r) => r.expectedNorms.length > 0);
const normHits = withExpected.filter((r) => r.retrieval.normHit);

console.log("=== RETRIEVAL QUALITY (deterministic) ===\n");
console.log(`  Total: ${results.length} questions`);
console.log(`  Answered: ${answered.length} | Declined: ${declined.length}`);
console.log(
	`  Norm hits: ${normHits.length}/${withExpected.length} (${Math.round((100 * normHits.length) / withExpected.length)}%)`,
);
console.log(
	`  Avg citations: ${(answered.reduce((s, r) => s + r.retrieval.citationCount, 0) / answered.length).toFixed(1)}`,
);
console.log(
	`  Avg unique norms: ${(answered.reduce((s, r) => s + r.retrieval.uniqueNorms, 0) / answered.length).toFixed(1)}`,
);
console.log(
	`  Avg latency: ${Math.round(answered.reduce((s, r) => s + r.ragLatencyMs, 0) / answered.length)}ms`,
);

const misses = withExpected.filter((r) => !r.retrieval.normHit);
if (misses.length > 0) {
	console.log("\n  Misses:");
	for (const m of misses) {
		console.log(
			`    Q${m.id}: expected ${m.expectedNorms.join(",")} got ${[...new Set(m.ragCitations.map((c) => c.normId))].join(",") || "(none)"}`,
		);
	}
}

// Out-of-scope check
const oosQuestions = retrievalResults.filter(
	(r) => r.category === "out-of-scope",
);
const correctlyDeclined = oosQuestions.filter((r) => r.ragDeclined);
console.log(
	`\n  Out-of-scope: ${correctlyDeclined.length}/${oosQuestions.length} correctly declined`,
);
const wronglyAnswered = oosQuestions.filter((r) => !r.ragDeclined);
if (wronglyAnswered.length > 0) {
	console.log("  Wrongly answered:");
	for (const r of wronglyAnswered) {
		console.log(`    Q${r.id}: ${r.question.slice(0, 60)}`);
	}
}

// ── Scores aggregation mode ──

if (scoresPath) {
	const scoresRaw = await Bun.file(scoresPath).text();
	const scores = JSON.parse(scoresRaw) as Record<string, AnswerScores>;

	console.log("\n=== ANSWER QUALITY (Claude Code judge) ===\n");

	const scoredResults = retrievalResults.map((r) => ({
		...r,
		scores: scores[String(r.id)],
	}));

	const withScores = scoredResults.filter((r) => r.scores);
	const dims = [
		"correctness",
		"completeness",
		"faithfulness",
		"clarity",
	] as const;

	for (const dim of dims) {
		const vals = withScores.map((r) => r.scores![dim] ?? 0);
		const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
		const min = Math.min(...vals);
		console.log(
			`  ${dim.padEnd(14)} ${avg.toFixed(2)} avg  (min: ${min}, ≥4: ${vals.filter((v) => v >= 4).length}/${vals.length})`,
		);
	}

	const overallAvg =
		withScores.reduce((s, r) => {
			const sc = r.scores!;
			return (
				s +
				(sc.correctness + sc.completeness + sc.faithfulness + sc.clarity) / 4
			);
		}, 0) / withScores.length;
	console.log(`\n  Overall: ${overallAvg.toFixed(2)} / 5.00`);
	console.log(
		`  Scored: ${withScores.length}/${answered.length} answered questions`,
	);

	// Low scorers
	const lowScorers = withScores.filter((r) =>
		dims.some((d) => (r.scores![d] ?? 5) < 3),
	);
	if (lowScorers.length > 0) {
		console.log("\n  Low scorers (<3 on any dimension):");
		for (const r of lowScorers) {
			const s = r.scores!;
			const low = dims.filter((d) => (s[d] ?? 5) < 3);
			console.log(
				`    Q${r.id}: ${low.map((d) => `${d}=${s[d]}`).join(", ")}${s.notes ? ` — ${s.notes}` : ""}`,
			);
		}
	}

	// Save
	const output = {
		timestamp: new Date().toISOString(),
		inputFile: inputPath,
		scoresFile: scoresPath,
		summary: {
			total: results.length,
			answered: answered.length,
			declined: declined.length,
			normHitRate: `${normHits.length}/${withExpected.length}`,
			normHitPct: Math.round((100 * normHits.length) / withExpected.length),
			oosAccuracy: `${correctlyDeclined.length}/${oosQuestions.length}`,
			answerQuality: {
				scored: withScores.length,
				correctness: +(
					withScores.reduce((s, r) => s + (r.scores!.correctness ?? 0), 0) /
					withScores.length
				).toFixed(2),
				completeness: +(
					withScores.reduce((s, r) => s + (r.scores!.completeness ?? 0), 0) /
					withScores.length
				).toFixed(2),
				faithfulness: +(
					withScores.reduce((s, r) => s + (r.scores!.faithfulness ?? 0), 0) /
					withScores.length
				).toFixed(2),
				clarity: +(
					withScores.reduce((s, r) => s + (r.scores!.clarity ?? 0), 0) /
					withScores.length
				).toFixed(2),
				overall: +overallAvg.toFixed(2),
			},
			avgLatencyMs: Math.round(
				answered.reduce((s, r) => s + r.ragLatencyMs, 0) / answered.length,
			),
		},
		results: scoredResults.map((r) => ({
			id: r.id,
			question: r.question,
			category: r.category,
			retrieval: r.retrieval,
			scores: r.scores,
			declined: r.ragDeclined,
			latencyMs: r.ragLatencyMs,
		})),
	};

	await Bun.write(outputPath, JSON.stringify(output, null, 2));
	console.log(`\n  Saved to ${outputPath}`);
} else {
	// ── Review report mode ──
	console.log("\n=== REVIEW REPORT (for Claude Code to judge) ===\n");
	console.log("Score each answered question on 4 dimensions (1-5):");
	console.log(
		"  1=wrong/missing  2=mostly wrong  3=partially correct  4=good  5=excellent\n",
	);

	for (const r of answered) {
		console.log(
			`--- Q${r.id} [${r.category}] ${r.retrieval.normHit ? "���" : "❌"} ---`,
		);
		console.log(`Q: ${r.question}`);
		console.log(`Expected: ${r.expectedAnswer}`);
		console.log(
			`Answer: ${r.ragAnswer.slice(0, 500)}${r.ragAnswer.length > 500 ? "..." : ""}`,
		);
		console.log(
			`Norms: ${[...new Set(r.ragCitations.map((c) => c.normId))].join(", ") || "(none)"}`,
		);
		console.log();
	}

	console.log("Declined questions (should be out-of-scope):");
	for (const r of declined) {
		console.log(`  Q${r.id} [${r.category}]: ${r.question.slice(0, 80)}`);
	}

	console.log(
		`\nNext: Create data/eval-scores.json then re-run with --scores data/eval-scores.json`,
	);
}
