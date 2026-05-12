/**
 * One-shot helper: merge a "recovered" Gemini pass file (containing the 468
 * re-run queries) into the original 1000-entry Gemini pass file.
 *
 * Usage:
 *   bun packages/api/research/ab/merge-gemini-recovery.ts \
 *     --original data/ab-results/eval-pass-gemini-baseline.json.original-1000 \
 *     --recovery data/ab-results/eval-pass-gemini-baseline.json \
 *     --out      data/ab-results/eval-pass-gemini-baseline.json
 *
 * The original is the backup of the 1000-entry pass file (with 468 broken).
 * The recovery is the freshly-saved pass file from re-running --only-gemini on
 * the 468-subset (overwrites the original location if not backed up first).
 * For each id in the recovery file, replace the matching entry in the original.
 * If the recovery still has empty topNormIds for a query, prefer the recovery
 * (we tried). Write the merged 1000-entry result to --out.
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

const originalPath = flag("original")
	? resolvePath(flag("original")!)
	: join(
			repoRoot,
			"data/ab-results/eval-pass-gemini-baseline.json.original-1000",
		);
const recoveryPath = flag("recovery")
	? resolvePath(flag("recovery")!)
	: join(repoRoot, "data/ab-results/eval-pass-gemini-baseline.json");
const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(repoRoot, "data/ab-results/eval-pass-gemini-baseline.json");

interface PassEntry {
	id: string | number;
	topNormIds: string[];
	[k: string]: unknown;
}
interface PassFile {
	dims: number;
	total: number;
	results: PassEntry[];
}

const original = (await Bun.file(originalPath).json()) as PassFile;
const recovery = (await Bun.file(recoveryPath).json()) as PassFile;

console.log(`Original: ${original.results.length} entries`);
console.log(`Recovery: ${recovery.results.length} entries`);

const recoveryById = new Map<string, PassEntry>();
for (const r of recovery.results) recoveryById.set(String(r.id), r);

let replaced = 0;
let stillEmpty = 0;
const merged = original.results.map((entry) => {
	const id = String(entry.id);
	const recov = recoveryById.get(id);
	if (recov) {
		replaced++;
		if (!recov.topNormIds || recov.topNormIds.length === 0) stillEmpty++;
		return recov;
	}
	return entry;
});

console.log(`Replaced: ${replaced}`);
console.log(`Still empty after recovery: ${stillEmpty}`);

await Bun.write(
	outPath,
	JSON.stringify(
		{ dims: original.dims, total: original.total, results: merged },
		null,
		2,
	),
);
console.log(`Wrote merged → ${outPath}`);
