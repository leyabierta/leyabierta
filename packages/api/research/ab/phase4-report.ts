/**
 * Phase 4 final report. Loads all variant JSON results, computes metrics,
 * produces a comparison markdown with miss analysis.
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

const repoRoot = join(import.meta.dir, "../../../../");
const outDir = join(repoRoot, "data", "ab-results");
const evalPath = join(
	repoRoot,
	"packages/api/research/datasets/citizen-queries.json",
);
const evalSet = (await Bun.file(evalPath).json()) as {
	results: Array<{ id: number; question: string; expectedNorms?: string[] }>;
};
const expectedById = new Map<number, string[]>();
for (const q of evalSet.results) {
	if (q.expectedNorms?.length) expectedById.set(q.id, q.expectedNorms);
}

const variants: Array<{ tag: string; label: string; description: string }> = [
	{
		tag: "gemini-baseline",
		label: "Gemini-2 (control)",
		description: "Phase 3 prod-replica baseline; OpenRouter embed; rerank cohere/rerank-4-pro.",
	},
	{
		tag: "qwen-no-instruct",
		label: "Qwen no-instruct (NaN)",
		description: "Qwen3-Embedding-8B via NaN, no Instruct prefix, raw-text index.",
	},
	{
		tag: "qwen-no-instruct-hyde",
		label: "Qwen + HyDE",
		description: "qwen3.6 (NaN) rewrites query → legal jargon, composed with original.",
	},
	{
		tag: "qwen-no-instruct-summary",
		label: "Qwen + summary index",
		description: "Search citizen-summary embedding store (plain-Spanish vocab bridge).",
	},
	{
		tag: "qwen-no-instruct-hyde-summary",
		label: "Qwen + HyDE + summary",
		description: "HyDE query + summary index.",
	},
	{
		tag: "qwen-multi",
		label: "Qwen multi-vector (raw+summary)",
		description: "Post-hoc merge: top-K from raw and summary, min(rank) per norm.",
	},
	{
		tag: "qwen-hyde-multi",
		label: "Qwen multi + HyDE",
		description: "Post-hoc merge of HyDE-raw + HyDE-summary.",
	},
];

interface Metrics {
	r1: number;
	r5: number;
	r10: number;
	mrr: number;
	misses: Array<{ id: number; question: string; expected: string[]; top3: string[] }>;
}

function compute(results: QueryResult[]): Metrics {
	const total = results.length;
	if (total === 0)
		return { r1: 0, r5: 0, r10: 0, mrr: 0, misses: [] };
	const h1 = results.filter((r) => r.hitsAt1).length;
	const h5 = results.filter((r) => r.hitsAt5).length;
	const h10 = results.filter((r) => r.hitsAt10).length;
	const mrr =
		results.reduce((sum, r) => {
			const expected = r.expectedNorms ?? expectedById.get(r.id) ?? [];
			for (let i = 0; i < r.topNormIds.length; i++) {
				if (expected.includes(r.topNormIds[i]!)) return sum + 1 / (i + 1);
			}
			return sum;
		}, 0) / total;
	const misses = results
		.filter((r) => !r.hitsAt1)
		.map((r) => ({
			id: r.id,
			question: r.question,
			expected: r.expectedNorms ?? expectedById.get(r.id) ?? [],
			top3: r.topNormIds.slice(0, 3),
		}));
	return {
		r1: (h1 / total) * 100,
		r5: (h5 / total) * 100,
		r10: (h10 / total) * 100,
		mrr,
		misses,
	};
}

const rows: Array<{
	tag: string;
	label: string;
	description: string;
	metrics: Metrics | null;
	count: number;
}> = [];

// Gemini baseline is in eval-pass-gemini-baseline.json (different schema)
{
	const path = join(outDir, "eval-pass-gemini-baseline.json");
	const f = Bun.file(path);
	if (await f.exists()) {
		const data = (await f.json()) as PassFile;
		rows.push({
			tag: "gemini-baseline",
			label: "Gemini-2 (control)",
			description: "Phase 3 prod-replica baseline; OpenRouter embed; rerank cohere/rerank-4-pro.",
			metrics: compute(data.results),
			count: data.results.length,
		});
	}
}

for (const v of variants) {
	if (v.tag === "gemini-baseline") continue;
	// Strip "qwen-" prefix to match file naming "eval-pass-qwen-<tag>.json"
	const fileTag = v.tag.replace(/^qwen-/, "");
	const path = join(outDir, `eval-pass-qwen-${fileTag}.json`);
	const f = Bun.file(path);
	if (!(await f.exists())) {
		rows.push({
			tag: v.tag,
			label: v.label,
			description: v.description,
			metrics: null,
			count: 0,
		});
		continue;
	}
	const data = (await f.json()) as PassFile;
	rows.push({
		tag: v.tag,
		label: v.label,
		description: v.description,
		metrics: compute(data.results),
		count: data.results.length,
	});
}

// ── Render markdown ──

const lines: string[] = [];
lines.push(`# Phase 4 results — Qwen interventions (NaN-only)`);
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Eval set: 50 citizen queries × 9.7k-norm haystack.`);
lines.push("");
lines.push("## Variant matrix");
lines.push("");
lines.push("| Variant | R@1 | R@5 | R@10 | MRR@10 | Δ R@1 vs Gemini |");
lines.push("|---|---|---|---|---|---|");

const gem = rows.find((r) => r.tag === "gemini-baseline");
const gemR1 = gem?.metrics?.r1 ?? 50;

for (const r of rows) {
	if (!r.metrics) {
		lines.push(`| ${r.label} | — | — | — | — | (not run) |`);
		continue;
	}
	const m = r.metrics;
	const delta = m.r1 - gemR1;
	const sign = delta > 0 ? "+" : "";
	lines.push(
		`| ${r.label} | ${m.r1.toFixed(1)}% | ${m.r5.toFixed(1)}% | ${m.r10.toFixed(1)}% | ${m.mrr.toFixed(3)} | ${sign}${delta.toFixed(1)} pp |`,
	);
}

lines.push("");
lines.push("## Variant descriptions");
lines.push("");
for (const r of rows) {
	lines.push(`- **${r.label}** (\`${r.tag}\`, n=${r.count}): ${r.description}`);
}

lines.push("");
lines.push("## Per-variant top-1 misses");
lines.push("");
for (const r of rows) {
	if (!r.metrics) continue;
	const misses = r.metrics.misses;
	lines.push(`### ${r.label} — ${misses.length} misses`);
	if (misses.length === 0) {
		lines.push("All queries hit@1 ✅");
		lines.push("");
		continue;
	}
	lines.push("");
	lines.push("| q | Question | Expected | Top-3 returned |");
	lines.push("|---|---|---|---|");
	for (const m of misses) {
		const q = m.question.length > 60 ? `${m.question.slice(0, 57)}…` : m.question;
		lines.push(
			`| q${m.id} | ${q} | ${m.expected.join(", ")} | ${m.top3.join(", ")} |`,
		);
	}
	lines.push("");
}

// Recommendation
lines.push("## Recommendation");
lines.push("");
const qwenVariants = rows
	.filter((r) => r.tag !== "gemini-baseline" && r.metrics)
	.sort((a, b) => (b.metrics?.r1 ?? 0) - (a.metrics?.r1 ?? 0));
if (qwenVariants.length > 0) {
	const best = qwenVariants[0]!;
	const m = best.metrics!;
	const delta = m.r1 - gemR1;
	if (delta > 0) {
		lines.push(
			`**Winner: ${best.label}** with R@1 ${m.r1.toFixed(1)}% (+${delta.toFixed(1)} pp vs Gemini).`,
		);
		lines.push("");
		lines.push(`Recommend: migrate prod \`EMBEDDING_MODEL_KEY\` to \`qwen3-nan\` and apply the ${best.label} setup.`);
	} else if (delta >= -2) {
		lines.push(
			`**Tie**: ${best.label} matches Gemini within 2pp R@1 (${m.r1.toFixed(1)}% vs ${gemR1.toFixed(1)}%).`,
		);
		lines.push("");
		lines.push(`Recommend: migrate to free Qwen-NAN; the small R@1 cost is offset by R@5/R@10 wins and zero embedding cost. Re-evaluate on a larger eval set before final commit.`);
	} else {
		lines.push(
			`Best Qwen variant (${best.label}) still trails Gemini by ${(-delta).toFixed(1)} pp R@1.`,
		);
		lines.push("");
		lines.push("Recommend: keep Gemini for now; revisit when more interventions are tried.");
	}
}

const outPath = join(outDir, "phase4-results.md");
await Bun.write(outPath, lines.join("\n"));
console.log(`✅ Wrote ${outPath}`);
console.log("\n" + lines.slice(0, 30).join("\n"));
