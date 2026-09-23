/**
 * Offline summary of the 2026-09-23 ZDR A/B (no API calls):
 *   - retrieval metrics per rerank variant, on the full set and on the subset
 *     every variant was run on, plus an exact McNemar test on Hit@1 / Hit@5;
 *   - synthesis metrics (citation precision, latency, $/q) + judge scores.
 *
 * Usage: bun .../summarize.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR } from "./shared.ts";

const jsonl = (p: string) =>
	readFileSync(p, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

const stage1 = jsonl(
	join(OUT_DIR, "stage1-google_gemini-2.5-flash-lite.jsonl"),
);
const gold = new Map<string, string[]>(
	stage1.filter((r) => r.gold?.length).map((r) => [r.id, r.gold]),
);

const variants = [
	"none",
	"llm_google_gemini-2.5-flash-lite",
	"xenc_qwen_qwen3-reranker-8b",
];
const s2: Record<
	string,
	Map<string, { keys: string[]; ms: number; cost: number }>
> = {};
for (const v of variants) {
	const p = join(OUT_DIR, `stage2-${v}.json`);
	if (!existsSync(p)) continue;
	s2[v] = new Map(
		(
			JSON.parse(readFileSync(p, "utf8")) as Array<{
				id: string;
				keys: string[];
				ms: number;
				cost: number;
			}>
		).map((x) => [x.id, x]),
	);
}

function rankOf(v: string, id: string): number | null {
	const keys = s2[v]?.get(id)?.keys ?? [];
	const g = new Set(gold.get(id));
	const i = keys.findIndex((k) => g.has(k.split(":")[0]!));
	return i < 0 ? null : i + 1;
}

// Exact two-sided McNemar (binomial on discordant pairs).
function mcnemar(b: number, c: number): number {
	const n = b + c;
	if (n === 0) return 1;
	const k = Math.min(b, c);
	let p = 0;
	let coef = 1;
	for (let i = 0; i <= k; i++) {
		if (i > 0) coef = (coef * (n - i + 1)) / i;
		p += coef;
	}
	return Math.min(1, (2 * p) / 2 ** n);
}

function table(ids: string[], vs: string[]) {
	const lines = [
		"| Variant | n | Hit@1 | Hit@5 | Hit@15 | MRR@15 | rerank p50 ms | rerank p95 ms | rerank $/q |",
		"|---|---|---|---|---|---|---|---|---|",
	];
	for (const v of vs) {
		let h1 = 0,
			h5 = 0,
			h15 = 0,
			mrr = 0;
		for (const id of ids) {
			const r = rankOf(v, id);
			if (r === 1) h1++;
			if (r && r <= 5) h5++;
			if (r && r <= 15) h15++;
			if (r) mrr += 1 / r;
		}
		const calls = ids.map((id) => s2[v]!.get(id)!).filter((x) => x.ms > 0);
		const lat = calls.map((x) => x.ms).sort((a, b) => a - b);
		const q = (f: number) =>
			lat.length
				? lat[Math.min(lat.length - 1, Math.floor(f * lat.length))]
				: 0;
		const cost = calls.length
			? calls.reduce((s, x) => s + x.cost, 0) / calls.length
			: 0;
		const pc = (x: number) => ((100 * x) / ids.length).toFixed(1);
		lines.push(
			`| ${v} | ${ids.length} | ${pc(h1)} | ${pc(h5)} | ${pc(h15)} | ${(mrr / ids.length).toFixed(3)} | ${q(0.5)} | ${q(0.95)} | ${cost.toFixed(5)} |`,
		);
	}
	return lines.join("\n");
}

const allIds = [...gold.keys()].filter((id) => s2.none?.has(id));
console.log(`## Retrieval — full set (n=${allIds.length})\n`);
console.log(table(allIds, ["none", "llm_google_gemini-2.5-flash-lite"]));
for (const k of [1, 5, 15]) {
	let b = 0,
		c = 0;
	for (const id of allIds) {
		const a = (rankOf("none", id) ?? 99) <= k;
		const l = (rankOf("llm_google_gemini-2.5-flash-lite", id) ?? 99) <= k;
		if (l && !a) b++;
		if (a && !l) c++;
	}
	console.log(
		`McNemar Hit@${k}: llm-only=${b} none-only=${c} p=${mcnemar(b, c).toFixed(4)}`,
	);
}
const ceil = allIds.filter((id) =>
	stage1
		.find((r) => r.id === id)
		?.pool?.some((a: { normId: string }) => gold.get(id)!.includes(a.normId)),
).length;
console.log(
	`Pool ceiling (gold norm anywhere in the fused pool): ${((100 * ceil) / allIds.length).toFixed(1)}%`,
);

if (s2["xenc_qwen_qwen3-reranker-8b"]) {
	const sub = allIds.filter(
		(id) => (s2["xenc_qwen_qwen3-reranker-8b"]!.get(id)?.ms ?? 0) > 0,
	);
	console.log(`\n## Retrieval — cross-encoder subset (n=${sub.length})\n`);
	console.log(table(sub, variants));
}

// ── Synthesis ──
const s3p = join(OUT_DIR, "stage3-llm_google_gemini-2.5-flash-lite.jsonl");
const s3 = jsonl(s3p).filter((r) => !r.early && !r.error);
const models = [...new Set(s3.map((r) => r.model as string))];
const judgeP = join(
	OUT_DIR,
	"judge-llm_google_gemini-2.5-flash-lite-sonnet.jsonl",
);
const judge = existsSync(judgeP) ? jsonl(judgeP) : [];
const allAnswered = new Set(
	[...new Set(s3.map((r) => r.id as string))].filter((id) =>
		models.every((m) => s3.some((r) => r.id === id && r.model === m)),
	),
);
const crit = ["fidelidad", "completitud", "claridad", "ortografia", "declinar"];

function synthTable(ids: Set<string> | null, title: string) {
	console.log(`\n## Synthesis — ${title}\n`);
	console.log(
		"| Model | n | Judge total /10 | Fidelidad | Completitud | Claridad | Ortografía | Declinar | Cit. precision (list) | Cit. precision (inline) | p50 ms | p95 ms | $/q |",
	);
	console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
	for (const m of models) {
		const rows = s3.filter((r) => r.model === m && (!ids || ids.has(r.id)));
		const js = judge
			.filter((j) => !ids || ids.has(j.id))
			.map((j) => j.scores[m])
			.filter(Boolean);
		const avg = (k: string) =>
			js.reduce((s, x) => s + (Number(x[k]) || 0), 0) / (js.length || 1);
		const tot = crit.reduce((s, k) => s + avg(k), 0);
		const sum = (k: string) => rows.reduce((s, r) => s + (r[k] || 0), 0);
		const lat = rows.map((r) => r.ms as number).sort((a, b) => a - b);
		const q = (f: number) =>
			lat[Math.min(lat.length - 1, Math.floor(f * lat.length))];
		console.log(
			`| ${m} | ${rows.length} | ${tot.toFixed(2)} | ${crit.map((k) => avg(k).toFixed(2)).join(" | ")} | ${((100 * sum("citeVerified")) / (sum("citeRaw") || 1)).toFixed(1)}% (${sum("citeVerified")}/${sum("citeRaw")}) | ${((100 * sum("inlineVerified")) / (sum("inlineRaw") || 1)).toFixed(1)}% (${sum("inlineVerified")}/${sum("inlineRaw")}) | ${q(0.5)} | ${q(0.95)} | ${(sum("cost") / rows.length).toFixed(5)} |`,
		);
	}
}
synthTable(
	allAnswered,
	`questions answered by all ${models.length} models (n=${allAnswered.size})`,
);
const noMistral = models.filter((m) => !m.startsWith("mistralai/"));
const ids3 = new Set(
	[...new Set(s3.map((r) => r.id as string))].filter((id) =>
		noMistral.every((m) => s3.some((r) => r.id === id && r.model === m)),
	),
);
synthTable(
	ids3,
	`all questions answered by the 3 non-rate-limited models (n=${ids3.size})`,
);

// Pairwise wins on judge total (all-answered set)
console.log("\n## Judge: per-question winner counts (ties split)\n");
const wins: Record<string, number> = Object.fromEntries(
	models.map((m) => [m, 0]),
);
for (const j of judge.filter((x) => allAnswered.has(x.id))) {
	const tot = Object.fromEntries(
		models.map((m) => [
			m,
			crit.reduce((s, k) => s + (Number(j.scores[m]?.[k]) || 0), 0),
		]),
	);
	const best = Math.max(...Object.values(tot));
	const top = models.filter((m) => tot[m] === best);
	for (const m of top) wins[m]! += 1 / top.length;
}
console.log(wins);
