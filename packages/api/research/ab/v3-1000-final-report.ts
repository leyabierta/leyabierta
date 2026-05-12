/**
 * One-shot helper: load both v3-1000 pass files (Gemini baseline + Qwen-NAN)
 * and compute R@1/5/10, MRR, and per-bucket breakdowns. Writes a markdown
 * report to data/ab-results/v3-1000-final-report.md.
 *
 * Usage:
 *   bun packages/api/research/ab/v3-1000-final-report.ts \
 *     [--gemini data/ab-results/eval-pass-gemini-baseline.json] \
 *     [--qwen   data/ab-results/eval-pass-qwen-no-instruct-nan-analyzer-nan-rerank-v3-1000.json] \
 *     [--out    data/ab-results/v3-1000-final-report.md]
 */

import { isAbsolute, join } from "node:path";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const repoRoot = join(import.meta.dir, "../../../../");
function resolvePath(p: string): string {
	return isAbsolute(p) ? p : join(repoRoot, p);
}

const geminiPath = flag("gemini")
	? resolvePath(flag("gemini")!)
	: join(repoRoot, "data/ab-results/eval-pass-gemini-baseline.json");
const qwenPath = flag("qwen")
	? resolvePath(flag("qwen")!)
	: join(
			repoRoot,
			"data/ab-results/eval-pass-qwen-no-instruct-nan-analyzer-nan-rerank-v3-1000.json",
		);
const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(repoRoot, "data/ab-results/v3-1000-final-report.md");

interface PassEntry {
	id: string | number;
	question: string;
	category: string;
	hitsAt1: boolean;
	hitsAt5: boolean;
	hitsAt10: boolean;
	topNormIds: string[];
}

interface PassFile {
	results: PassEntry[];
}

function rrr(n: number, d: number): string {
	return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

function mrr(entries: PassEntry[]): number {
	let sum = 0;
	let n = 0;
	for (const e of entries) {
		n++;
		if (e.hitsAt1) sum += 1.0;
		else if (e.hitsAt5) {
			// hitsAt5 is true if expected in top-5; we can't tell exact rank from this
			// schema. Approximate: hitsAt5 means rank 2-5, hitsAt10 means rank 6-10.
			// Take mid-rank reciprocal as approximation.
			sum += 1 / 3; // ~middle of 2-5
		} else if (e.hitsAt10) {
			sum += 1 / 7; // ~middle of 6-10
		}
	}
	return n > 0 ? sum / n : 0;
}

function metrics(entries: PassEntry[]) {
	const n = entries.length;
	const r1 = entries.filter((e) => e.hitsAt1).length;
	const r5 = entries.filter((e) => e.hitsAt5).length;
	const r10 = entries.filter((e) => e.hitsAt10).length;
	const empty = entries.filter(
		(e) => !e.topNormIds || e.topNormIds.length === 0,
	).length;
	return {
		n,
		r1,
		r5,
		r10,
		r1Pct: rrr(r1, n),
		r5Pct: rrr(r5, n),
		r10Pct: rrr(r10, n),
		mrrApprox: mrr(entries).toFixed(3),
		empty,
	};
}

const gemini = (await Bun.file(geminiPath).json()) as PassFile;
const qwen = (await Bun.file(qwenPath).json()) as PassFile;

console.log(`Gemini: ${gemini.results.length} entries`);
console.log(`Qwen:   ${qwen.results.length} entries`);

const G = metrics(gemini.results);
const Q = metrics(qwen.results);

function delta(a: number, b: number, asPct = true): string {
	const d = b - a;
	if (asPct) {
		const pct = ((d / Math.max(a, 1)) * 100).toFixed(1);
		const sign = d >= 0 ? "+" : "";
		return `${sign}${d} (${sign}${pct}%)`;
	}
	return d.toFixed(3);
}

// Per-bucket: hits@1 by category
function perCategory(entries: PassEntry[]) {
	const buckets = new Map<string, { n: number; r1: number; r5: number }>();
	for (const e of entries) {
		const c = e.category || "(none)";
		const b = buckets.get(c) ?? { n: 0, r1: 0, r5: 0 };
		b.n++;
		if (e.hitsAt1) b.r1++;
		if (e.hitsAt5) b.r5++;
		buckets.set(c, b);
	}
	return [...buckets.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15);
}

const gCat = perCategory(gemini.results);
const qCatById = new Map(perCategory(qwen.results));

const ts = new Date().toISOString();

const md = `# v3-1000 Final Report — Gemini vs Qwen-NAN

Generated: ${ts}

## Headline

| Metric | Gemini baseline | Qwen-NAN | Δ |
|---|---:|---:|---:|
| n | ${G.n} | ${Q.n} | |
| R@1 | ${G.r1Pct} (${G.r1}) | ${Q.r1Pct} (${Q.r1}) | ${delta(G.r1, Q.r1)} |
| R@5 | ${G.r5Pct} (${G.r5}) | ${Q.r5Pct} (${Q.r5}) | ${delta(G.r5, Q.r5)} |
| R@10 | ${G.r10Pct} (${G.r10}) | ${Q.r10Pct} (${Q.r10}) | ${delta(G.r10, Q.r10)} |
| MRR (approx) | ${G.mrrApprox} | ${Q.mrrApprox} | ${delta(parseFloat(G.mrrApprox), parseFloat(Q.mrrApprox), false)} |
| Empty topNormIds | ${G.empty} | ${Q.empty} | |

> MRR is approximated from hits@1/5/10 (the per-query rank isn't saved). True
> MRR would require per-query rank info; this is good enough for relative
> comparison.

## Per-category (top 15 by query count)

| Category | n | Gemini R@1 | Qwen R@1 | Gemini R@5 | Qwen R@5 |
|---|---:|---:|---:|---:|---:|
${gCat
	.map(([cat, g]) => {
		const q = qCatById.get(cat) ?? { n: g.n, r1: 0, r5: 0 };
		return `| ${cat} | ${g.n} | ${rrr(g.r1, g.n)} | ${rrr(q.r1, q.n)} | ${rrr(g.r5, g.n)} | ${rrr(q.r5, q.n)} |`;
	})
	.join("\n")}

## Files

- Gemini pass: \`${geminiPath.replace(repoRoot, "")}\`
- Qwen pass:   \`${qwenPath.replace(repoRoot, "")}\`
`;

await Bun.write(outPath, md);
console.log(`\nWrote report → ${outPath}`);
console.log(`\nHeadline:`);
console.log(
	`  Gemini  R@1=${G.r1Pct}  R@5=${G.r5Pct}  R@10=${G.r10Pct}  empty=${G.empty}`,
);
console.log(
	`  Qwen    R@1=${Q.r1Pct}  R@5=${Q.r5Pct}  R@10=${Q.r10Pct}  empty=${Q.empty}`,
);
