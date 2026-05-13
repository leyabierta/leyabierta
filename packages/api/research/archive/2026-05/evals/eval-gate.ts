/**
 * Eval gate — post-rerank R@1 / R@5 / R@10 over the 65-question omnibus set.
 *
 * Used by Sprint 3 to assert the retrieval refactor is observably identical
 * to the pre-refactor production behaviour. Exercises the same `runRetrievalCore`
 * path that `RagPipeline.askStream` uses, stopping before synthesis to avoid
 * spending OpenRouter budget on Gemini-2.5-flash-lite for every question.
 *
 * Norm-level metric (the gold set only has `expectedNorms`, not block IDs):
 *   - Recall@K: did any chunk of the expected norm land in the top-K
 *     post-rerank `articles[]` of the pipeline?
 *
 * Cost: 65 × (1 analyzer call + 1 embedding call + 1 Cohere rerank) ≈ $0.10.
 *
 * Usage:
 *   bun packages/api/research/eval-gate.ts                      # write baseline
 *   bun packages/api/research/eval-gate.ts --compare BASE.json  # compare
 *   bun packages/api/research/eval-gate.ts --limit 10           # short-circuit
 *
 * Output: data/eval-gate-baseline.json (or --out PATH).
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { RagPipeline } from "../src/services/rag/pipeline.ts";

type EvalQuestion = {
	id: number;
	question: string;
	category: string;
	expectedNorms: string[];
};

type GateRow = {
	id: number;
	question: string;
	expectedNorms: string[];
	rankedNormIds: string[];
	hit1: boolean;
	hit5: boolean;
	hit10: boolean;
	declined: boolean;
	reason?: string;
	bestScore: number;
	latencyMs: number;
};

type GateOutput = {
	timestamp: string;
	branch: string;
	commit: string;
	totalQuestions: number;
	withExpected: number;
	aggregate: {
		recallAt1: number;
		recallAt5: number;
		recallAt10: number;
		declineRate: number;
		avgLatencyMs: number;
	};
	rows: GateRow[];
};

async function loadEnv(repoRoot: string): Promise<void> {
	const envFile = Bun.file(join(repoRoot, ".env"));
	if (!(await envFile.exists())) return;
	const text = await envFile.text();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

function parseArgs(argv: string[]) {
	let limit: number | undefined;
	let outPath: string | undefined;
	let comparePath: string | undefined;
	let evalFilePath: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--limit") {
			limit = Number(argv[++i]);
		} else if (a === "--out") {
			outPath = argv[++i];
		} else if (a === "--compare") {
			comparePath = argv[++i];
		} else if (a === "--eval-file") {
			evalFilePath = argv[++i];
		}
	}
	return { limit, outPath, comparePath, evalFilePath };
}

async function main() {
	const { limit, outPath, comparePath, evalFilePath } = parseArgs(
		process.argv.slice(2),
	);

	const repoRoot = join(import.meta.dir, "../../../");
	await loadEnv(repoRoot);

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		console.error("OPENROUTER_API_KEY not set");
		process.exit(1);
	}

	const dataDir = process.env.RAG_DATA_DIR ?? join(repoRoot, "data");
	const dbPath = process.env.DB_PATH ?? join(dataDir, "leyabierta.db");
	const evalPath =
		evalFilePath ?? join(dataDir, "eval-answers-504-omnibus.json");

	console.log(`db:   ${dbPath}`);
	console.log(`eval: ${evalPath}`);

	const evalRaw = JSON.parse(await Bun.file(evalPath).text()) as {
		results: EvalQuestion[];
	};
	const allQuestions = evalRaw.results.filter(
		(q) => q.expectedNorms.length > 0,
	);
	const questions = limit ? allQuestions.slice(0, limit) : allQuestions;

	console.log(
		`Running gate over ${questions.length} questions (of ${allQuestions.length} with expectedNorms)`,
	);

	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");

	const pipeline = new RagPipeline(db, apiKey, dataDir);

	let branch = process.env.EVAL_GATE_BRANCH ?? "unknown";
	let commit = process.env.EVAL_GATE_COMMIT ?? "unknown";
	try {
		branch = (
			await Bun.$`git -C ${repoRoot} rev-parse --abbrev-ref HEAD`.quiet().text()
		).trim();
		commit = (
			await Bun.$`git -C ${repoRoot} rev-parse --short HEAD`.quiet().text()
		).trim();
	} catch {
		// git not available (e.g. running inside container without .git access) —
		// fall back to EVAL_GATE_BRANCH / EVAL_GATE_COMMIT env vars.
	}

	const rows: GateRow[] = [];
	let hits1 = 0;
	let hits5 = 0;
	let hits10 = 0;
	let totalLatency = 0;
	let declines = 0;
	const startedAt = Date.now();

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const t0 = Date.now();
		try {
			const result = await pipeline._retrieveForEval({ question: q.question });
			const latencyMs = Date.now() - t0;
			totalLatency += latencyMs;
			if (result.declined) declines++;

			const rankedNormIds = result.articles.map((a) => a.normId);
			const top1 = new Set(rankedNormIds.slice(0, 1));
			const top5 = new Set(rankedNormIds.slice(0, 5));
			const top10 = new Set(rankedNormIds.slice(0, 10));
			const hit1 = q.expectedNorms.some((n) => top1.has(n));
			const hit5 = q.expectedNorms.some((n) => top5.has(n));
			const hit10 = q.expectedNorms.some((n) => top10.has(n));
			if (hit1) hits1++;
			if (hit5) hits5++;
			if (hit10) hits10++;

			rows.push({
				id: q.id,
				question: q.question,
				expectedNorms: q.expectedNorms,
				rankedNormIds,
				hit1,
				hit5,
				hit10,
				declined: result.declined,
				reason: result.reason,
				bestScore: result.bestScore,
				latencyMs,
			});

			process.stdout.write(
				`\r  [${i + 1}/${questions.length}] R@1=${((hits1 / (i + 1)) * 100).toFixed(0)}% R@5=${((hits5 / (i + 1)) * 100).toFixed(0)}% R@10=${((hits10 / (i + 1)) * 100).toFixed(0)}% (${latencyMs}ms)              `,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : "";
			console.error(
				`\nQ${q.id} failed: ${msg}\n${stack?.split("\n").slice(0, 4).join("\n") ?? ""}`,
			);
		}
	}
	process.stdout.write("\n");

	const n = rows.length;
	const aggregate = {
		recallAt1: hits1 / n,
		recallAt5: hits5 / n,
		recallAt10: hits10 / n,
		declineRate: declines / n,
		avgLatencyMs: totalLatency / n,
	};

	console.log(`\nElapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
	console.log(
		`R@1=${(aggregate.recallAt1 * 100).toFixed(1)}%  R@5=${(aggregate.recallAt5 * 100).toFixed(1)}%  R@10=${(aggregate.recallAt10 * 100).toFixed(1)}%  declines=${(aggregate.declineRate * 100).toFixed(1)}%  avg=${aggregate.avgLatencyMs.toFixed(0)}ms`,
	);

	const out: GateOutput = {
		timestamp: new Date().toISOString(),
		branch,
		commit,
		totalQuestions: questions.length,
		withExpected: questions.length,
		aggregate,
		rows,
	};
	const finalOut = outPath ?? join(dataDir, "eval-gate-baseline.json");
	await Bun.write(finalOut, JSON.stringify(out, null, 2));
	console.log(`Wrote ${finalOut}`);

	if (comparePath) {
		const baseline = JSON.parse(
			await Bun.file(comparePath).text(),
		) as GateOutput;
		console.log(`\nCompare against ${comparePath} (commit ${baseline.commit})`);
		console.log(
			`baseline R@1=${(baseline.aggregate.recallAt1 * 100).toFixed(1)}%  R@5=${(baseline.aggregate.recallAt5 * 100).toFixed(1)}%  R@10=${(baseline.aggregate.recallAt10 * 100).toFixed(1)}%`,
		);
		console.log(
			`current  R@1=${(aggregate.recallAt1 * 100).toFixed(1)}%  R@5=${(aggregate.recallAt5 * 100).toFixed(1)}%  R@10=${(aggregate.recallAt10 * 100).toFixed(1)}%`,
		);
		const r1Delta = aggregate.recallAt1 - baseline.aggregate.recallAt1;
		const r5Delta = aggregate.recallAt5 - baseline.aggregate.recallAt5;
		const r10Delta = aggregate.recallAt10 - baseline.aggregate.recallAt10;
		console.log(
			`delta    R@1=${(r1Delta * 100).toFixed(2)}pp  R@5=${(r5Delta * 100).toFixed(2)}pp  R@10=${(r10Delta * 100).toFixed(2)}pp`,
		);

		const baseRowsById = new Map(baseline.rows.map((r) => [r.id, r]));
		let movedIn = 0;
		let movedOut = 0;
		for (const row of rows) {
			const b = baseRowsById.get(row.id);
			if (!b) continue;
			if (row.hit10 && !b.hit10) movedIn++;
			if (!row.hit10 && b.hit10) movedOut++;
		}
		console.log(`per-q     +R@10=${movedIn}  -R@10=${movedOut}`);
	}

	db.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
