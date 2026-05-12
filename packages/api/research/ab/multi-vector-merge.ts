/**
 * Multi-vector retrieval analysis (post-hoc).
 *
 * Inputs: two saved per-query result files (e.g. raw-text vs citizen-summary
 * Qwen passes). For each query, computes a "multi-vector" hit by taking
 * union of top-K from both passes, ranked by min(rank_raw, rank_summary).
 *
 * This gives an upper-bound estimate of what multi-vector retrieval could
 * achieve without actually fusing scores at the retrieval level. If the gain
 * is real, productize at the embedding/RRF layer.
 *
 * Usage:
 *   bun packages/api/research/ab/multi-vector-merge.ts \
 *     --raw eval-pass-qwen-no-instruct.json \
 *     --summary eval-pass-qwen-no-instruct-summary.json \
 *     --gemini eval-pass-gemini-baseline.json \
 *     --label "qwen-multi-no-instruct"
 */

import { join } from "node:path";

interface QueryResult {
	id: number;
	question: string;
	category: string;
	model: string;
	hitsAt1: boolean;
	hitsAt5: boolean;
	hitsAt10: boolean;
	topNormIds: string[];
	topBlockIds: string[];
	score: number;
	expectedNorms?: string[];
}

interface PassFile {
	dims: number;
	total: number;
	results: QueryResult[];
}

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const repoRoot = join(import.meta.dir, "../../../../");
const outDir = join(repoRoot, "data", "ab-results");
const evalPath = join(
	repoRoot,
	"packages/api/research/datasets/citizen-queries.json",
);

const rawFile = flag("raw") ?? "eval-pass-qwen-no-instruct.json";
const summaryFile =
	flag("summary") ?? "eval-pass-qwen-no-instruct-summary.json";
const geminiFile = flag("gemini") ?? "eval-pass-gemini-baseline.json";
const label = flag("label") ?? "qwen-multi";

const rawPath = join(outDir, rawFile);
const summaryPath = join(outDir, summaryFile);
const geminiPath = join(outDir, geminiFile);

console.log(`Loading:`);
console.log(`  raw     → ${rawPath}`);
console.log(`  summary → ${summaryPath}`);
console.log(`  gemini  → ${geminiPath}`);

const raw = (await Bun.file(rawPath).json()) as PassFile;
const summary = (await Bun.file(summaryPath).json()) as PassFile;
const gemini = (await Bun.file(geminiPath).json()) as PassFile;

// Need expectedNorms for each query — load eval set
const evalSet = (await Bun.file(evalPath).json()) as {
	results: Array<{ id: number; question: string; expectedNorms?: string[] }>;
};
const expectedById = new Map<number, string[]>();
for (const q of evalSet.results) {
	if (q.expectedNorms?.length) expectedById.set(q.id, q.expectedNorms);
}

// Build merged results
const rawById = new Map<number, QueryResult>();
for (const r of raw.results) rawById.set(r.id, r);
const summaryById = new Map<number, QueryResult>();
for (const r of summary.results) summaryById.set(r.id, r);

const allIds = Array.from(
	new Set([...rawById.keys(), ...summaryById.keys()]),
).sort((a, b) => a - b);

const mergedResults: QueryResult[] = [];
for (const id of allIds) {
	const r = rawById.get(id);
	const s = summaryById.get(id);
	if (!r && !s) continue;
	const expected = expectedById.get(id) ?? [];

	// Build merged top-10: take min rank across passes for each normId.
	const rankedByNorm = new Map<string, { rank: number; blockId: string }>();
	if (r) {
		for (let i = 0; i < r.topNormIds.length; i++) {
			const normId = r.topNormIds[i]!;
			const blockId = r.topBlockIds[i] ?? "";
			const prev = rankedByNorm.get(normId);
			if (!prev || i + 1 < prev.rank) {
				rankedByNorm.set(normId, { rank: i + 1, blockId });
			}
		}
	}
	if (s) {
		for (let i = 0; i < s.topNormIds.length; i++) {
			const normId = s.topNormIds[i]!;
			const blockId = s.topBlockIds[i] ?? "";
			const prev = rankedByNorm.get(normId);
			if (!prev || i + 1 < prev.rank) {
				rankedByNorm.set(normId, { rank: i + 1, blockId });
			}
		}
	}

	const merged = Array.from(rankedByNorm.entries())
		.sort((a, b) => a[1].rank - b[1].rank)
		.slice(0, 10);

	const topNormIds = merged.map(([n]) => n);
	const topBlockIds = merged.map(([_, v]) => v.blockId);

	const hitAt1 = topNormIds.length > 0 && expected.includes(topNormIds[0]!);
	const hitAt5 = topNormIds.slice(0, 5).some((n) => expected.includes(n));
	const hitAt10 = topNormIds.slice(0, 10).some((n) => expected.includes(n));

	mergedResults.push({
		id,
		question: r?.question ?? s?.question ?? "",
		category: r?.category ?? s?.category ?? "",
		model: label,
		hitsAt1: hitAt1,
		hitsAt5: hitAt5,
		hitsAt10: hitAt10,
		topNormIds,
		topBlockIds,
		score: 0,
		expectedNorms: expected,
	});
}

function metrics(rs: QueryResult[]): {
	r1: number;
	r5: number;
	r10: number;
	mrr: number;
} {
	const total = rs.length;
	if (total === 0) return { r1: 0, r5: 0, r10: 0, mrr: 0 };
	const h1 = rs.filter((r) => r.hitsAt1).length;
	const h5 = rs.filter((r) => r.hitsAt5).length;
	const h10 = rs.filter((r) => r.hitsAt10).length;
	const mrr =
		rs.reduce((sum, r) => {
			const expected = expectedById.get(r.id) ?? [];
			for (let i = 0; i < r.topNormIds.length; i++) {
				if (expected.includes(r.topNormIds[i]!)) return sum + 1 / (i + 1);
			}
			return sum;
		}, 0) / total;
	return {
		r1: (h1 / total) * 100,
		r5: (h5 / total) * 100,
		r10: (h10 / total) * 100,
		mrr,
	};
}

const m = metrics(mergedResults);
const gemMetrics = metrics(gemini.results);
const rawMetrics = metrics(raw.results);
const summaryMetrics = metrics(summary.results);

console.log(`\n${"=".repeat(70)}`);
console.log(`MULTI-VECTOR ANALYSIS — ${label}`);
console.log("=".repeat(70));
console.log(`Model              R@1      R@5      R@10     MRR@10`);
const fmt = (x: { r1: number; r5: number; r10: number; mrr: number }) =>
	`${x.r1.toFixed(1).padStart(6)}%  ${x.r5.toFixed(1).padStart(6)}%  ${x.r10.toFixed(1).padStart(6)}%   ${x.mrr.toFixed(3).padStart(6)}`;
console.log(`Gemini-2 baseline   ${fmt(gemMetrics)}`);
console.log(`Qwen raw            ${fmt(rawMetrics)}`);
console.log(`Qwen summary        ${fmt(summaryMetrics)}`);
console.log(`Qwen MULTI (merge)  ${fmt(m)}`);
console.log();
console.log(`Gap MULTI vs Gemini:`);
console.log(`  R@1:  ${(m.r1 - gemMetrics.r1).toFixed(1).padStart(6)} pp`);
console.log(`  R@5:  ${(m.r5 - gemMetrics.r5).toFixed(1).padStart(6)} pp`);
console.log(`  R@10: ${(m.r10 - gemMetrics.r10).toFixed(1).padStart(6)} pp`);

// Save merged results in same format as a regular pass
const outPath = join(outDir, `eval-pass-qwen-${label}.json`);
await Bun.write(
	outPath,
	JSON.stringify({ dims: 4096, total: -1, results: mergedResults }, null, 2),
);
console.log(`\nSaved merged pass → ${outPath}`);
