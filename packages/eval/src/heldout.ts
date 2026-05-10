/**
 * Held-out human eval set.
 *
 * Carves 50 questions out of v3-seeds.json (25 citizen + 25 formal-RAG)
 * stratified by materia. These are sacred:
 *   - their seed norms must NEVER appear as sample seeds during agentic
 *     generation (the sampler reads `heldoutNormIds()` and excludes them);
 *   - the judges must NEVER see them during prompt calibration;
 *   - they are the final external test of dataset quality
 *     (Spearman of R@K human vs R@K agent ≥ 0.7 is the gate).
 *
 * Selection is deterministic: sorted by id, then a fixed-seed PRNG picks
 * within each materia bucket so that repeat runs yield the same set.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { Dataset, EvalQuestion, Voice } from "./schema.ts";

const SEEDS_PATH = "packages/eval/datasets/seeds/v3-seeds.json";
const HELDOUT_PATH = "packages/eval/datasets/heldout/human-50.json";
const REMAINING_PATH =
	"packages/eval/datasets/seeds/v3-seeds-after-heldout.json";
const RNG_SEED = 0x1ea2026; // stable, fixed across runs ("LeyA" + year)

/** Mulberry32, seeded. Deterministic across machines. */
function mulberry32(a: number): () => number {
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pickStratified(
	pool: EvalQuestion[],
	target: number,
	rng: () => number,
): EvalQuestion[] {
	// Group by materia, then round-robin pick from largest buckets first
	// until we hit target, shuffling inside each bucket.
	const byMateria = new Map<string, EvalQuestion[]>();
	for (const q of pool) {
		const arr = byMateria.get(q.materia) ?? [];
		arr.push(q);
		byMateria.set(q.materia, arr);
	}
	for (const arr of byMateria.values()) {
		arr.sort((a, b) => a.id.localeCompare(b.id));
		// Fisher-Yates with seeded RNG
		for (let i = arr.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[arr[i], arr[j]] = [arr[j]!, arr[i]!];
		}
	}

	const buckets = [...byMateria.entries()].sort(
		(a, b) => b[1].length - a[1].length,
	);
	const picked: EvalQuestion[] = [];
	let bucketIdx = 0;
	while (picked.length < target) {
		const drained = buckets.every(([, arr]) => arr.length === 0);
		if (drained) break;
		const [, arr] = buckets[bucketIdx % buckets.length]!;
		if (arr.length > 0) picked.push(arr.shift()!);
		bucketIdx++;
	}
	return picked;
}

export function carveHeldout(opts: { citizen: number; formal: number }): {
	heldout: Dataset;
	remaining: Dataset;
} {
	const ds = JSON.parse(readFileSync(SEEDS_PATH, "utf8")) as Dataset;
	const rng = mulberry32(RNG_SEED);

	const citizenPool = ds.questions.filter((q) => q.voice === "citizen");
	const formalPool = ds.questions.filter((q) => q.voice === "formal");
	const heldoutCitizen = pickStratified(citizenPool, opts.citizen, rng);
	const heldoutFormal = pickStratified(formalPool, opts.formal, rng);
	const heldoutQs = [...heldoutCitizen, ...heldoutFormal];
	const heldoutIds = new Set(heldoutQs.map((q) => q.id));

	const remainingQs = ds.questions.filter((q) => !heldoutIds.has(q.id));

	const buildMeta = (
		qs: EvalQuestion[],
		description: string,
	): Dataset["meta"] => {
		const byVoice: Record<Voice, number> = { citizen: 0, formal: 0 };
		for (const q of qs) byVoice[q.voice]++;
		const byMateria: Record<string, number> = {};
		const byJurisdiction: Record<string, number> = {};
		const bySource: Record<string, number> = {
			"human-citizen": 0,
			"human-rag": 0,
			"agent-generated": 0,
		};
		for (const q of qs) {
			byMateria[q.materia] = (byMateria[q.materia] ?? 0) + 1;
			byJurisdiction[q.jurisdiction] =
				(byJurisdiction[q.jurisdiction] ?? 0) + 1;
			bySource[q.provenance.source] = (bySource[q.provenance.source] ?? 0) + 1;
		}
		return {
			version: 3,
			createdAt: new Date().toISOString(),
			description,
			totalQuestions: qs.length,
			bySource: bySource as Dataset["meta"]["bySource"],
			byVoice,
			bySplit: { train: qs.length, val: 0, test: 0 },
			byMateria,
			byJurisdiction,
		};
	};

	return {
		heldout: {
			meta: buildMeta(
				heldoutQs,
				`Held-out human eval set (${opts.citizen} citizen + ${opts.formal} formal). Stratified by materia, seeded RNG. NEVER use these norm IDs as agentic seeds and NEVER show them to judges during calibration.`,
			),
			questions: heldoutQs,
		},
		remaining: {
			meta: buildMeta(
				remainingQs,
				"Human seeds remaining after held-out carve. Available for prompt calibration, generator seeding, and article-level annotation.",
			),
			questions: remainingQs,
		},
	};
}

export function heldoutNormIds(): Set<string> {
	const ds = JSON.parse(readFileSync(HELDOUT_PATH, "utf8")) as Dataset;
	const out = new Set<string>();
	for (const q of ds.questions) for (const n of q.expectedNorms) out.add(n);
	return out;
}

if (import.meta.main) {
	const { heldout, remaining } = carveHeldout({ citizen: 25, formal: 25 });
	writeFileSync(HELDOUT_PATH, `${JSON.stringify(heldout, null, "\t")}\n`);
	writeFileSync(REMAINING_PATH, `${JSON.stringify(remaining, null, "\t")}\n`);
	console.log(`Held-out: ${heldout.questions.length} → ${HELDOUT_PATH}`);
	console.log(`Remaining: ${remaining.questions.length} → ${REMAINING_PATH}`);
	console.log("Held-out by materia:", heldout.meta.byMateria);
}
