#!/usr/bin/env bun
/**
 * A/B comparison harness: takes two results.jsonl files (from two runs on the
 * SAME eval dataset, with different retrievers/models) and produces:
 *   - side-by-side aggregate + per-source metrics
 *   - per-query flip counts (A-only-hit, B-only-hit, both, neither)
 *   - top-20 regression cases (A hit at rank R, B missed) — for failure review
 *   - top-20 win cases (B hit, A missed) — for confidence the change helps
 *
 * Usage:
 *   bun run packages/eval/src/compare-ab.ts \
 *     --a <run-A/results.jsonl> --a-label "prod-qwen" \
 *     --b <run-B/results.jsonl> --b-label "candidate-x" \
 *     [--metric r1|r5|r10]                # default r10 (used for flip-count window)
 *     [--out-md <comparison.md>]           # optional file output
 *
 * Both runs must have been built from the same eval dataset (same query_ids).
 * Order doesn't have to match — we join on query_id.
 */

import type { EvalResult } from "./harness.ts";

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const aPath = flag("a");
const bPath = flag("b");
const aLabel = flag("a-label") ?? "A";
const bLabel = flag("b-label") ?? "B";
const metric = (flag("metric") ?? "r10") as "r1" | "r5" | "r10";
const outMd = flag("out-md");

if (!aPath || !bPath) {
	console.error(
		"Usage: compare-ab.ts --a <jsonl> --b <jsonl> [--a-label X --b-label Y]",
	);
	process.exit(1);
}

async function load(p: string): Promise<Map<string, EvalResult>> {
	const text = await Bun.file(p).text();
	const out = new Map<string, EvalResult>();
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		const r = JSON.parse(t) as EvalResult;
		out.set(r.query_id, r);
	}
	return out;
}

const aMap = await load(aPath);
const bMap = await load(bPath);

// ── Join + aggregate ──────────────────────────────────────────────────────────

const commonIds = [...aMap.keys()].filter((id) => bMap.has(id));
const aOnly = aMap.size - commonIds.length;
const bOnly = bMap.size - commonIds.length;

interface Bucket {
	n: number;
	a_r1: number;
	a_r5: number;
	a_r10: number;
	a_mrr: number;
	b_r1: number;
	b_r5: number;
	b_r10: number;
	b_mrr: number;
}
function emptyBucket(): Bucket {
	return {
		n: 0,
		a_r1: 0,
		a_r5: 0,
		a_r10: 0,
		a_mrr: 0,
		b_r1: 0,
		b_r5: 0,
		b_r10: 0,
		b_mrr: 0,
	};
}

function inferSource(qid: string): string {
	const m = qid.match(/^([a-z-]+)_/);
	return m ? m[1]! : "unknown";
}

const total = emptyBucket();
const bySource = new Map<string, Bucket>();

let bothHit = 0; // hit on metric in both
let aOnlyHit = 0; // hit in A, miss in B
let bOnlyHit = 0; // hit in B, miss in A
let bothMiss = 0;

interface FlipRow {
	query_id: string;
	source: string;
	question: string;
	expected: string[];
	a_rank: number | null;
	b_rank: number | null;
	a_top1: string;
	b_top1: string;
}
const aWinsBLoses: FlipRow[] = []; // A hit, B miss → regression candidate
const bWinsALoses: FlipRow[] = []; // B hit, A miss → improvement

function firstHitRank(r: EvalResult): number | null {
	return r.hits.length > 0 ? r.hits[0]!.rank : null;
}

for (const id of commonIds) {
	const a = aMap.get(id)!;
	const b = bMap.get(id)!;
	const aHit = a.metrics[metric] === 1;
	const bHit = b.metrics[metric] === 1;

	if (aHit && bHit) bothHit++;
	else if (aHit && !bHit) aOnlyHit++;
	else if (!aHit && bHit) bOnlyHit++;
	else bothMiss++;

	const src = inferSource(id);
	if (!bySource.has(src)) bySource.set(src, emptyBucket());
	for (const bucket of [total, bySource.get(src)!]) {
		bucket.n++;
		bucket.a_r1 += a.metrics.r1;
		bucket.a_r5 += a.metrics.r5;
		bucket.a_r10 += a.metrics.r10;
		bucket.a_mrr += a.metrics.mrr;
		bucket.b_r1 += b.metrics.r1;
		bucket.b_r5 += b.metrics.r5;
		bucket.b_r10 += b.metrics.r10;
		bucket.b_mrr += b.metrics.mrr;
	}

	if (aHit && !bHit) {
		aWinsBLoses.push({
			query_id: id,
			source: src,
			question: a.question.slice(0, 120),
			expected: a.expected_norm_ids,
			a_rank: firstHitRank(a),
			b_rank: firstHitRank(b),
			a_top1: a.retrieved[0]?.norm_id ?? "(empty)",
			b_top1: b.retrieved[0]?.norm_id ?? "(empty)",
		});
	}
	if (bHit && !aHit) {
		bWinsALoses.push({
			query_id: id,
			source: src,
			question: a.question.slice(0, 120),
			expected: a.expected_norm_ids,
			a_rank: firstHitRank(a),
			b_rank: firstHitRank(b),
			a_top1: a.retrieved[0]?.norm_id ?? "(empty)",
			b_top1: b.retrieved[0]?.norm_id ?? "(empty)",
		});
	}
}

const pct = (n: number, d: number) =>
	d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;
function rowFor(label: string, bucket: Bucket) {
	const a_mrr = (bucket.a_mrr / Math.max(1, bucket.n)).toFixed(3);
	const b_mrr = (bucket.b_mrr / Math.max(1, bucket.n)).toFixed(3);
	return `| ${label} | ${bucket.n} | ${pct(bucket.a_r1, bucket.n)} / ${pct(bucket.b_r1, bucket.n)} | ${pct(bucket.a_r5, bucket.n)} / ${pct(bucket.b_r5, bucket.n)} | ${pct(bucket.a_r10, bucket.n)} / ${pct(bucket.b_r10, bucket.n)} | ${a_mrr} / ${b_mrr} |`;
}

// ── Output ────────────────────────────────────────────────────────────────────

const lines: string[] = [];
lines.push(`# A/B comparison: ${aLabel} vs ${bLabel}`);
lines.push("");
lines.push(`- **${aLabel}** (A): \`${aPath}\` — ${aMap.size} results`);
lines.push(`- **${bLabel}** (B): \`${bPath}\` — ${bMap.size} results`);
lines.push(`- Common query_ids: ${commonIds.length}`);
lines.push(`- A-only: ${aOnly}, B-only: ${bOnly}`);
lines.push(`- Flip window: \`${metric}\``);
lines.push("");
lines.push(`## Per-query flips (${metric})`);
lines.push("");
lines.push("| Bucket | Count | % |");
lines.push("|--------|-------|---|");
const n = commonIds.length;
lines.push(`| Both hit | ${bothHit} | ${pct(bothHit, n)} |`);
lines.push(
	`| Only ${aLabel} hit (B regression) | ${aOnlyHit} | ${pct(aOnlyHit, n)} |`,
);
lines.push(
	`| Only ${bLabel} hit (B win) | ${bOnlyHit} | ${pct(bOnlyHit, n)} |`,
);
lines.push(`| Both miss | ${bothMiss} | ${pct(bothMiss, n)} |`);
lines.push(
	`| **Net Δ** | **${bOnlyHit - aOnlyHit > 0 ? "+" : ""}${bOnlyHit - aOnlyHit}** | |`,
);
lines.push("");
lines.push("## Aggregate (A / B)");
lines.push("");
lines.push("| Group | N | R@1 (A/B) | R@5 (A/B) | R@10 (A/B) | MRR (A/B) |");
lines.push("|-------|---|-----------|-----------|------------|-----------|");
lines.push(rowFor("**total**", total));
for (const [src, b] of [...bySource.entries()].sort()) {
	lines.push(rowFor(src, b));
}
lines.push("");

function flipBlock(title: string, rows: FlipRow[]) {
	lines.push(`## ${title} — top 20`);
	lines.push("");
	lines.push(
		"| query_id | source | A rank | B rank | A top-1 | B top-1 | expected | question |",
	);
	lines.push(
		"|----------|--------|--------|--------|---------|---------|----------|----------|",
	);
	for (const r of rows.slice(0, 20)) {
		lines.push(
			`| ${r.query_id} | ${r.source} | ${r.a_rank ?? "miss"} | ${r.b_rank ?? "miss"} | ${r.a_top1} | ${r.b_top1} | ${r.expected.join(", ").slice(0, 80)} | ${r.question.replace(/\|/g, "/")} |`,
		);
	}
	lines.push("");
}
flipBlock(`Regressions (${aLabel} hit, ${bLabel} missed)`, aWinsBLoses);
flipBlock(`Wins (${bLabel} hit, ${aLabel} missed)`, bWinsALoses);

const md = lines.join("\n");
console.log(md);
if (outMd) {
	await Bun.write(outMd, md);
	console.error(`\nWrote ${outMd}`);
}
