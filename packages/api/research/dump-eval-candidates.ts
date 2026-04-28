#!/usr/bin/env bun
/**
 * Dump retrieval candidates for every question in `eval-v2.json` so the
 * Python evaluation script (`packages/api/research/training/eval.py`)
 * doesn't have to re-implement retrieval.
 *
 * Two retrieval modes:
 *
 *   --mode realistic (default)
 *     Calls `runRetrievalCore` with `skipRerank: true` to get the same
 *     pre-reranker candidate pool the production pipeline produces:
 *     query analysis (LLM) + vector search + BM25 + RRF fusion + boosts.
 *     This is the realistic ceiling any reranker has to beat. Cost: ~$0.05
 *     for 272 questions (analyzer + embedder, no Cohere, no LLM rerank).
 *     Requires OPENROUTER_API_KEY in env.
 *
 *   --mode bm25
 *     Falls back to `bm25ArticleSearch` only — no LLM, no embedding, no
 *     network. Useful for quick iteration when you don't want to spend
 *     analyzer cost. R@10 floor is ~30% on this dataset (vs ~87% with
 *     full retrieval), so the reranker has very little to work with.
 *
 * Output is one JSONL row per in-scope eval question:
 *
 *   {"question_id": 7, "candidates": [{"norm_id": ..., "block_id": ...,
 *                                       "text": ..., "score": ...}, ...]}
 *
 * Usage
 * -----
 *
 *     bun run packages/api/research/dump-eval-candidates.ts \
 *         --eval data/eval-v2.json \
 *         --out  packages/api/research/training/eval-candidates.jsonl \
 *         --mode realistic --top-k 80
 */

import { Database } from "bun:sqlite";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { bm25ArticleSearch } from "../src/services/rag/blocks-fts.ts";
import {
	ensureVectorIndex,
	getEmbeddedNormIds,
} from "../src/services/rag/embeddings.ts";
import {
	EMBEDDING_MODEL_KEY,
	runRetrievalCore,
} from "../src/services/rag/retrieval.ts";

type EvalQuestion = {
	id: number;
	question: string;
	expectedNorms?: string[];
	register?: string;
	category?: string;
};

type EvalFile = {
	results: EvalQuestion[];
};

type Candidate = {
	norm_id: string;
	block_id: string;
	text: string;
	score: number;
};

type DumpArgs = {
	dbPath: string;
	evalPath: string;
	outPath: string;
	topK: number;
	mode: "realistic" | "bm25";
	limit: number | null;
};

function loadEval(path: string): EvalQuestion[] {
	const raw = JSON.parse(readFileSync(path, "utf8")) as
		| EvalFile
		| EvalQuestion[];
	const items = Array.isArray(raw) ? raw : raw.results;
	return items;
}

function fetchTexts(
	db: Database,
	keys: ReadonlyArray<{ normId: string; blockId: string }>,
): Map<string, string> {
	if (keys.length === 0) return new Map();
	// CTE with VALUES so we get exactly the rows we asked for, in any order.
	const placeholders = keys.map(() => "(?, ?)").join(",");
	const params: string[] = keys.flatMap((k) => [k.normId, k.blockId]);
	const sql = `
		WITH wanted(norm_id, block_id) AS (VALUES ${placeholders})
		SELECT b.norm_id, b.block_id, b.current_text
		FROM blocks b
		JOIN wanted w ON w.norm_id = b.norm_id AND w.block_id = b.block_id
	`;
	const rows = db.query(sql).all(...params) as Array<{
		norm_id: string;
		block_id: string;
		current_text: string;
	}>;
	const map = new Map<string, string>();
	for (const r of rows) map.set(`${r.norm_id}/${r.block_id}`, r.current_text);
	return map;
}

async function dumpBm25(args: DumpArgs): Promise<void> {
	let questions = loadEval(args.evalPath);
	if (args.limit !== null) questions = questions.slice(0, args.limit);
	const db = new Database(args.dbPath, { readonly: true });
	mkdirSync(dirname(args.outPath), { recursive: true });
	const lines: string[] = [];
	let withCandidates = 0;
	let totalCandidates = 0;
	let skipped = 0;

	try {
		for (const q of questions) {
			if ((q.expectedNorms ?? []).length === 0) {
				skipped += 1;
				continue;
			}
			const ranked = bm25ArticleSearch(db, q.question, args.topK);
			if (ranked.length === 0) {
				lines.push(JSON.stringify({ question_id: q.id, candidates: [] }));
				continue;
			}
			const texts = fetchTexts(
				db,
				ranked.map((r) => ({ normId: r.normId, blockId: r.blockId })),
			);
			const candidates: Candidate[] = ranked
				.map((r) => ({
					norm_id: r.normId,
					block_id: r.blockId,
					text: texts.get(`${r.normId}/${r.blockId}`) ?? "",
					score: 1 / r.rank,
				}))
				.filter((c) => c.text.length > 0);
			lines.push(JSON.stringify({ question_id: q.id, candidates }));
			withCandidates += 1;
			totalCandidates += candidates.length;
		}
	} finally {
		db.close();
	}

	writeFileSync(args.outPath, `${lines.join("\n")}\n`, "utf8");
	console.log(
		`[bm25] wrote ${lines.length} rows to ${args.outPath} (in-scope ${withCandidates}, skipped ${skipped}, avg ${withCandidates ? (totalCandidates / withCandidates).toFixed(1) : 0} cands)`,
	);
}

function loadAlreadyDoneIds(path: string): Set<number> {
	if (!existsSync(path)) return new Set();
	const done = new Set<number>();
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const row = JSON.parse(trimmed) as { question_id: number };
			if (typeof row.question_id === "number") done.add(row.question_id);
		} catch {
			// ignore corrupt last line (truncated by SIGKILL etc.)
		}
	}
	return done;
}

async function dumpRealistic(args: DumpArgs): Promise<void> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		throw new Error(
			"OPENROUTER_API_KEY is required for --mode realistic. Set it in your env or use --mode bm25.",
		);
	}

	let questions = loadEval(args.evalPath);
	if (args.limit !== null) questions = questions.slice(0, args.limit);

	// Resume mode: skip questions already in the output file. The runtime
	// (bun + vector-pool) sometimes crashes mid-run; appending each row as
	// it's produced means a crash loses one question at most, and re-running
	// picks up where we left off.
	mkdirSync(dirname(args.outPath), { recursive: true });
	const alreadyDone = loadAlreadyDoneIds(args.outPath);
	const remaining = questions.filter((q) => !alreadyDone.has(q.id));
	if (alreadyDone.size > 0) {
		console.log(
			`[realistic] resume mode: ${alreadyDone.size} done, ${remaining.length} remaining`,
		);
	}

	// Open RW so the FTS5 worker pool can attach properly. This worktree
	// is expected to have its own DB copy (sqlite3 .backup from the main
	// data dir) — never share a symlinked DB across worktrees, the WAL
	// races are unrecoverable.
	const db = new Database(args.dbPath);
	const dataDir = dirname(args.dbPath);

	console.log("[realistic] loading vector index…");
	const t0 = Date.now();
	const embeddedNormIds = getEmbeddedNormIds(db, EMBEDDING_MODEL_KEY);
	const vectorIndex = await ensureVectorIndex(db, EMBEDDING_MODEL_KEY, dataDir);
	console.log(
		`[realistic] vector index ready (${embeddedNormIds.length} norms, ${vectorIndex ? vectorIndex.meta.length : 0} chunks, ${Date.now() - t0}ms)`,
	);

	let withCandidates = 0;
	let skipped = 0;
	let earlyExit = 0;
	let progressed = 0;
	const startAll = Date.now();
	const appendRow = (row: object) => {
		appendFileSync(args.outPath, `${JSON.stringify(row)}\n`, "utf8");
	};

	try {
		for (const q of remaining) {
			if ((q.expectedNorms ?? []).length === 0) {
				skipped += 1;
				continue;
			}
			progressed += 1;
			const result = await runRetrievalCore({
				db,
				apiKey,
				cohereApiKey: null,
				question: q.question,
				embeddedNormIds,
				vectorIndex,
				skipRerank: true,
			});

			if (result.type !== "ready") {
				earlyExit += 1;
				appendRow({
					question_id: q.id,
					candidates: [],
					early_exit: result.reason,
				});
				continue;
			}

			const all = result.allFusedArticles.slice(0, args.topK);
			const candidates: Candidate[] = all
				.map((a, i) => ({
					norm_id: a.normId,
					block_id: a.blockId,
					text: a.text,
					score: 1 / (i + 1),
				}))
				.filter((c) => c.text.length > 0);
			appendRow({ question_id: q.id, candidates });
			withCandidates += 1;

			if (progressed % 25 === 0) {
				const elapsed = Date.now() - startAll;
				console.log(
					`[realistic] ${progressed}/${remaining.length}, ${(elapsed / progressed).toFixed(0)}ms/q avg`,
				);
			}
		}
	} finally {
		db.close();
	}

	console.log(
		`[realistic] this run: in-scope ${withCandidates}, skipped ${skipped}, early-exits ${earlyExit}. Total file ~${alreadyDone.size + withCandidates + earlyExit} rows`,
	);
}

function parseArgs(argv: readonly string[]): DumpArgs {
	const opts: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const eq = a.indexOf("=");
		if (eq > 0) {
			opts[a.slice(2, eq)] = a.slice(eq + 1);
		} else {
			opts[a.slice(2)] = argv[++i] ?? "";
		}
	}
	const mode = (opts.mode ?? "realistic") as "realistic" | "bm25";
	if (mode !== "realistic" && mode !== "bm25") {
		throw new Error(`unknown --mode: ${mode}`);
	}
	return {
		dbPath: resolve(opts.db ?? "data/leyabierta.db"),
		evalPath: resolve(opts.eval ?? "data/eval-v2.json"),
		outPath: resolve(
			opts.out ?? "packages/api/research/training/eval-candidates.jsonl",
		),
		topK: Number.parseInt(opts["top-k"] ?? "80", 10),
		mode,
		limit: opts.limit ? Number.parseInt(opts.limit, 10) : null,
	};
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === "bm25") {
		await dumpBm25(args);
	} else {
		await dumpRealistic(args);
	}
}
