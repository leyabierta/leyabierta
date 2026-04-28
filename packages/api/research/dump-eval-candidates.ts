#!/usr/bin/env bun
/**
 * Dump retrieval candidates for every question in `eval-v2.json` so the
 * Python evaluation script (`packages/api/research/training/eval.py`)
 * doesn't have to re-implement retrieval.
 *
 * For each eval question, run the current BM25 article search, take the
 * top-K (default 80), pull each candidate's text from the DB, and emit
 * one JSONL row:
 *
 *   {"question_id": 7, "candidates": [{"norm_id": ..., "block_id": ...,
 *                                       "text": ..., "score": ...}, ...]}
 *
 * Why BM25-only and not the full hybrid pipeline:
 *   - Hybrid (vector + BM25 + RRF) requires running the embedding service
 *     and reading vectors.bin. Adds infra deps to a one-shot script.
 *   - For Fase 1c the comparison is pre-reranker vs post-reranker, so
 *     using a deterministic, cheap retrieval slice is fine. We can add a
 *     vector pass later if it becomes the bottleneck.
 *   - The existing eval baseline (R@10 = 87.6%) is dominated by retrieval
 *     hitting the right norm; the reranker's job is reordering inside K,
 *     and BM25 top-80 reliably covers that range.
 *
 * Usage
 * -----
 *
 *     bun run packages/api/research/dump-eval-candidates.ts \
 *         --eval data/eval-v2.json \
 *         --out  packages/api/research/training/eval-candidates.jsonl \
 *         --top-k 80
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bm25ArticleSearch } from "../src/services/rag/blocks-fts.ts";

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
	// Batch the lookup so we don't hit SQLite once per row. Use a CTE
	// with VALUES so we get back exactly the rows we asked for, in any
	// order, and we don't materialise the whole blocks table.
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

function dump(args: DumpArgs): void {
	const questions = loadEval(args.evalPath);
	const db = new Database(args.dbPath, { readonly: true });

	mkdirSync(dirname(args.outPath), { recursive: true });
	const lines: string[] = [];
	let withCandidates = 0;
	let totalCandidates = 0;
	let skipped = 0;

	try {
		for (const q of questions) {
			const expected = q.expectedNorms ?? [];
			if (expected.length === 0) {
				// Out-of-scope (adversarial probes etc.) — eval.py skips them too.
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
				.map((r) => {
					const text = texts.get(`${r.normId}/${r.blockId}`) ?? "";
					return {
						norm_id: r.normId,
						block_id: r.blockId,
						text,
						score: 1 / r.rank, // 1-based rank → similarity-like score
					};
				})
				// Drop empties (would just confuse the reranker).
				.filter((c) => c.text.length > 0);
			lines.push(JSON.stringify({ question_id: q.id, candidates }));
			withCandidates += 1;
			totalCandidates += candidates.length;
		}
	} finally {
		db.close();
	}

	writeFileSync(args.outPath, `${lines.join("\n")}\n`, "utf8");
	console.log(`Wrote ${lines.length} rows to ${args.outPath}`);
	console.log(
		`  in-scope questions: ${withCandidates}, skipped (out-of-scope): ${skipped}`,
	);
	if (withCandidates > 0) {
		console.log(
			`  avg candidates per question: ${(totalCandidates / withCandidates).toFixed(1)}`,
		);
	}
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
	return {
		dbPath: resolve(opts.db ?? "data/leyabierta.db"),
		evalPath: resolve(opts.eval ?? "data/eval-v2.json"),
		outPath: resolve(
			opts.out ?? "packages/api/research/training/eval-candidates.jsonl",
		),
		topK: Number.parseInt(opts["top-k"] ?? "80", 10),
	};
}

if (import.meta.main) {
	dump(parseArgs(process.argv.slice(2)));
}
