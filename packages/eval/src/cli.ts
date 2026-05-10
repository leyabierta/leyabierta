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
import { heldoutNormIds } from "./heldout.ts";
import { runImport } from "./importers/index.ts";
import {
	flushEvalTraces,
	makeGemmaClient,
	makeQwenClient,
	startEvalTrace,
} from "./llm/index.ts";
import { runPipeline } from "./pipeline.ts";
import { StratifiedSampler } from "./sampling/index.ts";

function usage(): never {
	console.log(`@leyabierta/eval CLI

Usage: bun run packages/eval/src/cli.ts <command> [flags]

Commands:
  import                    Import 114 human seed questions to v3 schema
  generate --pilot          Run pilot of 20 questions (calibration)
  generate --target N       Run full pipeline targeting N accepted questions
  review-borderline         Human review of the borderline queue
  split                     Emit train/val/test (disjoint by norm)

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
	const target = isPilot
		? 20
		: targetIdx >= 0
			? Number(args[targetIdx + 1])
			: 2000;
	const concurrency = isPilot ? 2 : 3;
	const maxSeeds = isPilot ? 80 : Math.ceil(target * 3); // expect ~33% accept

	const outDir = isPilot
		? "packages/eval/datasets/pilot"
		: "packages/eval/datasets/v3";
	mkdirSync(outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const acceptedPath = `${outDir}/accepted-${stamp}.jsonl`;
	const borderlinePath = `${outDir}/borderline-${stamp}.jsonl`;
	const rejectedPath = `${outDir}/rejected-${stamp}.jsonl`;
	const statsPath = `${outDir}/stats-${stamp}.json`;
	for (const p of [acceptedPath, borderlinePath, rejectedPath]) {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, "");
	}

	const trace = startEvalTrace(
		"eval-dataset-gen",
		{ target, isPilot, concurrency, maxSeeds },
		["eval", "generation", isPilot ? "pilot" : "full"],
	);

	const qwen = makeQwenClient(apiKey, "eval-dataset-gen");
	const gemma = makeGemmaClient(apiKey, "eval-dataset-gen");

	const db = new Database("data/leyabierta.db", { readonly: true });
	const sampler = new StratifiedSampler({ dbPath: "data/leyabierta.db" });

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
	const leakDetector = makeLeakDetectorAgent(qwen, trace);
	const answerability = makeAnswerabilityAgent(gemma, trace);
	const citizenVoice = makeCitizenVoiceAgent(gemma, trace);
	const alternatives = makeAlternativeFinderAgent({
		db,
		llm: qwen,
		trace,
		maxCandidates: isPilot ? 0 : 8, // pilot: skip alternatives for clean iteration
	});
	const judges = makeJudgePanel([
		makePermissiveJudge(qwen, trace, articleTextLookup),
		makeBalancedJudge(gemma, trace, articleTextLookup),
		makeAdversarialJudge(qwen, trace, articleTextLookup),
	]);
	const difficulty = makeDifficultyAgent(qwen, trace, articleTextLookup);
	const dedup = makeDedupAgent();

	const result = await runPipeline(
		{
			sampler: {
				async sample(opts) {
					return sampler.sample({
						...opts,
						excludeNormIds: heldout,
					} as Parameters<typeof sampler.sample>[0]);
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
			},
			onBorderline: (entry) => {
				appendFileSync(borderlinePath, `${JSON.stringify(entry)}\n`);
				console.log(
					`  ? ${entry.question.id} ${entry.votes.accept}-${entry.votes.reject} — ${entry.question.question.slice(0, 70)}`,
				);
			},
			onRejected: (r) => {
				appendFileSync(
					rejectedPath,
					`${JSON.stringify({ seed: `${r.seed.normId}#${r.seed.articleId}`, reason: r.reason, draft: r.draft })}\n`,
				);
			},
		},
	);

	writeFileSync(statsPath, `${JSON.stringify(result.stats, null, 2)}\n`);
	trace.end({ stats: result.stats });
	await flushEvalTraces();
	db.close();

	console.log("\n[gen] DONE");
	console.log(JSON.stringify(result.stats, null, 2));
	console.log(`accepted: ${acceptedPath}`);
	console.log(`borderline: ${borderlinePath}`);
	console.log(`rejected: ${rejectedPath}`);
	console.log(`stats: ${statsPath}`);
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
