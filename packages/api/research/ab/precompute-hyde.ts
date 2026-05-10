/**
 * Pre-compute HyDE rewrites for all 50 citizen-queries via qwen3.6 (NaN).
 * Saves to JSON cache so eval runs deterministically without per-pass LLM calls.
 */

import { join } from "node:path";
import { hydeRewrite } from "./hyde-rewrite.ts";

const apiKey = process.env.HERMES_API_KEY;
if (!apiKey) {
	console.error("HERMES_API_KEY required");
	process.exit(1);
}

const repoRoot = join(import.meta.dir, "../../../../");
const evalPath = join(
	repoRoot,
	"packages/api/research/datasets/citizen-queries.json",
);
const outPath = join(repoRoot, "data/ab-results/hyde-cache.json");

const evalData = (await Bun.file(evalPath).json()) as {
	results: Array<{ id: number; question: string; expectedNorms?: string[] }>;
};
const questions = evalData.results.filter(
	(r) => (r.expectedNorms?.length ?? 0) > 0,
);
console.log(`Precomputing HyDE for ${questions.length} queries...`);

// Resume support
let cache: Record<string, string> = {};
const cacheFile = Bun.file(outPath);
if (await cacheFile.exists()) {
	cache = (await cacheFile.json()) as Record<string, string>;
	console.log(`  Loaded ${Object.keys(cache).length} cached rewrites`);
}

const startedAt = Date.now();
let done = 0;
for (const q of questions) {
	if (cache[q.question]) {
		done++;
		continue;
	}
	try {
		const rewrite = await hydeRewrite(apiKey, q.question);
		cache[q.question] = rewrite;
		done++;
		const elapsed = (Date.now() - startedAt) / 1000;
		const rate = done / Math.max(elapsed, 0.1);
		process.stdout.write(
			`\r  ${done}/${questions.length} — ${rate.toFixed(2)}/s   `,
		);
		// Save incrementally every 5 queries
		if (done % 5 === 0) {
			await Bun.write(outPath, JSON.stringify(cache, null, 2));
		}
	} catch (err) {
		console.warn(`\n  Failed q${q.id}: ${err instanceof Error ? err.message : err}`);
	}
}

await Bun.write(outPath, JSON.stringify(cache, null, 2));
console.log(`\n✅ Saved ${Object.keys(cache).length} rewrites → ${outPath}`);
