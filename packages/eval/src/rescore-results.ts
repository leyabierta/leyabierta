#!/usr/bin/env bun
/**
 * Re-score a results.jsonl file from a previous eval run, optionally with a
 * different successor map. Lets you compute "with-successors" vs "without"
 * metrics from a single retrieval pass — no need to re-run the slow RAG
 * pipeline.
 *
 * Usage:
 *   bun run packages/eval/src/rescore-results.ts \
 *     --results <results.jsonl> \
 *     [--successors-map <flat.jsonl>] \
 *     [--successors-scope total|all] \
 *     [--label "tag for this scoring"]
 *
 * Prints a markdown summary identical to the run-eval one.
 *
 * Pair with two runs (different maps) and pipe through `diff` or hand-compare
 * to see exactly how many flips successor-awareness contributed.
 */

import {
	computeQueryMetrics,
	type EvalResult,
	expandWithSuccessors,
} from "./harness.ts";

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const resultsPath = flag("results");
const successorsPath = flag("successors-map");
const successorsScope = (flag("successors-scope") ?? "total") as
	| "total"
	| "all";
const label =
	flag("label") ?? (successorsPath ? "with-successors" : "no-successors");

if (!resultsPath) {
	console.error(
		"Usage: rescore-results.ts --results <jsonl> [--successors-map <flat.jsonl>]",
	);
	process.exit(1);
}

// ── Load successor map (same logic as run-eval.ts) ───────────────────────────

async function loadSuccessorsMap(
	path: string,
	scope: "total" | "all",
): Promise<Map<string, Set<string>>> {
	const map = new Map<string, Set<string>>();
	const add = (old: string, neu: string) => {
		if (!map.has(old)) map.set(old, new Set());
		map.get(old)!.add(neu);
	};

	const text = await Bun.file(path).text();
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		const o = JSON.parse(t) as {
			old_norm_id: string;
			new_norm_id: string;
			scope?: string;
		};
		if (scope === "total" && o.scope !== "total") continue;
		add(o.old_norm_id, o.new_norm_id);
	}
	// Manual overrides — matches run-eval.ts
	add("BOE-A-2004-4456", "BOE-A-2014-12328");
	add("BOE-A-1992-26318", "BOE-A-2015-10566");
	return map;
}

const successorsMap = successorsPath
	? await loadSuccessorsMap(successorsPath, successorsScope)
	: undefined;

// ── Load results ──────────────────────────────────────────────────────────────

const text = await Bun.file(resultsPath).text();
const results: EvalResult[] = text
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l) as EvalResult);

// ── Re-score ──────────────────────────────────────────────────────────────────

// Re-derive source/domain from query_id prefix where possible
function inferSource(qid: string): string {
	const m = qid.match(/^([a-z-]+)_/);
	return m ? m[1]! : "unknown";
}
function inferDomain(src: string): string {
	if (src.startsWith("dgt")) return "tax";
	if (src === "divorce") return "constitutional";
	if (src === "refugiados") return "asylum";
	return "other";
}

const bySource = new Map<
	string,
	{ n: number; r1: number; r5: number; r10: number; mrr: number }
>();
const byDomain = new Map<
	string,
	{ n: number; r1: number; r5: number; r10: number; mrr: number }
>();
let n = 0;
let totR1 = 0,
	totR5 = 0,
	totR10 = 0,
	totMrr = 0;

let flippedToHit = 0;
let flippedToMiss = 0; // shouldn't happen — expansion is monotone — but check

for (const r of results) {
	const originalExpanded = r.expected_norm_ids;
	const newExpanded = expandWithSuccessors(originalExpanded, successorsMap);

	const { metrics } = computeQueryMetrics(newExpanded, r.retrieved, 10);

	// Compare against the metrics already in the file (which were computed with
	// whatever scoring the original run used).
	if (r.metrics.r10 === 0 && metrics.r10 === 1) flippedToHit++;
	if (r.metrics.r10 === 1 && metrics.r10 === 0) flippedToMiss++;

	n++;
	totR1 += metrics.r1;
	totR5 += metrics.r5;
	totR10 += metrics.r10;
	totMrr += metrics.mrr;

	const src = inferSource(r.query_id);
	if (!bySource.has(src))
		bySource.set(src, { n: 0, r1: 0, r5: 0, r10: 0, mrr: 0 });
	const sg = bySource.get(src)!;
	sg.n++;
	sg.r1 += metrics.r1;
	sg.r5 += metrics.r5;
	sg.r10 += metrics.r10;
	sg.mrr += metrics.mrr;

	const dom = inferDomain(src);
	if (!byDomain.has(dom))
		byDomain.set(dom, { n: 0, r1: 0, r5: 0, r10: 0, mrr: 0 });
	const dg = byDomain.get(dom)!;
	dg.n++;
	dg.r1 += metrics.r1;
	dg.r5 += metrics.r5;
	dg.r10 += metrics.r10;
	dg.mrr += metrics.mrr;
}

function fin(g: {
	n: number;
	r1: number;
	r5: number;
	r10: number;
	mrr: number;
}) {
	if (g.n === 0) return g;
	return {
		n: g.n,
		r1: g.r1 / g.n,
		r5: g.r5 / g.n,
		r10: g.r10 / g.n,
		mrr: g.mrr / g.n,
	};
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const aggregate = fin({ n, r1: totR1, r5: totR5, r10: totR10, mrr: totMrr });

console.log(`## Rescored: ${label}`);
console.log("");
console.log(`- Source results: \`${resultsPath}\``);
console.log(`- Successors map: ${successorsPath ?? "(none)"}`);
console.log(`- Successors scope: ${successorsScope}`);
console.log(`- Map size: ${successorsMap?.size ?? 0} unique old norms`);
console.log("");
console.log("### Aggregate");
console.log("");
console.log("| Metric | Value |");
console.log("|--------|-------|");
console.log(`| N | ${aggregate.n} |`);
console.log(`| R@1 | ${pct(aggregate.r1)} |`);
console.log(`| R@5 | ${pct(aggregate.r5)} |`);
console.log(`| R@10 | ${pct(aggregate.r10)} |`);
console.log(`| MRR | ${aggregate.mrr.toFixed(3)} |`);
console.log("");
console.log(`### Successor-map impact (vs original results.jsonl scoring)`);
console.log(`- Flipped MISS → HIT (R@10): ${flippedToHit}`);
console.log(`- Flipped HIT → MISS (R@10): ${flippedToMiss}  (should be 0)`);
console.log("");
console.log("### By source");
console.log("");
console.log("| Source | N | R@1 | R@5 | R@10 | MRR |");
console.log("|--------|---|-----|-----|------|-----|");
for (const [src, raw] of [...bySource.entries()].sort()) {
	const m = fin(raw);
	console.log(
		`| ${src} | ${m.n} | ${pct(m.r1)} | ${pct(m.r5)} | ${pct(m.r10)} | ${m.mrr.toFixed(3)} |`,
	);
}
console.log("");
console.log("### By domain");
console.log("");
console.log("| Domain | N | R@1 | R@5 | R@10 | MRR |");
console.log("|--------|---|-----|-----|------|-----|");
for (const [dom, raw] of [...byDomain.entries()].sort()) {
	const m = fin(raw);
	console.log(
		`| ${dom} | ${m.n} | ${pct(m.r1)} | ${pct(m.r5)} | ${pct(m.r10)} | ${m.mrr.toFixed(3)} |`,
	);
}
