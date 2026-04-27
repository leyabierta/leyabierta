/**
 * Merge the 4 generated eval slices with the existing 65-question omnibus
 * into a single eval-v2.json file consumed by `eval-gate.ts`.
 *
 * Output:
 *   data/eval-v2.json          — full set, 205 questions
 *   data/eval-v2-holdout.json  — 50 questions held out (subset of new 140)
 *
 * IDs:
 *   - Existing 65 keep their original IDs (1-65, plus a few in 700s/800s).
 *   - 140 newly generated questions are renumbered to 1000-1139 to avoid
 *     collisions with the omnibus set (which sparsely uses 101-105, 201-203, 7xx, 8xx).
 *
 * Run: `bun packages/api/research/build-eval-v2.ts`
 */

import { join } from "node:path";

type EvalQuestion = {
	id: number;
	question: string;
	category: string;
	expectedNorms: string[];
	rationale?: string;
	obsoleteNorms?: string[];
	slice?: string;
};

const repoRoot = join(import.meta.dir, "../../../");
const dataDir = join(repoRoot, "data");
const datasetsDir = join(repoRoot, "packages/api/research/datasets");

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await Bun.file(path).text()) as T;
}

const existing = await readJson<{ results: EvalQuestion[] }>(
	join(dataDir, "eval-answers-504-omnibus.json"),
);

const slices = ["autonomic", "materias", "temporal", "procedural"];
const generated: EvalQuestion[] = [];
for (const slice of slices) {
	const file = await readJson<{ slice: string; questions: EvalQuestion[] }>(
		join(datasetsDir, `eval-v2-${slice}.json`),
	);
	for (const q of file.questions) generated.push({ ...q, slice: file.slice });
}

console.log(`existing: ${existing.results.length}`);
console.log(`generated: ${generated.length}`);

// Strip everything except eval-gate-relevant fields from existing
const existingClean = existing.results.map((q) => ({
	id: q.id,
	question: q.question,
	category: q.category,
	expectedNorms: q.expectedNorms,
	source: "omnibus-2025",
}));

// Renumber generated to 1000+ to avoid collisions
const generatedRenumbered = generated.map((q, i) => ({
	id: 1000 + i,
	question: q.question,
	category: q.category,
	expectedNorms: q.expectedNorms,
	rationale: q.rationale,
	obsoleteNorms: q.obsoleteNorms,
	slice: q.slice,
	source: "eval-v2-generated-2026-04-27",
}));

// Holdout: deterministic 50 from generated, stratified by slice (~12-13 per slice).
const bySlice: Record<string, typeof generatedRenumbered> = {};
for (const q of generatedRenumbered) {
	const s = q.slice ?? "unknown";
	(bySlice[s] ??= []).push(q);
}

const holdoutIds = new Set<number>();
const sliceNames = Object.keys(bySlice).sort();
const perSlice = Math.floor(50 / sliceNames.length); // 12
const remainder = 50 % sliceNames.length; // 2
for (let i = 0; i < sliceNames.length; i++) {
	const take = perSlice + (i < remainder ? 1 : 0);
	const pool = bySlice[sliceNames[i]!]!;
	// Deterministic: take every Nth item evenly distributed
	const step = Math.max(1, Math.floor(pool.length / take));
	for (let k = 0; k < take && k * step < pool.length; k++) {
		holdoutIds.add(pool[k * step]!.id);
	}
}

const all = [...existingClean, ...generatedRenumbered];
const holdout = generatedRenumbered.filter((q) => holdoutIds.has(q.id));
const trainDev = all.filter((q) => !holdoutIds.has(q.id));

const output = {
	version: "v2",
	generated_at: "2026-04-27",
	total: all.length,
	results: all,
};

const outputTrainDev = {
	version: "v2",
	subset: "train-dev",
	generated_at: "2026-04-27",
	total: trainDev.length,
	holdout_excluded: holdout.length,
	results: trainDev,
};

const outputHoldout = {
	version: "v2",
	subset: "holdout",
	generated_at: "2026-04-27",
	notes:
		"50 questions never to be used during fine-tuning, prompt iteration, or hyperparameter search. Touch only for final validation.",
	total: holdout.length,
	results: holdout,
};

await Bun.write(join(dataDir, "eval-v2.json"), JSON.stringify(output, null, 2));
await Bun.write(
	join(dataDir, "eval-v2-train-dev.json"),
	JSON.stringify(outputTrainDev, null, 2),
);
await Bun.write(
	join(dataDir, "eval-v2-holdout.json"),
	JSON.stringify(outputHoldout, null, 2),
);

console.log(`\nWrote:`);
console.log(`  data/eval-v2.json (${all.length} questions, full set)`);
console.log(
	`  data/eval-v2-train-dev.json (${trainDev.length} questions, train/dev)`,
);
console.log(
	`  data/eval-v2-holdout.json (${holdout.length} questions, holdout)`,
);

// Sanity report
const byCategory: Record<string, number> = {};
const bySliceFinal: Record<string, number> = {};
for (const q of all) {
	byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;
	const s = (q as { slice?: string }).slice ?? "omnibus";
	bySliceFinal[s] = (bySliceFinal[s] ?? 0) + 1;
}
console.log(`\nBy category:`, byCategory);
console.log(`By slice:`, bySliceFinal);

const noExpected = all.filter((q) => q.expectedNorms.length === 0).length;
console.log(
	`\nQuestions with empty expectedNorms (out-of-scope): ${noExpected}`,
);
