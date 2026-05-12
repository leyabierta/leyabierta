/**
 * Build gold-eval-v1.json from the combined-375 dataset by sampling with
 * confidence-score filtering. Designed to run AFTER the combined Gemini+Qwen
 * eval has finished.
 *
 * Confidence scoring per entry:
 *   - +2 if both Gemini and Qwen hit@5 (both retrievers agree)
 *   - +1 if either hits@5
 *   - +0 if neither (both miss)
 *
 * Filter rule (default): keep entries with confidence ≥ 1. This drops the
 * worst cases where both retrievers utterly fail (likely bad expected sets).
 *
 * Sampling: stratified by `origin`, default 100 entries total:
 *   - dgt-regex: 40
 *   - justicio-codigo-civil: 20
 *   - justicio-vivienda: 15
 *   - justicio-constitucion: 10 (downsample, eval too easy)
 *   - asklog: 15
 *
 * Usage:
 *   bun packages/api/research/ab/build-gold-eval-v1.ts \
 *     [--min-confidence 1] \
 *     [--total 100] \
 *     [--out packages/api/research/datasets/gold-eval-v1.json]
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

const minConfidence = Number(flag("min-confidence") ?? "1");
const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(repoRoot, "packages/api/research/datasets/gold-eval-v1.json");

// Per-origin target counts (must sum to --total when total is honored)
const targets: Record<string, number> = {
	"dgt-regex": 40,
	"justicio-codigo-civil": 20,
	"justicio-vivienda": 15,
	"justicio-constitucion": 10,
	asklog: 15,
};

interface PassEntry {
	id: string | number;
	hitsAt1: boolean;
	hitsAt5: boolean;
	hitsAt10: boolean;
	topNormIds: string[];
}
interface Entry {
	id: string;
	question: string;
	expectedNorms: string[];
	category?: string | null;
	source: { origin: string; [k: string]: unknown };
}

const gemini = (await Bun.file(
	join(repoRoot, "data/ab-results/eval-pass-gemini-baseline.json"),
).json()) as { results: PassEntry[] };
const qwen = (await Bun.file(
	join(
		repoRoot,
		"data/ab-results/eval-pass-qwen-no-instruct-nan-analyzer-nan-rerank-gold-combined-375.json",
	),
).json()) as { results: PassEntry[] };
const dataset = (await Bun.file(
	join(repoRoot, "packages/api/research/datasets/gold-eval-combined.json"),
).json()) as { results: Entry[] };

const gByid = new Map(gemini.results.map((r) => [String(r.id), r]));
const qByid = new Map(qwen.results.map((r) => [String(r.id), r]));

function confidence(id: string): number {
	const g = gByid.get(id);
	const q = qByid.get(id);
	const gHit = !!g?.hitsAt5;
	const qHit = !!q?.hitsAt5;
	if (gHit && qHit) return 2;
	if (gHit || qHit) return 1;
	return 0;
}

// Annotate, group by origin, sort by confidence desc (prefer high-confidence)
const annotated = dataset.results.map((e) => ({
	entry: e,
	confidence: confidence(String(e.id)),
}));

const byOrigin = new Map<string, typeof annotated>();
for (const a of annotated) {
	const o = String(a.entry.source.origin);
	(byOrigin.get(o) ?? byOrigin.set(o, []).get(o)!).push(a);
}

// Stats: confidence distribution
console.log("Confidence distribution per origin (≥1 / ≥2 / total):");
for (const [origin, items] of [...byOrigin.entries()].sort()) {
	const ge1 = items.filter((a) => a.confidence >= 1).length;
	const ge2 = items.filter((a) => a.confidence >= 2).length;
	console.log(
		`  ${origin.padEnd(25)} ≥1: ${ge1} / ≥2: ${ge2} / total: ${items.length}`,
	);
}

// Sample per origin: prefer high-confidence, downsample by `targets[origin]`
function shuffle<T>(arr: T[]): T[] {
	const x = [...arr];
	for (let i = x.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[x[i], x[j]] = [x[j]!, x[i]!];
	}
	return x;
}

const gold: Array<Entry & { confidence: number }> = [];
for (const [origin, target] of Object.entries(targets)) {
	const pool = (byOrigin.get(origin) ?? []).filter(
		(a) => a.confidence >= minConfidence,
	);
	// Sort: confidence desc, then random within band
	const high = shuffle(pool.filter((a) => a.confidence === 2));
	const med = shuffle(pool.filter((a) => a.confidence === 1));
	const ordered = [...high, ...med];
	const picked = ordered.slice(0, target);
	console.log(
		`Picked ${picked.length}/${target} from ${origin} (pool with confidence≥${minConfidence}: ${pool.length})`,
	);
	for (const a of picked) gold.push({ ...a.entry, confidence: a.confidence });
}

// Final stats
console.log(`\nFinal gold-eval-v1: ${gold.length} entries`);
const finalByOrigin: Record<string, number> = {};
for (const e of gold)
	finalByOrigin[String(e.source.origin)] =
		(finalByOrigin[String(e.source.origin)] ?? 0) + 1;
console.log("By origin:", finalByOrigin);
const finalByConf: Record<string, number> = {};
for (const e of gold)
	finalByConf[String(e.confidence)] =
		(finalByConf[String(e.confidence)] ?? 0) + 1;
console.log("By confidence:", finalByConf);

await Bun.write(outPath, JSON.stringify({ results: gold }, null, 2));
console.log(`\nWrote → ${outPath}`);
