#!/usr/bin/env bun
/**
 * Hard-negative mining round (Exp 1).
 *
 * Strategy:
 *   1. For each query in reranker-v3v5.jsonl:
 *      - Run BM25 top-100 to get candidates
 *      - Collect all (pair_id, query, text) scoring tasks
 *   2. Call Python sidecar ONCE with all tasks — score with trained bge-base-mnr-v3
 *   3. For each pair: pick the 3 top-scoring non-gold candidates as new hard negatives
 *      + 1 materia-sibling for diversity
 *   4. Write reranker-v3v5-mined.jsonl
 *
 * Usage:
 *   bun run packages/api/research/mine-hard-negatives.ts \
 *     --in packages/api/research/datasets/reranker-v3v5.jsonl \
 *     --out packages/api/research/datasets/reranker-v3v5-mined.jsonl \
 *     --adapter packages/api/research/training/adapters/bge-base-mnr-v3 \
 *     --db data/leyabierta.db \
 *     --bm25-top-k 100 \
 *     --hard-neg-count 3
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bm25ArticleSearch } from "../src/services/rag/blocks-fts.ts";

type Pair = {
	id: string;
	query: string;
	register: string;
	is_trap: boolean;
	positive: {
		norm_id: string;
		block_id: string;
		block_type: string;
		title: string;
		text: string;
		rank: string;
		jurisdiction: string;
		published_at: string;
	};
	hard_negatives: Array<{
		norm_id: string;
		block_id: string;
		text: string;
		source: string;
	}>;
	meta: {
		generation: string;
		generator_pass: string;
		created_at: string;
	};
};

function getBlockText(
	db: Database,
	normId: string,
	blockId: string,
): string | null {
	const row = db
		.query(
			"SELECT current_text FROM blocks WHERE norm_id = ? AND block_id = ?",
		)
		.get(normId, blockId) as { current_text: string } | null;
	return row?.current_text ?? null;
}

function fetchMateriaSiblingPool(
	db: Database,
	goldNormId: string,
	limit = 20,
): { norm_id: string; block_id: string; text: string }[] {
	const sql = `
		WITH shared AS (
			SELECT DISTINCT m2.norm_id AS norm_id
			FROM materias m1
			JOIN materias m2 ON m1.materia = m2.materia
			WHERE m1.norm_id = ? AND m2.norm_id != ?
		)
		SELECT b.norm_id, b.block_id, b.current_text AS text
		FROM blocks b
		JOIN shared s ON s.norm_id = b.norm_id
		JOIN norms n ON n.id = b.norm_id
		WHERE b.block_type = 'precepto'
			AND length(b.current_text) >= 80
			AND b.block_id NOT LIKE 'dd%'
			AND n.status = 'vigente'
		ORDER BY RANDOM()
		LIMIT ?
	`;
	return db.query(sql).all(goldNormId, goldNormId, limit) as Array<{
		norm_id: string;
		block_id: string;
		text: string;
	}>;
}

type ScoringTask = {
	pair_id: string;
	pair_idx: number;
	cand_idx: number;
	query: string;
	text: string;
	norm_id: string;
	block_id: string;
};

type ParsedArgs = {
	inPath: string;
	outPath: string;
	adapterPath: string;
	dbPath: string;
	bm25TopK: number;
	hardNegCount: number;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
	const opts: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const eq = a.indexOf("=");
		if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
		else opts[a.slice(2)] = argv[++i] ?? "";
	}
	return {
		inPath: resolve(
			opts.in ?? "packages/api/research/datasets/reranker-v3v5.jsonl",
		),
		outPath: resolve(
			opts.out ?? "packages/api/research/datasets/reranker-v3v5-mined.jsonl",
		),
		adapterPath: resolve(
			opts.adapter ??
				"packages/api/research/training/adapters/bge-base-mnr-v3",
		),
		dbPath: resolve(opts.db ?? "data/leyabierta.db"),
		bm25TopK: Number.parseInt(opts["bm25-top-k"] ?? "100", 10),
		hardNegCount: Number.parseInt(opts["hard-neg-count"] ?? "3", 10),
	};
}

// The Python script that scores all tasks in one pass
const SCORER_PY = `
import json, sys
from sentence_transformers import CrossEncoder

adapter = sys.argv[1]
inp = sys.argv[2]
out = sys.argv[3]

print(f"[scorer.py] loading adapter: {adapter}", flush=True)
model = CrossEncoder(adapter, num_labels=1, max_length=256)
print("[scorer.py] adapter loaded", flush=True)

tasks = []
with open(inp) as f:
    for line in f:
        line = line.strip()
        if line:
            tasks.append(json.loads(line))

print(f"[scorer.py] scoring {len(tasks)} pairs", flush=True)
if not tasks:
    open(out, 'w').close()
    sys.exit(0)

pairs = [[t['query'], t['text']] for t in tasks]
scores = model.predict(pairs, batch_size=32, show_progress_bar=True)

with open(out, 'w') as f:
    for t, s in zip(tasks, scores):
        f.write(json.dumps({
            'pair_id': t['pair_id'],
            'pair_idx': t['pair_idx'],
            'cand_idx': t['cand_idx'],
            'norm_id': t['norm_id'],
            'block_id': t['block_id'],
            'score': float(s)
        }) + '\\n')
print(f"[scorer.py] wrote {len(tasks)} scores to {out}", flush=True)
`;

async function main(args: ParsedArgs): Promise<void> {
	console.log("[mine-hard-negatives] config:", JSON.stringify(args, null, 2));

	const rawPairs = readFileSync(args.inPath, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Pair);
	console.log(`[mine-hard-negatives] loaded ${rawPairs.length} pairs`);

	const db = new Database(args.dbPath, { readonly: true });

	// Stage 1: BM25 retrieval — collect all scoring tasks
	console.log(
		"[mine-hard-negatives] Stage 1: BM25 retrieval + candidate collection",
	);
	const allTasks: ScoringTask[] = [];
	const pairCandidates: Map<
		number,
		{ norm_id: string; block_id: string; text: string }[]
	> = new Map();

	let noBm25 = 0;
	for (let pairIdx = 0; pairIdx < rawPairs.length; pairIdx++) {
		const pair = rawPairs[pairIdx];
		const goldNormId = pair.positive.norm_id;

		const bm25Results = bm25ArticleSearch(db, pair.query, args.bm25TopK);
		const candidates: { norm_id: string; block_id: string; text: string }[] =
			[];

		for (const r of bm25Results) {
			if (r.normId === goldNormId) continue; // drop same-norm
			const text = getBlockText(db, r.normId, r.blockId);
			if (!text || text.length < 80) continue;
			candidates.push({ norm_id: r.normId, block_id: r.blockId, text });
		}

		if (candidates.length === 0) {
			noBm25++;
		}

		pairCandidates.set(pairIdx, candidates);
		for (let candIdx = 0; candIdx < candidates.length; candIdx++) {
			allTasks.push({
				pair_id: pair.id,
				pair_idx: pairIdx,
				cand_idx: candIdx,
				query: pair.query,
				text: candidates[candIdx].text,
				norm_id: candidates[candIdx].norm_id,
				block_id: candidates[candIdx].block_id,
			});
		}

		if ((pairIdx + 1) % 200 === 0) {
			console.log(
				`[mine-hard-negatives] BM25: ${pairIdx + 1}/${rawPairs.length} pairs, ${allTasks.length} tasks so far`,
			);
		}
	}
	console.log(
		`[mine-hard-negatives] total scoring tasks: ${allTasks.length} (${noBm25} pairs with no candidates)`,
	);

	// Stage 2: Python sidecar — score all tasks in one pass
	console.log("[mine-hard-negatives] Stage 2: scoring with Python adapter");
	const tmpIn = `/tmp/mine-hn-input-${process.pid}.jsonl`;
	const tmpOut = `/tmp/mine-hn-output-${process.pid}.jsonl`;
	const tmpScript = `/tmp/mine-hn-scorer-${process.pid}.py`;

	writeFileSync(
		tmpIn,
		allTasks.map((t) => JSON.stringify(t)).join("\n") + "\n",
		"utf8",
	);
	writeFileSync(tmpScript, SCORER_PY, "utf8");

	const pyVenv = resolve(
		import.meta.dir,
		"training/.venv/bin/python",
	);
	const result = Bun.spawnSync(
		[pyVenv, tmpScript, args.adapterPath, tmpIn, tmpOut],
		{
			stdio: ["ignore", "inherit", "inherit"],
		},
	);

	if (result.exitCode !== 0) {
		throw new Error(`Python sidecar exited with code ${result.exitCode}`);
	}

	// Stage 3: Parse scores and build scored-by-pair map
	console.log("[mine-hard-negatives] Stage 3: parsing scores");
	const scoresByPair: Map<
		number,
		Array<{ cand_idx: number; norm_id: string; block_id: string; score: number }>
	> = new Map();

	const scoreLines = readFileSync(tmpOut, "utf8")
		.trim()
		.split("\n")
		.filter((l) => l.trim());
	for (const line of scoreLines) {
		const s = JSON.parse(line) as {
			pair_idx: number;
			cand_idx: number;
			norm_id: string;
			block_id: string;
			score: number;
		};
		const arr = scoresByPair.get(s.pair_idx) ?? [];
		arr.push({ cand_idx: s.cand_idx, norm_id: s.norm_id, block_id: s.block_id, score: s.score });
		scoresByPair.set(s.pair_idx, arr);
	}
	console.log(`[mine-hard-negatives] parsed scores for ${scoresByPair.size} pairs`);

	// Stage 4: Assemble mined pairs
	console.log("[mine-hard-negatives] Stage 4: assembling mined pairs");
	const minedPairs: Pair[] = [];
	let noMateriaSibling = 0;
	let fallbackToOriginal = 0;

	for (let pairIdx = 0; pairIdx < rawPairs.length; pairIdx++) {
		const pair = rawPairs[pairIdx];
		const candidates = pairCandidates.get(pairIdx) ?? [];
		const scores = scoresByPair.get(pairIdx) ?? [];

		if (scores.length === 0 || candidates.length === 0) {
			// Fall back to original negatives
			fallbackToOriginal++;
			minedPairs.push(pair);
			continue;
		}

		// Sort by score descending, pick top-N
		scores.sort((a, b) => b.score - a.score);
		const topNegs = scores.slice(0, args.hardNegCount);

		const newNegatives: Pair["hard_negatives"] = [];
		for (const neg of topNegs) {
			const text = candidates[neg.cand_idx]?.text;
			if (text) {
				newNegatives.push({
					norm_id: neg.norm_id,
					block_id: neg.block_id,
					text,
					source: "reranker-mined",
				});
			}
		}

		// Materia-sibling
		const materiaPool = fetchMateriaSiblingPool(db, pair.positive.norm_id);
		const materiaFiltered = materiaPool.filter(
			(c) =>
				!newNegatives.some(
					(n) => n.norm_id === c.norm_id && n.block_id === c.block_id,
				),
		);
		if (materiaFiltered.length > 0) {
			newNegatives.push({
				norm_id: materiaFiltered[0].norm_id,
				block_id: materiaFiltered[0].block_id,
				text: materiaFiltered[0].text,
				source: "materia-sibling",
			});
		} else {
			noMateriaSibling++;
		}

		if (newNegatives.length === 0) {
			fallbackToOriginal++;
			minedPairs.push(pair);
		} else {
			minedPairs.push({
				...pair,
				hard_negatives: newNegatives,
				meta: {
					...pair.meta,
					generator_pass: "mined-v1",
				},
			});
		}
	}

	db.close();

	mkdirSync(dirname(args.outPath), { recursive: true });
	writeFileSync(
		args.outPath,
		minedPairs.map((p) => JSON.stringify(p)).join("\n") + "\n",
		"utf8",
	);

	console.log(
		`[mine-hard-negatives] wrote ${minedPairs.length} pairs to ${args.outPath}`,
	);
	console.log(`  fallback-to-original: ${fallbackToOriginal}`);
	console.log(`  no-materia-sibling: ${noMateriaSibling}`);
}

main(parseArgs(process.argv.slice(2))).catch((e) => {
	console.error("[mine-hard-negatives] ERROR:", e);
	process.exit(1);
});
