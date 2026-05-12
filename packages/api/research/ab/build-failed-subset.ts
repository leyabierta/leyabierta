/**
 * One-shot helper: extract the queries from citizen-queries-v3-1000.json whose
 * eval-pass-gemini-baseline.json entries have empty topNormIds (embed failed
 * upstream in the original run). Writes a small subset dataset so we can
 * re-run --only-gemini against just those.
 */

import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../../");
const passFile = join(repoRoot, "data/ab-results/eval-pass-gemini-baseline.json");
const datasetFile = join(
	repoRoot,
	"packages/api/research/datasets/citizen-queries-v3-1000.json",
);
const outFile = join(
	repoRoot,
	"packages/api/research/datasets/citizen-queries-v3-failed468.json",
);

interface PassEntry {
	id: string | number;
	topNormIds: string[];
}
interface DatasetEntry {
	id: string | number;
	question: string;
	expectedNorms?: string[];
	category?: string;
}

const pass = (await Bun.file(passFile).json()) as {
	dims: number;
	total: number;
	results: PassEntry[];
};
const dataset = (await Bun.file(datasetFile).json()) as {
	results: DatasetEntry[];
};

const failedIds = new Set(
	pass.results
		.filter((r) => !r.topNormIds || r.topNormIds.length === 0)
		.map((r) => String(r.id)),
);
console.log(`Failed entries (empty topNormIds): ${failedIds.size}`);

const subset = dataset.results.filter((q) => failedIds.has(String(q.id)));
console.log(`Matched in dataset: ${subset.length}`);

await Bun.write(outFile, JSON.stringify({ results: subset }, null, 2));
console.log(`Wrote ${subset.length} queries → ${outFile}`);
