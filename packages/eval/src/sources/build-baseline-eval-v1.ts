#!/usr/bin/env bun
/**
 * Build baseline-eval-v1.jsonl — stratified eval set for the Qwen-vs-Gemini A/B.
 *
 * Sampling plan (total 500 queries):
 *   - 250 from DGT     — stratified across organos (DGT sub-organs), seed=42
 *   - 150 from sinai-cqa — seed=42
 *   - 100 from refugiados — seed=42
 *
 * Filters applied:
 *   - Entry must have non-empty boe_a_ids (resolved ground truth).
 *   - Drop the `answer` field — eval only needs question + expected_norm_ids.
 *
 * Output schema per entry:
 *   { id, source, question, expected_norm_ids: string[], metadata }
 *
 * Companion output: heldout-norms.json — union of all boe_a_ids referenced,
 * for use by future fine-tuning contamination checks.
 *
 * Usage:
 *   bun run packages/eval/src/sources/build-baseline-eval-v1.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Config ────────────────────────────────────────────────────────────────────

const ENRICHED_DIR = "/Volumes/Disco1TB/datasets/leyabierta/enriched";

const PLAN = [
	{ source: "dgt", file: "dgt.jsonl", n: 250, stratifyBy: "organo" },
	{ source: "sinai-cqa", file: "sinai-cqa.jsonl", n: 150, stratifyBy: null },
	{ source: "refugiados", file: "refugiados.jsonl", n: 100, stratifyBy: null },
] as const;

const SEED = 42;
const OUT_DIR = join(import.meta.dir, "../../data");
const EVAL_OUT = join(OUT_DIR, "baseline-eval-v1.jsonl");
const HELDOUT_OUT = join(OUT_DIR, "heldout-norms.json");

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
	let s = seed;
	return () => {
		s |= 0;
		s = (s + 0x6d2b79f5) | 0;
		let z = Math.imul(s ^ (s >>> 15), 1 | s);
		z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
		return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
	};
}

// ── JSONL reader ──────────────────────────────────────────────────────────────

async function* readJsonl<T>(path: string): AsyncGenerator<T> {
	const text = await Bun.file(path).text();
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		yield JSON.parse(t) as T;
	}
}

// ── Eval entry type ───────────────────────────────────────────────────────────
//
// Output format: QAEntry-compatible so run-eval.ts can consume directly.
// We include `expected_norm_ids` as a top-level field (for human readability)
// AND the `norms.boe_a_ids` field (for the harness). The `answer` field is
// set to a placeholder — the eval harness doesn't use it.

interface BaselineEntry {
	id: string;
	source: string;
	question: string;
	expected_norm_ids: string[]; // top-level alias, for human readers
	// QAEntry-compatible norms blob (required by harness.ts)
	norms: {
		citations_raw: string[];
		boe_a_ids: string[];
	};
	answer: string; // placeholder — eval doesn't use it
	metadata: {
		domain?: string;
		jurisdiction?: string;
		organo?: string;
		difficulty?: string;
		date?: string;
	};
}

interface RawEntry {
	id: string;
	source: string;
	question: string;
	answer?: string;
	context?: string;
	norms: {
		citations_raw: string[];
		boe_a_ids: string[];
		citations?: Array<{ raw: string; boe_a_id: string | null; article: string | null }>;
	};
	metadata: {
		domain?: string;
		jurisdiction?: string;
		organo?: string;
		difficulty?: string;
		date?: string;
	};
}

// ── Stratified sampling ───────────────────────────────────────────────────────

/**
 * Stratified sampling by a string key (e.g. organo).
 * Distributes quota proportionally across strata, then fills remainder.
 * Deterministic given the seed.
 */
function stratifiedSample<T>(
	items: T[],
	keyFn: (item: T) => string,
	n: number,
	rng: () => number,
): T[] {
	// Group by key
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const k = keyFn(item);
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k)!.push(item);
	}

	// Sort groups by key for determinism
	const sortedKeys = [...groups.keys()].sort();

	// Proportional allocation (floor) — then fill remainder from largest groups
	const total = items.length;
	const quotas = new Map<string, number>();
	let allocated = 0;
	for (const k of sortedKeys) {
		const g = groups.get(k)!;
		const q = Math.floor((g.length / total) * n);
		quotas.set(k, q);
		allocated += q;
	}

	// Distribute remainder (descending group size)
	const bySize = [...sortedKeys].sort(
		(a, b) => groups.get(b)!.length - groups.get(a)!.length,
	);
	let remainder = n - allocated;
	for (const k of bySize) {
		if (remainder <= 0) break;
		const maxAdd = groups.get(k)!.length - quotas.get(k)!;
		const add = Math.min(maxAdd, 1);
		quotas.set(k, quotas.get(k)! + add);
		remainder -= add;
	}

	// Sample from each stratum
	const result: T[] = [];
	for (const k of sortedKeys) {
		const g = groups.get(k)!;
		const q = Math.min(quotas.get(k)!, g.length);
		// Shuffle then take first q
		const shuffled = [...g];
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
		}
		result.push(...shuffled.slice(0, q));
	}

	return result;
}

/**
 * Simple random sample without replacement.
 */
function randomSample<T>(items: T[], n: number, rng: () => number): T[] {
	const shuffled = [...items];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
	}
	return shuffled.slice(0, Math.min(n, shuffled.length));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	const rng = mulberry32(SEED);
	const allEntries: BaselineEntry[] = [];
	const heldoutNormIds = new Set<string>();

	let totalDropped = 0;

	for (const plan of PLAN) {
		const path = `${ENRICHED_DIR}/${plan.file}`;
		console.log(`[build] Loading ${plan.source} from ${path}…`);

		// Load all eligible entries
		const eligible: RawEntry[] = [];
		let total = 0;
		let dropped = 0;

		for await (const row of readJsonl<RawEntry>(path)) {
			total++;
			if (!row.norms?.boe_a_ids?.length) {
				dropped++;
				continue;
			}
			if (!row.question?.trim()) {
				dropped++;
				continue;
			}
			eligible.push(row);
		}

		console.log(
			`  ${plan.source}: ${total} total, ${eligible.length} eligible, ${dropped} dropped (no boe_a_ids)`,
		);
		totalDropped += dropped;

		// Sample
		let sampled: RawEntry[];
		if (plan.stratifyBy === "organo") {
			sampled = stratifiedSample(
				eligible,
				(e) => e.metadata?.organo ?? "UNKNOWN",
				plan.n,
				rng,
			);
		} else {
			sampled = randomSample(eligible, plan.n, rng);
		}

		console.log(`  Sampled: ${sampled.length} (target ${plan.n})`);

		// Convert to BaselineEntry (drop answer/context from output)
		for (const raw of sampled) {
			const entry: BaselineEntry = {
				id: raw.id,
				source: raw.source,
				question: raw.question,
				expected_norm_ids: raw.norms.boe_a_ids,
				// QAEntry-compatible norms blob required by harness.ts
				norms: {
					citations_raw: raw.norms.citations_raw ?? [],
					boe_a_ids: raw.norms.boe_a_ids,
				},
				answer: "(eval-only entry — answer not included)", // placeholder
				metadata: {
					...(raw.metadata.domain && { domain: raw.metadata.domain }),
					...(raw.metadata.jurisdiction && { jurisdiction: raw.metadata.jurisdiction }),
					...(raw.metadata.organo && { organo: raw.metadata.organo }),
					...(raw.metadata.difficulty && { difficulty: raw.metadata.difficulty }),
					...(raw.metadata.date && { date: raw.metadata.date }),
				},
			};
			allEntries.push(entry);
			for (const id of raw.norms.boe_a_ids) {
				heldoutNormIds.add(id);
			}
		}
	}

	// Sanity: check for duplicate IDs
	const ids = allEntries.map((e) => e.id);
	const uniqueIds = new Set(ids);
	if (uniqueIds.size < ids.length) {
		console.warn(`[build] WARNING: ${ids.length - uniqueIds.size} duplicate IDs found — deduplicating`);
		const seen = new Set<string>();
		const deduped = allEntries.filter((e) => {
			if (seen.has(e.id)) return false;
			seen.add(e.id);
			return true;
		});
		allEntries.splice(0, allEntries.length, ...deduped);
	}

	console.log(`\n[build] Total sampled: ${allEntries.length} entries`);
	console.log(`[build] Unique expected norm IDs: ${heldoutNormIds.size}`);
	console.log(`[build] Total dropped (no ground truth): ${totalDropped}`);

	// Write eval JSONL
	const evalLines = allEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	writeFileSync(EVAL_OUT, evalLines, "utf8");
	console.log(`\n[build] Written: ${EVAL_OUT}`);

	// Write heldout norms
	const heldout = {
		description:
			"Union of all boe_a_ids referenced in baseline-eval-v1.jsonl. " +
			"These norm IDs are 'seen' during eval; any future fine-tuning pipeline " +
			"MUST exclude these norms from the training corpus to avoid contamination. " +
			"Generated by packages/eval/src/sources/build-baseline-eval-v1.ts on " +
			new Date().toISOString().slice(0, 10) +
			". Seed: 42.",
		generated_at: new Date().toISOString(),
		seed: SEED,
		eval_count: allEntries.length,
		norm_ids: [...heldoutNormIds].sort(),
	};
	writeFileSync(HELDOUT_OUT, JSON.stringify(heldout, null, 2), "utf8");
	console.log(`[build] Written: ${HELDOUT_OUT}`);

	// Per-source breakdown
	console.log("\n[build] Source breakdown:");
	const bySource = new Map<string, number>();
	for (const e of allEntries) {
		bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
	}
	for (const [src, n] of [...bySource.entries()].sort()) {
		console.log(`  ${src}: ${n}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
