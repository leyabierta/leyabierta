/**
 * Build an eval dataset compatible with eval-prod-replica.ts / eval-synthesis.ts
 * from the v3 synthetic-question pipeline (packages/eval/datasets/v3/accepted-*.jsonl).
 *
 * Reads every `accepted-*.jsonl` under the v3 datasets dir, optionally filters
 * to the queries that are fully covered by the current qwen3-nan embedding
 * store, and writes a single JSON file with shape:
 *
 *   { results: [{ id, question, expectedNorms, category }] }
 *
 * Usage:
 *   bun packages/api/research/ab/build-eval-from-v3.ts \
 *     [--out packages/api/research/datasets/citizen-queries-v3.json] \
 *     [--no-coverage-filter] \
 *     [--limit N] \
 *     [--include-borderline]
 */

import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}
const noCoverageFilter = args.includes("--no-coverage-filter");
const includeBorderline = args.includes("--include-borderline");
const limitArg = flag("limit");
const limit = limitArg ? Number(limitArg) : undefined;

const repoRoot = join(import.meta.dir, "../../../../");
const v3Dir = join(repoRoot, "packages/eval/datasets/v3");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const outPath =
	flag("out") ??
	join(repoRoot, "packages/api/research/datasets/citizen-queries-v3.json");

// ── Schema of a v3 record (subset we care about) ──
interface V3Record {
	id: string;
	question: string;
	expectedNorms: string[];
	voice?: string;
	materia?: string;
	jurisdiction?: string;
	difficulty?: string;
	split?: string;
}

// ── Collect candidate JSONL files ──
const entries = await readdir(v3Dir);
const files = entries
	.filter((f) => {
		if (!f.endsWith(".jsonl")) return false;
		if (f.startsWith("accepted-")) return true;
		if (includeBorderline && f.startsWith("borderline-")) return true;
		return false;
	})
	.map((f) => join(v3Dir, f));

if (files.length === 0) {
	console.error(`No accepted JSONL files in ${v3Dir}`);
	process.exit(1);
}
console.log(`Reading ${files.length} JSONL file(s) from ${v3Dir}`);

// ── Read all records ──
const allRecords: V3Record[] = [];
for (const f of files) {
	const text = await Bun.file(f).text();
	if (!text.trim()) continue;
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	for (const line of lines) {
		try {
			const rec = JSON.parse(line) as V3Record;
			if (
				rec.id &&
				rec.question &&
				Array.isArray(rec.expectedNorms) &&
				rec.expectedNorms.length > 0
			) {
				allRecords.push(rec);
			}
		} catch (err) {
			console.warn(
				`  Skipping malformed line in ${f}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
console.log(`Loaded ${allRecords.length} raw records`);

// ── Dedup by id (in case of overlap across runs) ──
const byId = new Map<string, V3Record>();
for (const r of allRecords) byId.set(r.id, r);
const deduped = [...byId.values()];
console.log(`Deduped: ${deduped.length} unique records`);

// ── Coverage filter (against qwen3-nan store) ──
let filtered = deduped;
if (!noCoverageFilter) {
	const db = new Database(dbPath, { readonly: true });
	const covered = new Set(
		db
			.query<{ norm_id: string }, [string]>(
				"SELECT DISTINCT norm_id FROM embeddings WHERE model = ?",
			)
			.all("qwen3-nan")
			.map((r) => r.norm_id),
	);
	db.close();

	const before = filtered.length;
	filtered = filtered.filter((r) =>
		r.expectedNorms.every((n) => covered.has(n)),
	);
	console.log(
		`Coverage filter (qwen3-nan haystack, ${covered.size} norms): ${filtered.length} / ${before} kept`,
	);
}

// ── Apply limit ──
if (limit && limit > 0 && filtered.length > limit) {
	filtered = filtered.slice(0, limit);
	console.log(`Trimmed to first ${limit} records`);
}

// ── Emit ──
interface EvalQueryOut {
	id: string;
	question: string;
	expectedNorms: string[];
	category: string;
	voice?: string;
	jurisdiction?: string;
	difficulty?: string;
}
const results: EvalQueryOut[] = filtered.map((r) => ({
	id: r.id,
	question: r.question,
	expectedNorms: r.expectedNorms,
	category: r.materia ?? "",
	voice: r.voice,
	jurisdiction: r.jurisdiction,
	difficulty: r.difficulty,
}));

await Bun.write(outPath, JSON.stringify({ results }, null, 2));
console.log(`\nWrote ${results.length} queries → ${outPath}`);

// ── Stats ──
const byVoice = new Map<string, number>();
const byDifficulty = new Map<string, number>();
const byJurisdiction = new Map<string, number>();
for (const r of results) {
	byVoice.set(r.voice ?? "?", (byVoice.get(r.voice ?? "?") ?? 0) + 1);
	byDifficulty.set(
		r.difficulty ?? "?",
		(byDifficulty.get(r.difficulty ?? "?") ?? 0) + 1,
	);
	byJurisdiction.set(
		r.jurisdiction ?? "?",
		(byJurisdiction.get(r.jurisdiction ?? "?") ?? 0) + 1,
	);
}
const fmt = (m: Map<string, number>) =>
	[...m.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k}=${v}`)
		.join(", ");
console.log(`\nBreakdown:`);
console.log(`  voice:        ${fmt(byVoice)}`);
console.log(`  difficulty:   ${fmt(byDifficulty)}`);
console.log(`  jurisdiction: ${fmt(byJurisdiction)}`);
