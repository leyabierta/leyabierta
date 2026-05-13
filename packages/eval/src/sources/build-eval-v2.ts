#!/usr/bin/env bun
/**
 * Build eval v2 dataset from enriched sources.
 *
 * Drops the noisy synthetic subsets (sinai-cqa-boja, sinai-triplets) and uses
 * only real-data sources: DGT (date-filtered for temporal validity), divorce,
 * refugiados. Designed for A/B testing the prod Qwen RAG model.
 *
 * Filters:
 *   - DGT: date >= --dgt-min-date (default 2023-01-01) AND boe_a_ids non-empty
 *   - divorce: boe_a_ids non-empty (52/168 qualify)
 *   - refugiados: boe_a_ids non-empty, random sample of --refugiados-n
 *
 * Output: a single QAEntry-valid JSONL at --out.
 *
 * Usage:
 *   bun run packages/eval/src/sources/build-eval-v2.ts \
 *     --out /Volumes/Disco1TB/datasets/leyabierta/eval-subset-v2.jsonl \
 *     [--dgt-min-date 2023-01-01] \
 *     [--refugiados-n 150] \
 *     [--seed 42]
 */

import { writeFileSync } from "node:fs";
import { QAEntrySchema } from "../qa-schema.ts";

const ENRICHED_DIR = "/Volumes/Disco1TB/datasets/leyabierta/enriched";

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const outPath = flag("out") ?? "/Volumes/Disco1TB/datasets/leyabierta/eval-subset-v2.jsonl";
const dgtMinDate = flag("dgt-min-date") ?? "2022-01-01";
const refugiadosN = Number(flag("refugiados-n") ?? "150");
const refugiadosCapPerNorm = Number(flag("refugiados-cap-per-norm") ?? "50");
const seed = Number(flag("seed") ?? "42");

// Mulberry32: simple deterministic PRNG
function mulberry32(s: number) {
	return () => {
		let t = (s += 0x6d2b79f5);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
	const x = [...arr];
	for (let i = x.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[x[i], x[j]] = [x[j]!, x[i]!];
	}
	return x;
}

async function loadJsonl(path: string): Promise<unknown[]> {
	const text = await Bun.file(path).text();
	return text
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function hasGold(o: any): boolean {
	return Array.isArray(o?.norms?.boe_a_ids) && o.norms.boe_a_ids.length > 0;
}

function validate(o: unknown): boolean {
	const r = QAEntrySchema.safeParse(o);
	if (!r.success) {
		console.error("[validate] failed:", r.error.issues.slice(0, 2));
		return false;
	}
	return true;
}

// ── DGT ──────────────────────────────────────────────────────────────────────

const dgtAll = await loadJsonl(`${ENRICHED_DIR}/dgt.jsonl`);
const dgt = dgtAll.filter((o: any) => {
	const date = o.metadata?.date || "";
	return hasGold(o) && date >= dgtMinDate;
});
console.log(`[dgt] ${dgtAll.length} total → ${dgt.length} with gold AND date >= ${dgtMinDate}`);

// ── divorce ─────────────────────────────────────────────────────────────────

const divorceAll = await loadJsonl(`${ENRICHED_DIR}/divorce.jsonl`);
const divorce = divorceAll.filter(hasGold);
console.log(`[divorce] ${divorceAll.length} total → ${divorce.length} with gold`);

// ── refugiados ──────────────────────────────────────────────────────────────

const refugiadosAll = await loadJsonl(`${ENRICHED_DIR}/refugiados.jsonl`);
const refugiadosWithGold = refugiadosAll.filter(hasGold);
// Cap per primary-norm to avoid one BOE-A dominating (BOE-A-2000-544 has 610 entries).
const refugiadosByNormCount = new Map<string, number>();
const refugiadosCapped: unknown[] = [];
for (const o of refugiadosWithGold as any[]) {
	const primary = o.norms.boe_a_ids[0] as string;
	const n = refugiadosByNormCount.get(primary) || 0;
	if (n < refugiadosCapPerNorm) {
		refugiadosCapped.push(o);
		refugiadosByNormCount.set(primary, n + 1);
	}
}
const rng = mulberry32(seed);
const refugiadosSampled = shuffle(refugiadosCapped, rng).slice(0, refugiadosN);
console.log(
	`[refugiados] ${refugiadosAll.length} total → ${refugiadosWithGold.length} with gold → ${refugiadosCapped.length} after cap@${refugiadosCapPerNorm}/norm → sampled ${refugiadosSampled.length}`,
);

// ── Combine + validate ──────────────────────────────────────────────────────

const all = [...dgt, ...divorce, ...refugiadosSampled];
let valid = 0;
const validated: unknown[] = [];
for (const e of all) {
	if (validate(e)) {
		validated.push(e);
		valid++;
	}
}
console.log(`[combined] ${all.length} candidates → ${valid} valid against QAEntrySchema`);

// Stable shuffle so source ordering doesn't bias the run-time progress display
const shuffled = shuffle(validated, mulberry32(seed));

const out = shuffled.map((e) => JSON.stringify(e)).join("\n") + "\n";
writeFileSync(outPath, out, "utf8");

console.log(`\n[done] Wrote ${valid} entries → ${outPath}`);
console.log("\nPer-source counts in output:");
const counts = new Map<string, number>();
for (const e of shuffled as any[]) {
	counts.set(e.source, (counts.get(e.source) || 0) + 1);
}
for (const [s, n] of [...counts.entries()].sort()) {
	console.log(`  ${s}: ${n}`);
}
