/**
 * Analyze the combined-gold Gemini+Qwen eval results, broken down by `origin`.
 *
 * Produces a markdown report with:
 *   - Overall R@1/R@5/R@10 for Gemini vs Qwen-NaN
 *   - Per-origin breakdown (dgt-regex, justicio-cc, justicio-vivienda,
 *     justicio-constitucion, asklog)
 *   - Empty topNormIds count (Gemini upstream failures, if any)
 *   - Per-origin Δ (Qwen − Gemini) — the actual PR #90 verdict
 *
 * Usage:
 *   bun packages/api/research/ab/analyze-combined-gold-eval.ts \
 *     [--gemini data/ab-results/eval-pass-gemini-baseline.json] \
 *     [--qwen   data/ab-results/eval-pass-qwen-no-instruct-nan-analyzer-nan-rerank-gold-combined-375.json] \
 *     [--dataset packages/api/research/datasets/gold-eval-combined.json] \
 *     [--out    data/ab-results/gold-combined-375-analysis.md]
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
			"data/ab-results/eval-pass-qwen-no-instruct-nan-analyzer-nan-rerank-gold-combined-375.json",
		);
const datasetPath = flag("dataset")
	? resolvePath(flag("dataset")!)
	: join(
			repoRoot,
			"packages/api/research/datasets/gold-eval-combined.json",
		);
const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(repoRoot, "data/ab-results/gold-combined-375-analysis.md");

interface PassEntry {
	id: string | number;
	hitsAt1: boolean;
	hitsAt5: boolean;
	hitsAt10: boolean;
	topNormIds: string[];
}
interface Entry {
	id: string;
	question: string;
	expectedNorms: string[];
	source: { origin: string; [k: string]: unknown };
}

const gemini = (await Bun.file(geminiPath).json()) as { results: PassEntry[] };
const qwen = (await Bun.file(qwenPath).json()) as { results: PassEntry[] };
const dataset = (await Bun.file(datasetPath).json()) as { results: Entry[] };

const gByid = new Map(gemini.results.map((r) => [String(r.id), r]));
const qByid = new Map(qwen.results.map((r) => [String(r.id), r]));
const dByid = new Map(dataset.results.map((e) => [String(e.id), e]));

function isValid(r: PassEntry | undefined): boolean {
	return !!r && Array.isArray(r.topNormIds) && r.topNormIds.length > 0;
}

interface Bucket {
	n: number;
	gR1: number; gR5: number; gR10: number; gEmpty: number;
	qR1: number; qR5: number; qR10: number; qEmpty: number;
}
function newBucket(): Bucket {
	return { n: 0, gR1: 0, gR5: 0, gR10: 0, gEmpty: 0, qR1: 0, qR5: 0, qR10: 0, qEmpty: 0 };
}

const overall = newBucket();
const perOrigin = new Map<string, Bucket>();

for (const entry of dataset.results) {
	const id = String(entry.id);
	const g = gByid.get(id);
	const q = qByid.get(id);
	const origin = String(entry.source.origin);
	const b = perOrigin.get(origin) ?? newBucket();
	for (const bucket of [overall, b]) {
		bucket.n++;
		if (g) {
			if (g.hitsAt1) bucket.gR1++;
			if (g.hitsAt5) bucket.gR5++;
			if (g.hitsAt10) bucket.gR10++;
			if (!isValid(g)) bucket.gEmpty++;
		}
		if (q) {
			if (q.hitsAt1) bucket.qR1++;
			if (q.hitsAt5) bucket.qR5++;
			if (q.hitsAt10) bucket.qR10++;
			if (!isValid(q)) bucket.qEmpty++;
		}
	}
	perOrigin.set(origin, b);
}

function pct(n: number, d: number): string {
	return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}
function row(label: string, b: Bucket): string {
	const gR1 = pct(b.gR1, b.n);
	const qR1 = pct(b.qR1, b.n);
	const gR5 = pct(b.gR5, b.n);
	const qR5 = pct(b.qR5, b.n);
	const gR10 = pct(b.gR10, b.n);
	const qR10 = pct(b.qR10, b.n);
	const dR1 = b.n === 0 ? "n/a" : `${(((b.qR1 - b.gR1) / b.n) * 100).toFixed(1)}pp`;
	const dR5 = b.n === 0 ? "n/a" : `${(((b.qR5 - b.gR5) / b.n) * 100).toFixed(1)}pp`;
	return `| ${label} | ${b.n} | ${gR1} / ${qR1} | ${gR5} / ${qR5} | ${gR10} / ${qR10} | ${dR1} | ${dR5} | ${b.gEmpty} |`;
}

const lines: string[] = [];
lines.push(`# Gold-eval combined (n=${overall.n}) — Gemini vs Qwen-NaN`);
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("Format: `Gemini / Qwen-NaN`. Δ = Qwen − Gemini (positive = Qwen wins).");
lines.push("");
lines.push("| Slice | n | R@1 | R@5 | R@10 | Δ R@1 | Δ R@5 | Gemini empty |");
lines.push("|---|---:|---|---|---|---:|---:|---:|");
lines.push(row("**Overall**", overall));
for (const [origin, b] of [...perOrigin.entries()].sort()) {
	lines.push(row(origin, b));
}
lines.push("");
lines.push("## Files");
lines.push(`- Gemini pass: \`${geminiPath.replace(repoRoot, "")}\``);
lines.push(`- Qwen pass: \`${qwenPath.replace(repoRoot, "")}\``);
lines.push(`- Dataset: \`${datasetPath.replace(repoRoot, "")}\``);

const md = lines.join("\n");
await Bun.write(outPath, md);
console.log(md);
console.log(`\nWrote report → ${outPath}`);
