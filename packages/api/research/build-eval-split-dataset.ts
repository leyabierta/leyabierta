#!/usr/bin/env bun
/**
 * Exp 3 — Distribution mismatch upper-bound diagnostic.
 *
 * Takes eval-v2.json, splits 50/50 with a fixed seed (no overlap).
 * For the TRAIN half:
 *   - Uses the question as the query
 *   - Finds the most relevant article for expectedNorms[0] via BM25
 *   - Mines BM25 negatives (top 5..15 from the same BM25 run, excluding gold norm)
 *   - Also picks 1 materia-sibling
 * Writes a training JSONL + a held-out question list for eval.
 *
 * WARNING: This is a CONTAMINATED diagnostic. The eval half shares the same
 * distribution as the train half (both from eval-v2). Use ONLY to determine
 * if real-distribution data can beat the baseline. Do NOT use this model in
 * production.
 *
 * Usage:
 *   bun run packages/api/research/build-eval-split-dataset.ts \
 *     --eval data/eval-v2.json \
 *     --db data/leyabierta.db \
 *     --out-train packages/api/research/datasets/eval-split-train.jsonl \
 *     --out-holdout packages/api/research/training/eval-candidates-holdout.jsonl \
 *     --seed 99
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bm25ArticleSearch } from "../src/services/rag/blocks-fts.ts";

type EvalItem = {
	id: number;
	question: string;
	expectedNorms: string[];
	register?: string;
};

type EvalFile = {
	results?: EvalItem[];
} & EvalItem[];

function loadEval(path: string): EvalItem[] {
	const raw = JSON.parse(readFileSync(path, "utf8")) as
		| { results: EvalItem[] }
		| EvalItem[];
	const items = Array.isArray(raw) ? raw : (raw.results ?? []);
	return items.filter((q) => (q.expectedNorms ?? []).length > 0);
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
	const out = arr.slice();
	const rand = mulberry32(seed);
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function getBlockText(
	db: Database,
	normId: string,
	blockId: string,
): string | null {
	const row = db
		.query("SELECT current_text FROM blocks WHERE norm_id = ? AND block_id = ?")
		.get(normId, blockId) as { current_text: string } | null;
	return row?.current_text ?? null;
}

function fetchMateriaSiblingPool(
	db: Database,
	goldNormId: string,
	limit = 50,
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

type ParsedArgs = {
	evalPath: string;
	dbPath: string;
	outTrainPath: string;
	outHoldoutPath: string;
	seed: number;
	bm25TopK: number;
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
		evalPath: resolve(opts.eval ?? "data/eval-v2.json"),
		dbPath: resolve(opts.db ?? "data/leyabierta.db"),
		outTrainPath: resolve(
			opts["out-train"] ??
				"packages/api/research/datasets/eval-split-train.jsonl",
		),
		outHoldoutPath: resolve(
			opts["out-holdout"] ??
				"packages/api/research/training/eval-candidates-holdout.jsonl",
		),
		seed: Number.parseInt(opts.seed ?? "99", 10),
		bm25TopK: Number.parseInt(opts["bm25-top-k"] ?? "30", 10),
	};
}

async function main(args: ParsedArgs): Promise<void> {
	console.log("[build-eval-split] config:", JSON.stringify(args, null, 2));

	const items = loadEval(args.evalPath);
	console.log(`[build-eval-split] loaded ${items.length} in-scope eval items`);

	// 50/50 split by question id (deterministic)
	const shuffled = seededShuffle(items, args.seed);
	const splitIdx = Math.floor(shuffled.length / 2);
	const trainItems = shuffled.slice(0, splitIdx);
	const holdoutItems = shuffled.slice(splitIdx);
	console.log(
		`[build-eval-split] split: ${trainItems.length} train / ${holdoutItems.length} holdout`,
	);

	const db = new Database(args.dbPath, { readonly: true });

	// Build training pairs from the train half
	type TrainPair = {
		id: string;
		query: string;
		register: string;
		is_trap: boolean;
		positive: { norm_id: string; block_id: string; text: string };
		hard_negatives: Array<{
			norm_id: string;
			block_id: string;
			text: string;
			source: string;
		}>;
		meta: { generation: string; generator_pass: string; created_at: string };
	};

	const pairs: TrainPair[] = [];
	let noPositiveFound = 0;
	let noNegatives = 0;
	const today = new Date().toISOString().slice(0, 10);

	try {
		for (let i = 0; i < trainItems.length; i++) {
			const item = trainItems[i];
			const goldNormId = item.expectedNorms[0];

			// Find the top BM25 hit for the gold norm (its most relevant article)
			const bm25Results = bm25ArticleSearch(db, item.question, args.bm25TopK);

			// Find positive: first result from the gold norm
			const posResult = bm25Results.find((r) => r.normId === goldNormId);
			let positiveText: string | null = null;
			const posNormId = goldNormId;
			let posBlockId = "";

			if (posResult) {
				positiveText = getBlockText(db, posResult.normId, posResult.blockId);
				posBlockId = posResult.blockId;
			}

			if (!positiveText) {
				// Fall back: pick the first precepto from the gold norm directly
				const fallback = db
					.query(
						`SELECT block_id, current_text FROM blocks
						WHERE norm_id = ? AND block_type = 'precepto'
						AND length(current_text) >= 80
						AND block_id NOT LIKE 'dd%'
						ORDER BY rowid LIMIT 1`,
					)
					.get(goldNormId) as { block_id: string; current_text: string } | null;
				if (fallback) {
					positiveText = fallback.current_text;
					posBlockId = fallback.block_id;
				}
			}

			if (!positiveText) {
				noPositiveFound++;
				continue;
			}

			// Negatives: BM25 positions 5..15 excluding gold norm
			const negCandidates = bm25Results
				.filter((r) => r.normId !== goldNormId)
				.slice(4, 14); // positions 5..14 (0-indexed: 4..13)

			const negRecords: TrainPair["hard_negatives"] = [];
			for (const neg of negCandidates.slice(0, 2)) {
				const text = getBlockText(db, neg.normId, neg.blockId);
				if (text && text.length >= 80) {
					negRecords.push({
						norm_id: neg.normId,
						block_id: neg.blockId,
						text,
						source: "semantic-topk",
					});
					if (negRecords.length >= 2) break;
				}
			}

			// Materia-sibling
			const materiaPool = fetchMateriaSiblingPool(db, goldNormId, 20);
			if (materiaPool.length > 0) {
				negRecords.push({
					norm_id: materiaPool[0].norm_id,
					block_id: materiaPool[0].block_id,
					text: materiaPool[0].text,
					source: "materia-sibling",
				});
			}

			if (negRecords.length === 0) {
				noNegatives++;
				continue;
			}

			pairs.push({
				id: `eval-split-${String(i).padStart(4, "0")}`,
				query: item.question,
				register: item.register ?? "untagged",
				is_trap: false,
				positive: {
					norm_id: posNormId,
					block_id: posBlockId,
					text: positiveText,
				},
				hard_negatives: negRecords,
				meta: {
					generation: "real-eval-v2",
					generator_pass: "eval-split-v1",
					created_at: today,
				},
			});
		}
	} finally {
		db.close();
	}

	console.log(`[build-eval-split] built ${pairs.length} training pairs`);
	console.log(`  no-positive-found: ${noPositiveFound}`);
	console.log(`  no-negatives: ${noNegatives}`);

	mkdirSync(dirname(args.outTrainPath), { recursive: true });
	writeFileSync(
		args.outTrainPath,
		pairs.map((p) => JSON.stringify(p)).join("\n") + "\n",
		"utf8",
	);
	console.log(
		`[build-eval-split] wrote training pairs to ${args.outTrainPath}`,
	);

	// Write holdout question IDs for use with eval.py (just the IDs, the eval.py
	// already knows to filter by what's in eval-candidates-realistic.jsonl)
	const holdoutIds = holdoutItems.map((q) => q.id);
	mkdirSync(dirname(args.outHoldoutPath), { recursive: true });
	writeFileSync(
		args.outHoldoutPath,
		JSON.stringify(
			{ holdout_ids: holdoutIds, total: holdoutIds.length },
			null,
			2,
		),
		"utf8",
	);
	console.log(
		`[build-eval-split] wrote ${holdoutIds.length} holdout IDs to ${args.outHoldoutPath}`,
	);
}

main(parseArgs(process.argv.slice(2))).catch((e) => {
	console.error("[build-eval-split] ERROR:", e);
	process.exit(1);
});
