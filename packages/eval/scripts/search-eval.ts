/**
 * Search quality harness — measures R@1, R@5, MRR and latency of the public
 * search endpoint against a labelled query set.
 *
 * WHY THIS EXISTS
 *
 * Search quality was being reasoned about from numbers that did not describe
 * the running system. The often-quoted "BM25 gives R@5 = 2%" figure came from
 * `DbService.searchLaws`, the pure-BM25 path — but `GET /v1/laws` has not used
 * that path for relevance queries in a while: `routes/laws.ts` routes them to
 * `searchLawsHybrid` (BM25 + embeddings) and returns 503 rather than falling
 * back. Measured end to end, production scores R@5 ≈ 49%, not 5.6%.
 *
 * A ranking change was designed, implemented and evaluated against the wrong
 * path before anyone noticed. This script exists so that does not happen
 * again: it hits the same HTTP endpoint a citizen's browser hits, so whatever
 * it reports is what users actually get — caching, reranking, filters and all.
 *
 * Usage:
 *   bun run packages/eval/scripts/search-eval.ts
 *   bun run packages/eval/scripts/search-eval.ts --n 200 --dataset citizen-queries-v3-500.json
 *   bun run packages/eval/scripts/search-eval.ts --endpoint http://localhost:3000
 *   bun run packages/eval/scripts/search-eval.ts --json results.json
 *
 * Options:
 *   --endpoint <url>   API base URL (default: https://api.leyabierta.es)
 *   --dataset <file>   file under packages/api/research/datasets/
 *   --n <count>        how many queries to run (default: 100)
 *   --delay <ms>       pause between requests (default: 150)
 *   --limit <k>        results requested per query (default: 10)
 *   --json <path>      also write the full per-query breakdown as JSON
 *
 * On rate limiting: the public API rate-limits, and a too-eager run gets 429s
 * that look exactly like failures. Those are reported separately from real
 * errors — do not read them as the service being broken. Raise --delay
 * instead of drawing conclusions from them.
 */

import { join } from "node:path";

interface LabelledQuery {
	id?: string;
	question: string;
	expectedNorms: string[];
	category?: string;
	difficulty?: string;
}

interface QueryOutcome {
	question: string;
	expected: string[];
	returned: string[];
	/** 0-based position of the first expected norm, or -1 if absent. */
	hitAt: number;
	latencyMs: number;
	status: number;
}

const DATASET_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"api",
	"research",
	"datasets",
);

function arg(name: string, fallback?: string): string | undefined {
	const i = Bun.argv.indexOf(`--${name}`);
	return i !== -1 && Bun.argv[i + 1] ? Bun.argv[i + 1] : fallback;
}

const endpoint = (
	arg("endpoint", "https://api.leyabierta.es") as string
).replace(/\/$/, "");
const datasetName = arg("dataset", "citizen-queries-v3-500.json") as string;
const count = Number(arg("n", "100"));
const delayMs = Number(arg("delay", "150"));
const limit = Number(arg("limit", "10"));
const jsonOut = arg("json");

const raw = JSON.parse(await Bun.file(join(DATASET_DIR, datasetName)).text()) as
	| { results?: LabelledQuery[] }
	| LabelledQuery[];

const queries = (Array.isArray(raw) ? raw : (raw.results ?? []))
	.filter((q) => q.question && q.expectedNorms?.length)
	.slice(0, count);

if (queries.length === 0) {
	console.error(`No labelled queries found in ${datasetName}`);
	process.exit(2);
}

console.log(
	`Evaluating ${queries.length} queries against ${endpoint} (dataset: ${datasetName})\n`,
);

const outcomes: QueryOutcome[] = [];
let rateLimited = 0;
let failed = 0;

for (const [i, q] of queries.entries()) {
	const url = `${endpoint}/v1/laws?q=${encodeURIComponent(q.question)}&limit=${limit}`;
	const started = performance.now();
	let status = 0;
	let returned: string[] = [];

	try {
		const res = await fetch(url);
		status = res.status;
		if (res.status === 429) {
			rateLimited++;
		} else if (!res.ok) {
			failed++;
		} else {
			const body = (await res.json()) as { data?: Array<{ id: string }> };
			returned = (body.data ?? []).map((l) => l.id);
		}
	} catch {
		failed++;
	}

	const latencyMs = performance.now() - started;

	if (status === 200) {
		const expected = new Set(q.expectedNorms);
		outcomes.push({
			question: q.question,
			expected: q.expectedNorms,
			returned,
			hitAt: returned.findIndex((id) => expected.has(id)),
			latencyMs,
			status,
		});
	}

	if ((i + 1) % 25 === 0) {
		process.stdout.write(`  ...${i + 1}/${queries.length}\n`);
	}
	await Bun.sleep(delayMs);
}

const n = outcomes.length;
if (n === 0) {
	console.error(
		`\nEvery request failed (${rateLimited} rate-limited, ${failed} errored). ` +
			"Nothing to report — check the endpoint before reading anything into this.",
	);
	process.exit(1);
}

const recallAt = (k: number) =>
	outcomes.filter((o) => o.hitAt >= 0 && o.hitAt < k).length / n;
const mrr =
	outcomes.reduce((s, o) => s + (o.hitAt >= 0 ? 1 / (o.hitAt + 1) : 0), 0) / n;

const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
const pct = (p: number) =>
	Math.round(latencies[Math.floor(latencies.length * p)] ?? 0);

console.log(`\n=== Search quality — n=${n} ===`);
console.log(`R@1   ${(100 * recallAt(1)).toFixed(1)}%`);
console.log(`R@5   ${(100 * recallAt(5)).toFixed(1)}%`);
console.log(`R@10  ${(100 * recallAt(10)).toFixed(1)}%`);
console.log(`MRR   ${mrr.toFixed(4)}`);
console.log(
	`\nLatency  p50 ${pct(0.5)}ms · p95 ${pct(0.95)}ms · max ${Math.round(latencies.at(-1) ?? 0)}ms`,
);
console.log(
	"  (a warm LRU cache makes repeated runs much faster than a cold one — " +
		"compare like with like)",
);

if (rateLimited > 0 || failed > 0) {
	console.log(
		`\nExcluded: ${rateLimited} rate-limited (429), ${failed} errored. ` +
			`Rate limiting is this script's own pacing, not a service fault — raise --delay.`,
	);
}

const misses = outcomes.filter((o) => o.hitAt < 0);
if (misses.length > 0) {
	console.log(
		`\n=== ${misses.length} complete misses (expected norm absent) ===`,
	);
	for (const m of misses.slice(0, 10)) {
		console.log(`  "${m.question.slice(0, 72)}"`);
		console.log(`      expected: ${m.expected.slice(0, 3).join(", ")}`);
		console.log(
			`      returned: ${m.returned.slice(0, 3).join(", ") || "(nothing)"}`,
		);
	}
	if (misses.length > 10) console.log(`  ... and ${misses.length - 10} more`);
}

if (jsonOut) {
	await Bun.write(
		jsonOut,
		JSON.stringify(
			{
				endpoint,
				dataset: datasetName,
				n,
				rateLimited,
				failed,
				metrics: {
					r_at_1: recallAt(1),
					r_at_5: recallAt(5),
					r_at_10: recallAt(10),
					mrr,
				},
				latency: { p50: pct(0.5), p95: pct(0.95) },
				outcomes,
			},
			null,
			2,
		),
	);
	console.log(`\nFull breakdown written to ${jsonOut}`);
}
