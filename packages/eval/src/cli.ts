/**
 * @leyabierta/eval CLI.
 *
 *   import                  Import 114 human seed questions to v3 schema
 *   generate --pilot        Run pilot of 20 questions (calibration)
 *   generate --target N     Run full pipeline targeting N accepted questions
 *   review-borderline       Human review of the borderline queue (TODO)
 *   split                   Emit train/val/test (disjoint by norm) (TODO)
 */

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	makeAdversarialJudge,
	makeAlternativeFinderAgent,
	makeAnswerabilityAgent,
	makeBalancedJudge,
	makeCitizenVoiceAgent,
	makeDedupAgent,
	makeDifficultyAgent,
	makeJudgePanel,
	makeLeakDetectorAgent,
	makePermissiveJudge,
	makePersonaAgent,
	makeQuestionGeneratorAgent,
} from "./agents/index.ts";
import { buildCorpusFrequencyTable } from "./agents/leak-corpus-frequency.ts";
import { heldoutNormIds } from "./heldout.ts";
import { runImport } from "./importers/index.ts";
import {
	flushEvalTraces,
	makeGemmaClient,
	makeQwenClient,
	startEvalTrace,
} from "./llm/index.ts";
import { runPipeline } from "./pipeline.ts";
import { makeProgressWriter, runWatch } from "./progress/index.ts";
import { buildReviewInput, summarizeReview } from "./review/index.ts";
import { StratifiedSampler } from "./sampling/index.ts";

function usage(): never {
	console.log(`@leyabierta/eval CLI

Usage: bun run packages/eval/src/cli.ts <command> [flags]

Commands:
  import                    Import 114 human seed questions to v3 schema
  generate --pilot          Run pilot of 20 questions (calibration)
  generate --target N       Run full pipeline targeting N accepted questions
  review-batch <accepted.jsonl> [--out <path>]
                            Build a structured Markdown review template for a subagent
  review-batch-summarize <reviewed.md> [--out <path>] [--accepted <path>]
                            Parse filled-in review and emit summary + KEEP/MARGINAL+DROP JSONLs
  review-borderline         Human review of the borderline queue
  split                     Emit train/val/test (disjoint by norm)
  watch [--file <path>]     Live dashboard for a running generate
                            (defaults to packages/eval/datasets/.progress.json)

Note: "generate" writes a progress file at
  packages/eval/datasets/.progress.json
so you can run "watch" in a separate terminal to monitor long runs.

Env: HERMES_API_KEY (required for generate). OPIK_API_KEY (optional).`);
	process.exit(1);
}

async function cmdGenerate(args: string[]) {
	const apiKey = process.env.HERMES_API_KEY;
	if (!apiKey) {
		console.error("HERMES_API_KEY required");
		process.exit(2);
	}

	const isPilot = args.includes("--pilot");
	const targetIdx = args.indexOf("--target");
	const explicitTarget =
		targetIdx >= 0 ? Number(args[targetIdx + 1]) : undefined;
	const target = explicitTarget ?? (isPilot ? 50 : 2000);
	const concurrency = isPilot ? 2 : 3;
	// Generous seed budgets: NaN is free, quality matters more than throughput.
	const maxSeeds = isPilot ? Math.max(target * 10, 200) : Math.ceil(target * 5);

	const outDir = isPilot
		? "packages/eval/datasets/pilot"
		: "packages/eval/datasets/v3";
	mkdirSync(outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const acceptedPath = `${outDir}/accepted-${stamp}.jsonl`;
	const borderlinePath = `${outDir}/borderline-${stamp}.jsonl`;
	const rejectedPath = `${outDir}/rejected-${stamp}.jsonl`;
	const statsPath = `${outDir}/stats-${stamp}.json`;
	const progressPath = `${outDir}/progress-${stamp}.json`;
	const latestProgressPath = "packages/eval/datasets/.progress.json";
	for (const p of [acceptedPath, borderlinePath, rejectedPath]) {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, "");
	}

	const progress = makeProgressWriter({
		target,
		maxSeeds,
		primaryPath: progressPath,
		latestPath: latestProgressPath,
	});

	const trace = startEvalTrace(
		"eval-dataset-gen",
		{ target, isPilot, concurrency, maxSeeds },
		["eval", "generation", isPilot ? "pilot" : "full"],
	);

	const qwen = makeQwenClient(apiKey, "eval-dataset-gen");
	const gemma = makeGemmaClient(apiKey, "eval-dataset-gen");

	const db = new Database("data/leyabierta.db", { readonly: true });
	const sampler = new StratifiedSampler({ dbPath: "data/leyabierta.db" });
	// Per-norm cap of 3 across the whole run — defends against single-norm
	// domination (e.g. the pilot 50's BOE-A-2010-13312 issue where one norm
	// produced 5/51 accepted Q&As). Pass-through ensures we don't rely on the
	// sampler default in case it ever changes.
	const SAMPLER_MAX_PER_NORM = 3;

	// Held-out normIds must NEVER be sampled.
	let heldout: Set<string>;
	try {
		heldout = heldoutNormIds();
		console.log(`[gen] held-out norms excluded: ${heldout.size}`);
	} catch {
		heldout = new Set();
	}

	const articleTextLookup = (norm: string, article: string) => {
		const row = db
			.prepare(
				"SELECT title, current_text FROM blocks WHERE norm_id = ? AND block_id = ?",
			)
			.get(norm, article) as
			| { title: string; current_text: string }
			| undefined;
		if (!row) return undefined;
		return { title: row.title, text: row.current_text };
	};

	const personas = makePersonaAgent(qwen, trace);
	const questionGenerator = makeQuestionGeneratorAgent([qwen, gemma], trace);
	const rareTermFrequency = buildCorpusFrequencyTable(db);
	console.log(`[gen] corpus frequency table: ${rareTermFrequency.size} tokens`);
	const leakDetector = makeLeakDetectorAgent(qwen, trace, {
		rareTermFrequency,
	});
	const answerability = makeAnswerabilityAgent(gemma, trace);
	const citizenVoice = makeCitizenVoiceAgent(gemma, trace);
	const alternatives = makeAlternativeFinderAgent({
		db,
		llm: qwen,
		trace,
		// Pilot used to skip alternatives; now that the SQL bug + softening fixes
		// landed, run the full multi-answer flow even in pilot — that's the
		// surface area we actually need to validate before scaling.
		maxCandidates: 8,
	});
	const judges = makeJudgePanel(
		[
			makePermissiveJudge(qwen, trace, articleTextLookup),
			makePermissiveJudge(gemma, trace, articleTextLookup),
			makeBalancedJudge(gemma, trace, articleTextLookup),
			makeAdversarialJudge(qwen, trace, articleTextLookup),
			makeAdversarialJudge(gemma, trace, articleTextLookup),
		],
		{
			rule:
				process.env.PANEL_RULE === "strict"
					? "strict-5-of-5"
					: "balanced-4-of-5",
		},
	);
	const difficulty = makeDifficultyAgent(qwen, trace, articleTextLookup);
	const dedup = makeDedupAgent();

	const result = await runPipeline(
		{
			sampler: {
				async sample(opts) {
					return sampler.sample({
						...opts,
						maxPerNorm: opts.maxPerNorm ?? SAMPLER_MAX_PER_NORM,
						excludeNormIds: heldout,
					});
				},
			},
			personas,
			questionGenerator,
			leakDetector,
			answerability,
			citizenVoice,
			alternatives,
			judges,
			difficulty,
			dedup,
		},
		{
			target,
			maxSeeds,
			personasPerSeed: isPilot ? 2 : 3,
			concurrency,
			onAccepted: (q) => {
				appendFileSync(acceptedPath, `${JSON.stringify(q)}\n`);
				console.log(
					`  ✓ ${q.id} ${q.voice} (${q.materia}) — ${q.question.slice(0, 80)}`,
				);
				progress.recordAccepted({
					id: q.id,
					voice: q.voice,
					materia: q.materia,
					jurisdiction: q.jurisdiction,
					question: q.question,
				});
			},
			onBorderline: (entry) => {
				appendFileSync(borderlinePath, `${JSON.stringify(entry)}\n`);
				console.log(
					`  ? ${entry.question.id} ${entry.votes.accept}-${entry.votes.reject} — ${entry.question.question.slice(0, 70)}`,
				);
				progress.recordBorderline({
					id: entry.question.id,
					acceptVotes: entry.votes.accept,
					rejectVotes: entry.votes.reject,
					question: entry.question.question,
				});
			},
			onRejected: (r) => {
				appendFileSync(
					rejectedPath,
					`${JSON.stringify({ seed: `${r.seed.normId}#${r.seed.articleId}`, reason: r.reason, draft: r.draft })}\n`,
				);
				progress.recordRejected(r.reason);
			},
		},
	);

	writeFileSync(statsPath, `${JSON.stringify(result.stats, null, 2)}\n`);
	progress.finalize(result.stats);
	trace.end({ stats: result.stats });
	await flushEvalTraces();
	db.close();

	console.log("\n[gen] DONE");
	console.log(JSON.stringify(result.stats, null, 2));
	console.log(`accepted: ${acceptedPath}`);
	console.log(`borderline: ${borderlinePath}`);
	console.log(`rejected: ${rejectedPath}`);
	console.log(`stats: ${statsPath}`);
	console.log(`progress: ${progressPath}`);
}

function flagValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function cmdReviewBatch(args: string[]) {
	const positional = args.filter((a) => !a.startsWith("--"));
	const inputPath = positional[0];
	if (!inputPath) {
		console.error(
			"review-batch: missing <accepted.jsonl> argument\n" +
				"usage: review-batch <accepted.jsonl> [--out <path>]",
		);
		process.exit(2);
	}
	const inputDir = dirname(inputPath);
	const outputPath =
		flagValue(args, "--out") ?? `${inputDir}/review-input-${timestamp()}.md`;
	mkdirSync(dirname(outputPath), { recursive: true });
	const { count } = buildReviewInput({ inputPath, outputPath });
	console.log(`[review-batch] wrote ${count} questions → ${outputPath}`);
}

function cmdReviewBatchSummarize(args: string[]) {
	const positional = args.filter((a) => !a.startsWith("--"));
	const reviewedMdPath = positional[0];
	if (!reviewedMdPath) {
		console.error(
			"review-batch-summarize: missing <reviewed.md> argument\n" +
				"usage: review-batch-summarize <reviewed.md> [--out <path>] [--accepted <path>]",
		);
		process.exit(2);
	}
	const inputDir = dirname(reviewedMdPath);
	const stamp = timestamp();
	const summaryOut =
		flagValue(args, "--out") ?? `${inputDir}/review-summary-${stamp}.md`;
	const keepJsonlOut = `${inputDir}/keep-${stamp}.jsonl`;
	const marginalDropJsonlOut = `${inputDir}/marginal-drop-${stamp}.jsonl`;
	mkdirSync(dirname(summaryOut), { recursive: true });
	const acceptedJsonlPath = flagValue(args, "--accepted");
	const result = summarizeReview({
		reviewedMdPath,
		acceptedJsonlPath,
		summaryOut,
		keepJsonlOut,
		marginalDropJsonlOut,
	});
	console.log(`[review-batch-summarize] summary  → ${summaryOut}`);
	console.log(
		`[review-batch-summarize] keep     → ${keepJsonlOut} (${result.kept} rows)`,
	);
	console.log(
		`[review-batch-summarize] borderl. → ${marginalDropJsonlOut} (${result.marginalDrop} rows)`,
	);
	if (result.warnings.length > 0) {
		console.log(`[review-batch-summarize] warnings: ${result.warnings.length}`);
	}
}

async function main() {
	const [, , cmd, ...rest] = process.argv;
	switch (cmd) {
		case "import":
			await runImport();
			break;
		case "generate":
			await cmdGenerate(rest);
			break;
		case "review-batch":
			cmdReviewBatch(rest);
			break;
		case "review-batch-summarize":
			cmdReviewBatchSummarize(rest);
			break;
		case "watch": {
			const file =
				flagValue(rest, "--file") ?? "packages/eval/datasets/.progress.json";
			await runWatch({ file });
			break;
		}
		case "review-borderline":
		case "split":
			console.error(`[${cmd}] not implemented yet`);
			process.exit(2);
			break;
		default:
			usage();
	}
}

await main();
