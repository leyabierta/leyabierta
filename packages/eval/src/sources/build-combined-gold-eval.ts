/**
 * Combine the best gold-eval candidate subsets into a single dataset for the
 * definitive Qwen-NaN vs Gemini A/B over TRUSTED data (not the v3-1000 noisy
 * synthetic).
 *
 * Composition (default):
 *   - DGT-141 (regex-only, excludes the 6 LLM-recovery — they had R@1=16.7%)
 *   - Justicio Código Civil (n=61) — best calibrated subset
 *   - Justicio Ley Vivienda (n=44) — keep with strict-matching caveat
 *   - Justicio Constitución sub-sample (n=50 random from 515) — control
 *   - ask_log (n=87) — real prod queries, lenient many-norm matching
 *
 * Each entry preserves a `source.origin` field so per-source breakdowns
 * remain available after running through eval-prod-replica.
 *
 * Usage:
 *   bun packages/api/research/ab/build-combined-gold-eval.ts \
 *     [--constitution-sample 50] \
 *     [--out packages/api/research/datasets/gold-eval-combined.json]
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

const constitutionSample = Number(flag("constitution-sample") ?? "50");
const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(repoRoot, "packages/api/research/datasets/gold-eval-combined.json");

interface Entry {
	id: string;
	question: string;
	expectedNorms: string[];
	category?: string | null;
	source: { origin: string; [k: string]: unknown };
}

function shuffle<T>(arr: T[]): T[] {
	const x = [...arr];
	for (let i = x.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[x[i], x[j]] = [x[j]!, x[i]!];
	}
	return x;
}

// 1. DGT — keep only regex-mapped (drop the 6 llm-recovery)
const dgt = (await Bun.file(
	join(repoRoot, "packages/api/research/datasets/gold-eval-dgt-enriched.json"),
).json()) as {
	results: Array<
		Entry & { source: { origin: string; mappingMethod?: string } }
	>;
};
const dgtRegex = dgt.results.filter((r) => r.source.mappingMethod === "regex");
console.log(
	`DGT regex-only: ${dgtRegex.length} (dropped ${dgt.results.length - dgtRegex.length} llm-recovery)`,
);

// 2. Justicio — split by norm
const justicio = (await Bun.file(
	join(repoRoot, "packages/api/research/datasets/gold-eval-justicio.json"),
).json()) as { results: Entry[] };

const justByNorm: Record<string, Entry[]> = {};
for (const e of justicio.results) {
	const n = e.expectedNorms[0]!;
	(justByNorm[n] ||= []).push(e);
}
const justCC = justByNorm["BOE-A-1889-4763"] ?? [];
const justViv = justByNorm["BOE-A-2023-12203"] ?? [];
const justConst = shuffle(justByNorm["BOE-A-1978-31229"] ?? []).slice(
	0,
	constitutionSample,
);
console.log(
	`Justicio: CC=${justCC.length}, Vivienda=${justViv.length}, Constitución=${justConst.length} (sampled from ${(justByNorm["BOE-A-1978-31229"] ?? []).length})`,
);

// 3. ask_log
const asklog = (await Bun.file(
	join(
		repoRoot,
		"packages/api/research/datasets/gold-eval-asklog-candidates.json",
	),
).json()) as {
	results: Array<{
		id: string;
		question: string;
		expectedNorms: string[];
		category: string | null;
		source?: Record<string, unknown>;
	}>;
};
const asklogNormalized: Entry[] = asklog.results.map((e) => ({
	id: e.id,
	question: e.question,
	expectedNorms: e.expectedNorms,
	category: e.category,
	source: { origin: "asklog", ...(e.source ?? {}) },
}));
console.log(`ask_log: ${asklogNormalized.length}`);

// 4. Tag each entry with its origin and combine
function tag(entries: Entry[], origin: string): Entry[] {
	return entries.map((e) => ({
		...e,
		source: { ...e.source, origin },
	}));
}

const combined: Entry[] = [
	...tag(dgtRegex, "dgt-regex"),
	...tag(justCC, "justicio-codigo-civil"),
	...tag(justViv, "justicio-vivienda"),
	...tag(justConst, "justicio-constitucion"),
	...tag(asklogNormalized, "asklog"),
];

// Dedup by question text (in case of overlap across sources)
const seen = new Set<string>();
const dedup: Entry[] = [];
let droppedDup = 0;
for (const e of combined) {
	const key = e.question.toLowerCase().replace(/\s+/g, " ").trim();
	if (seen.has(key)) {
		droppedDup++;
		continue;
	}
	seen.add(key);
	dedup.push(e);
}

console.log(`\nCombined: ${dedup.length} entries (dropped ${droppedDup} dup)`);

// Stats
const byOrigin: Record<string, number> = {};
for (const e of dedup)
	byOrigin[String(e.source.origin)] =
		(byOrigin[String(e.source.origin)] ?? 0) + 1;
console.log(`By origin:`, byOrigin);

await Bun.write(outPath, JSON.stringify({ results: dedup }, null, 2));
console.log(`\nWrote → ${outPath}`);
