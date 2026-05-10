/**
 * Calibrate `LOW_CONFIDENCE_THRESHOLD` for the Qwen-NAN stack.
 *
 * Uses the saved pass files to plot, for each candidate threshold:
 *   - coverage: % of queries above threshold (answered)
 *   - precision@1 above: hit@1 rate among answered
 *   - precision@5 above: hit@5 rate among answered
 *   - precision@1 below: hit@1 rate among abandoned (these are the
 *                       "false abandonments" if we set the threshold too high)
 *
 * Recommended threshold: highest value that keeps coverage >= 95% AND
 * precision@1 above >= baseline R@1. Above that point we'd be abandoning
 * correct answers without justification.
 *
 * Usage:
 *   bun packages/api/research/ab/calibrate-threshold.ts --pass eval-pass-qwen-no-instruct-nan-analyzer-nan-rerank.json
 */

import { join } from "node:path";

interface QueryResult {
	id: number;
	question: string;
	hitsAt1: boolean;
	hitsAt5: boolean;
	hitsAt10: boolean;
	topNormIds: string[];
	score: number;
}
interface PassFile {
	dims: number;
	total: number;
	results: QueryResult[];
}

const args = process.argv.slice(2);
const passArg = args.indexOf("--pass");
const passFile =
	passArg >= 0
		? args[passArg + 1]!
		: "eval-pass-qwen-no-instruct-nan-analyzer-nan-rerank.json";

const repoRoot = join(import.meta.dir, "../../../../");
const path = join(repoRoot, "data/ab-results", passFile);
const data = (await Bun.file(path).json()) as PassFile;
const results = data.results;
console.log(`Calibrating from: ${passFile} (${results.length} queries)\n`);

// Score distribution
const scores = results.map((r) => r.score).sort((a, b) => a - b);
const min = scores[0]!;
const max = scores[scores.length - 1]!;
const median = scores[Math.floor(scores.length / 2)]!;
console.log(`Score distribution: min=${min.toFixed(3)} median=${median.toFixed(3)} max=${max.toFixed(3)}`);

const hitScores = results.filter((r) => r.hitsAt1).map((r) => r.score);
const missScores = results.filter((r) => !r.hitsAt1).map((r) => r.score);
const avgHit = hitScores.reduce((a, b) => a + b, 0) / Math.max(1, hitScores.length);
const avgMiss = missScores.reduce((a, b) => a + b, 0) / Math.max(1, missScores.length);
console.log(`  Among hit@1 queries (n=${hitScores.length}): avg score = ${avgHit.toFixed(3)}`);
console.log(`  Among miss@1 queries (n=${missScores.length}): avg score = ${avgMiss.toFixed(3)}`);
console.log(
	`  Hit-miss separation: ${(avgHit - avgMiss).toFixed(3)} (positive = score is informative)\n`,
);

// Sweep
const thresholds = [
	0.0, 0.30, 0.35, 0.40, 0.42, 0.44, 0.46, 0.48, 0.50, 0.52, 0.54, 0.55, 0.56, 0.58, 0.60, 0.62, 0.65, 0.70, 0.75, 0.80,
];
console.log(
	`Threshold | Coverage | Hit@1 above | Hit@5 above | Hit@1 below (abandoned-but-correct)`,
);
console.log("-".repeat(95));
for (const t of thresholds) {
	const above = results.filter((r) => r.score >= t);
	const below = results.filter((r) => r.score < t);
	const cov = (above.length / results.length) * 100;
	const hitAbove1 = above.filter((r) => r.hitsAt1).length;
	const hitAbove5 = above.filter((r) => r.hitsAt5).length;
	const hitBelow1 = below.filter((r) => r.hitsAt1).length;
	const p1Above = above.length > 0 ? (hitAbove1 / above.length) * 100 : 0;
	const p5Above = above.length > 0 ? (hitAbove5 / above.length) * 100 : 0;
	const p1Below = below.length > 0 ? (hitBelow1 / below.length) * 100 : 0;
	console.log(
		`  ${t.toFixed(2).padStart(5)} | ${cov.toFixed(0).padStart(4)}% (${above.length.toString().padStart(2)}/${results.length}) | ${p1Above.toFixed(1).padStart(6)}% (${hitAbove1}/${above.length}) | ${p5Above.toFixed(1).padStart(6)}% | ${p1Below.toFixed(1).padStart(6)}% (${hitBelow1}/${below.length}) ← false-abandon`,
	);
}

// Recommendation: highest t s.t. hit@1 below = 0 (no false abandonment)
let bestT = 0;
for (const t of thresholds) {
	const below = results.filter((r) => r.score < t);
	const hitBelow = below.filter((r) => r.hitsAt1).length;
	if (hitBelow === 0) bestT = t;
}
console.log(
	`\nRecommended threshold: ${bestT.toFixed(2)} (highest with zero false-abandonment of hit@1 queries)`,
);

const aboveBest = results.filter((r) => r.score >= bestT);
console.log(
	`  Coverage at ${bestT.toFixed(2)}: ${aboveBest.length}/${results.length} = ${((aboveBest.length / results.length) * 100).toFixed(1)}%`,
);
console.log(
	`  Hit@1 above: ${((aboveBest.filter((r) => r.hitsAt1).length / aboveBest.length) * 100).toFixed(1)}%`,
);
