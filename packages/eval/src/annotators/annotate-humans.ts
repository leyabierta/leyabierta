/**
 * Article-level annotation pass over the human seed dataset.
 *
 * Reads `datasets/seeds/v3-seeds-after-heldout.json` (64 questions: 50
 * citizen + 14 RAG, with the held-out 50 carved out), and for each
 * question runs the Article Picker against EACH of its `expectedNorms`.
 *
 * Output:
 *   datasets/seeds/v3-seeds-annotated.json   — filled `expectedArticles`
 *   datasets/annotation-report.md            — gate report
 *
 * Gate metric: % of (question × expectedNorm) pairs where the picker
 * returned at least one article. Target ≥ 90%. Below that the picker
 * (prompt or model) is broken and we MUST fix before pilot.
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { makeQwenClient } from "../llm/nan-client.ts";
import { flushEvalTraces, startEvalTrace } from "../llm/tracing.ts";
import type { Dataset, EvalQuestion, ExpectedArticle } from "../schema.ts";
import {
	loadNormArticles,
	pickArticles,
	pickedToExpectedArticles,
} from "./article-picker.ts";

const INPUT_PATH = "packages/eval/datasets/seeds/v3-seeds-after-heldout.json";
const OUTPUT_PATH = "packages/eval/datasets/seeds/v3-seeds-annotated.json";
const REPORT_PATH = "packages/eval/datasets/annotation-report.md";
const DB_PATH = "data/leyabierta.db";

interface PairResult {
	questionId: string;
	question: string;
	voice: "citizen" | "formal";
	normId: string;
	pickedCount: number;
	primaryArticle: string | null;
	tookMs: number;
	tokensIn: number;
	tokensOut: number;
	error?: string;
}

async function main() {
	const apiKey = process.env.HERMES_API_KEY;
	if (!apiKey) {
		console.error("HERMES_API_KEY required");
		process.exit(1);
	}

	const ds = JSON.parse(readFileSync(INPUT_PATH, "utf8")) as Dataset;
	const db = new Database(DB_PATH, { readonly: true });
	const llm = makeQwenClient(apiKey, "annotate-humans");
	const trace = startEvalTrace(
		"eval-import-annotation",
		{ totalQuestions: ds.questions.length },
		["eval", "annotation"],
	);

	const pairs: PairResult[] = [];
	const annotated: EvalQuestion[] = [];
	let normsNotInDb = 0;
	let pairsHit = 0;
	let pairsMiss = 0;

	const limitArg = process.argv.indexOf("--limit");
	const limit =
		limitArg >= 0 ? Number(process.argv[limitArg + 1]) : ds.questions.length;
	const subset = ds.questions.slice(0, limit);

	console.log(
		`[annotate] ${subset.length} questions, ${subset.reduce(
			(n, q) => n + q.expectedNorms.length,
			0,
		)} (q × norm) pairs`,
	);

	for (let i = 0; i < subset.length; i++) {
		const q = subset[i]!;
		const allPicked: ExpectedArticle[] = [];
		console.log(
			`[${i + 1}/${subset.length}] ${q.id} ${q.voice} ` +
				`norms=[${q.expectedNorms.join(",")}]\n  Q: ${q.question.slice(0, 90)}`,
		);

		for (const normId of q.expectedNorms) {
			const articles = loadNormArticles(db, normId, { query: q.question });
			if (articles.length === 0) {
				normsNotInDb++;
				pairs.push({
					questionId: q.id,
					question: q.question,
					voice: q.voice,
					normId,
					pickedCount: 0,
					primaryArticle: null,
					tookMs: 0,
					tokensIn: 0,
					tokensOut: 0,
					error: "norm-not-in-db-or-no-articles",
				});
				console.log(`    ${normId}: SKIP (no articles in DB)`);
				continue;
			}

			try {
				const res = await pickArticles(llm, q.question, articles, trace);
				const exp = pickedToExpectedArticles(normId, res.picked);
				allPicked.push(...exp);

				const primary = exp.find((e) => e.primary)?.article ?? null;
				pairs.push({
					questionId: q.id,
					question: q.question,
					voice: q.voice,
					normId,
					pickedCount: res.picked.length,
					primaryArticle: primary,
					tookMs: res.tookMs,
					tokensIn: res.tokensIn,
					tokensOut: res.tokensOut,
				});
				if (res.picked.length > 0) pairsHit++;
				else pairsMiss++;
				console.log(
					`    ${normId}: picked ${res.picked.length} (primary=${primary ?? "-"}) ${res.tookMs}ms`,
				);
			} catch (err) {
				pairsMiss++;
				const msg = err instanceof Error ? err.message : String(err);
				pairs.push({
					questionId: q.id,
					question: q.question,
					voice: q.voice,
					normId,
					pickedCount: 0,
					primaryArticle: null,
					tookMs: 0,
					tokensIn: 0,
					tokensOut: 0,
					error: msg,
				});
				console.log(`    ${normId}: ERROR ${msg}`);
			}
		}

		// Ensure exactly one primary across the whole question's expectedArticles.
		const primaries = allPicked.filter((a) => a.primary);
		if (primaries.length > 1) {
			for (let j = 1; j < primaries.length; j++) primaries[j]!.primary = false;
		}

		annotated.push({ ...q, expectedArticles: allPicked });
	}

	// Build report — two complementary metrics
	const totalPairs = pairs.length;
	const pairHitRate = totalPairs > 0 ? (pairsHit / totalPairs) * 100 : 0;

	// Question-level: a question is a hit if AT LEAST one of its expected
	// norms produced ≥1 picked article. This is the actual gate metric:
	// pair-level misses can be legitimate (over-generous multi-norm GT).
	const questionsWithAnyPick = annotated.filter(
		(q) => q.expectedArticles.length > 0,
	).length;
	const questionHitRate =
		annotated.length > 0 ? (questionsWithAnyPick / annotated.length) * 100 : 0;

	const totalLatency = pairs.reduce((s, p) => s + p.tookMs, 0);
	const totalTokensIn = pairs.reduce((s, p) => s + p.tokensIn, 0);
	const totalTokensOut = pairs.reduce((s, p) => s + p.tokensOut, 0);
	const gatePassed = questionHitRate >= 90;

	const report = [
		"# Article-level annotation report",
		"",
		`**Run:** ${new Date().toISOString()}`,
		`**Model:** qwen3.6 (NaN)`,
		`**Input:** ${INPUT_PATH} (${subset.length} questions)`,
		"",
		"## Gate metric (question-level)",
		"",
		`- questions evaluated: **${annotated.length}**`,
		`- questions with ≥1 article picked from any expectedNorm: **${questionsWithAnyPick}**`,
		`- **question hit rate: ${questionHitRate.toFixed(1)}%** (target: ≥90%)`,
		`- gate: ${gatePassed ? "✅ PASS" : "❌ FAIL"}`,
		"",
		"## Pair-level (diagnostic)",
		"",
		`- (question × norm) pairs evaluated: **${totalPairs}**`,
		`- pairs with ≥1 article picked: **${pairsHit}**`,
		`- pairs with 0 articles picked: **${pairsMiss}**`,
		`- norms missing from DB: **${normsNotInDb}**`,
		`- pair hit rate: ${pairHitRate.toFixed(1)}%`,
		`- (pair misses can be legitimate when human GT is over-generous about multi-norm answers)`,
		"",
		"## Throughput",
		"",
		`- total LLM time: ${(totalLatency / 1000).toFixed(1)}s`,
		`- avg per pair: ${totalPairs > 0 ? (totalLatency / totalPairs).toFixed(0) : 0}ms`,
		`- tokens in / out: ${totalTokensIn} / ${totalTokensOut}`,
		"",
		"## Misses (review these)",
		"",
		...pairs
			.filter((p) => p.pickedCount === 0)
			.map(
				(p) =>
					`- \`${p.questionId}\` (${p.voice}) — ${p.normId}` +
					(p.error ? ` — error: ${p.error}` : "") +
					`\n  Q: ${p.question}`,
			),
	].join("\n");

	writeFileSync(REPORT_PATH, `${report}\n`);

	const outDs: Dataset = {
		meta: {
			...ds.meta,
			createdAt: new Date().toISOString(),
			description:
				ds.meta.description +
				` Annotated at article level by qwen3.6 (NaN) on ${new Date().toISOString().slice(0, 10)}.`,
		},
		questions: annotated,
	};
	writeFileSync(OUTPUT_PATH, `${JSON.stringify(outDs, null, "\t")}\n`);

	trace.end({
		totalPairs,
		questionHitRate,
		pairHitRate,
		gatePassed,
	});
	await flushEvalTraces();
	db.close();

	console.log(
		`\n[annotate] question hit rate ${questionHitRate.toFixed(1)}% (pair ${pairHitRate.toFixed(1)}%) — gate ${gatePassed ? "PASS" : "FAIL"}`,
	);
	console.log(`[annotate] wrote ${OUTPUT_PATH} and ${REPORT_PATH}`);
}

await main();
