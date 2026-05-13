/**
 * Baseline measurement for Issue #40 (Fase 2 — hybrid search).
 *
 * Runs the citizen-language eval set through the current BM25 /v1/laws path
 * (DbService.searchLaws) and reports Recall@1, Recall@5, Recall@10.
 *
 * The result is the BM25 floor: if hybrid retrieval (BM25 + embeddings + RRF)
 * cannot beat these numbers by ≥10 points on Recall@5, #40 is decoration.
 *
 * Usage:
 *   bun run packages/api/research/eval-citizen-bm25.ts
 *   bun run packages/api/research/eval-citizen-bm25.ts --verbose
 *   bun run packages/api/research/eval-citizen-bm25.ts --out data/eval-citizen-bm25.json
 */

import { Database } from "bun:sqlite";
import { DbService } from "../src/services/db.ts";

const DB_PATH = "./data/leyabierta.db";
const EVAL_PATH = "./packages/api/research/datasets/citizen-queries.json";

interface EvalEntry {
	id: number;
	question: string;
	category: string;
	expectedNorms: string[];
	rationale: string;
}

interface EvalFile {
	description: string;
	version: number;
	createdAt: string;
	results: EvalEntry[];
}

interface QueryResult {
	id: number;
	question: string;
	category: string;
	expectedNorms: string[];
	topIds: string[];
	hitRank: number | null;
	recall1: 0 | 1;
	recall5: 0 | 1;
	recall10: 0 | 1;
	latencyMs: number;
}

function firstHitRank(top: string[], expected: string[]): number | null {
	const set = new Set(expected);
	for (let i = 0; i < top.length; i++) {
		if (set.has(top[i])) return i + 1;
	}
	return null;
}

async function main(): Promise<void> {
	const verbose = process.argv.includes("--verbose");
	const outIdx = process.argv.indexOf("--out");
	const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;

	const evalFile = (await Bun.file(EVAL_PATH).json()) as EvalFile;
	const db = new Database(DB_PATH, { readonly: true });
	const service = new DbService(db);

	const results: QueryResult[] = [];
	for (const entry of evalFile.results) {
		const t0 = performance.now();
		const { laws } = service.searchLaws(entry.question, {}, 10, 0);
		const latencyMs = performance.now() - t0;
		const topIds = laws.map((l) => l.id);
		const hitRank = firstHitRank(topIds, entry.expectedNorms);

		const r: QueryResult = {
			id: entry.id,
			question: entry.question,
			category: entry.category,
			expectedNorms: entry.expectedNorms,
			topIds,
			hitRank,
			recall1: hitRank !== null && hitRank <= 1 ? 1 : 0,
			recall5: hitRank !== null && hitRank <= 5 ? 1 : 0,
			recall10: hitRank !== null && hitRank <= 10 ? 1 : 0,
			latencyMs,
		};
		results.push(r);

		if (verbose) {
			const status = hitRank ? `HIT @${hitRank}` : "MISS";
			console.log(
				`[${entry.id.toString().padStart(2)}] ${status.padEnd(8)} ` +
					`${latencyMs.toFixed(0).padStart(4)}ms  ${entry.question}`,
			);
			if (!hitRank) {
				console.log(`     expected: ${entry.expectedNorms.join(", ")}`);
				console.log(
					`     got top3: ${topIds.slice(0, 3).join(", ") || "(empty)"}`,
				);
			}
		}
	}

	const n = results.length;
	const sum = (k: keyof QueryResult): number =>
		results.reduce((acc, r) => acc + (r[k] as number), 0);

	const r1 = sum("recall1") / n;
	const r5 = sum("recall5") / n;
	const r10 = sum("recall10") / n;
	const avgLatency = results.reduce((acc, r) => acc + r.latencyMs, 0) / n;

	console.log("\n=== Baseline BM25 — citizen queries ===");
	console.log(`N         ${n}`);
	console.log(`Recall@1  ${(r1 * 100).toFixed(1)}%  (${sum("recall1")}/${n})`);
	console.log(`Recall@5  ${(r5 * 100).toFixed(1)}%  (${sum("recall5")}/${n})`);
	console.log(
		`Recall@10 ${(r10 * 100).toFixed(1)}%  (${sum("recall10")}/${n})`,
	);
	console.log(`Latency   ${avgLatency.toFixed(0)}ms avg`);

	const byCat = new Map<string, QueryResult[]>();
	for (const r of results) {
		const list = byCat.get(r.category) ?? [];
		list.push(r);
		byCat.set(r.category, list);
	}
	console.log("\n=== Recall@5 by category ===");
	for (const [cat, list] of [...byCat.entries()].sort()) {
		const hits = list.filter((r) => r.recall5).length;
		console.log(
			`  ${cat.padEnd(28)} ${hits}/${list.length}  ${((hits / list.length) * 100).toFixed(0)}%`,
		);
	}

	const misses = results.filter((r) => !r.recall10);
	if (misses.length > 0) {
		console.log(`\n=== Misses (not in top 10) — ${misses.length} ===`);
		for (const m of misses) {
			console.log(
				`  [${m.id}] ${m.question}\n      expected ${m.expectedNorms.join(",")}, top3: ${m.topIds.slice(0, 3).join(",") || "(empty)"}`,
			);
		}
	}

	if (outPath) {
		await Bun.write(
			outPath,
			JSON.stringify(
				{
					timestamp: new Date().toISOString(),
					evalSet: EVAL_PATH,
					summary: {
						n,
						recall1: r1,
						recall5: r5,
						recall10: r10,
						avgLatencyMs: avgLatency,
					},
					results,
				},
				null,
				2,
			),
		);
		console.log(`\nResults saved → ${outPath}`);
	}

	db.close();
}

await main();
