/**
 * Enrich the Justicio Constitución gold subset with cross-system quality
 * signals from Dario López's `-sas` evaluation datasets.
 *
 * Each -sas dataset evaluates Justicio's 515 questions against the Constitución
 * using a different embedding model (BGE-M3 / multilingual-e5-large / mpnet /
 * roberta-bne / sentence-similarity-spanish), then synthesizes an answer with
 * Llama3-70B and compares it to ground_truth via SAS (Semantic Answer
 * Similarity). `mean_sas` is the cross-evaluator average.
 *
 * If multiple independent end-to-end RAG systems all score the same question
 * highly, the question is "well-formed and discoverable" — a good signal that
 * it belongs in our gold eval. If they all score it low, it's noisy.
 *
 * Strategy:
 *  1. Pull `mean_sas` from all 3 -sas datasets keyed by article number.
 *  2. Take the average across the 3 → external_quality_score per question.
 *  3. Annotate gold-eval-justicio.json entries with that score.
 *  4. Optionally write a filtered version keeping only score >= threshold.
 *
 * Usage:
 *   bun packages/api/research/ab/enrich-justicio-with-sas.ts \
 *     [--threshold 0.5] \
 *     [--filtered-out packages/api/research/datasets/gold-eval-justicio-filtered.json]
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

const threshold = Number(flag("threshold") ?? "0.5");
const goldPath = join(
	repoRoot,
	"packages/api/research/datasets/gold-eval-justicio.json",
);
const enrichedOut = flag("enriched-out")
	? resolvePath(flag("enriched-out")!)
	: join(
			repoRoot,
			"packages/api/research/datasets/gold-eval-justicio-enriched.json",
		);
const filteredOut = flag("filtered-out")
	? resolvePath(flag("filtered-out")!)
	: join(
			repoRoot,
			"packages/api/research/datasets/gold-eval-justicio-filtered.json",
		);

const sasDatasets = [
	"dariolopez/justicio-BOE-A-1978-31229-constitucion-by-articles-qa-qa-groq_llama3_70b_8192-sas",
	"dariolopez/justicio-BOE-A-1978-31229-constitucion-by-articles-qa-multilingual-e5-large-groq_llama3_70b-sas",
	"dariolopez/justicio-BOE-A-1978-31229-constitucion-by-articles-qa-bge-m3-groq_llama3_70b_8192-sas",
];

interface HfRow {
	row_idx: number;
	row: Record<string, unknown>;
}

async function fetchAll(slug: string): Promise<HfRow[]> {
	const pageSize = 100;
	const all: HfRow[] = [];
	let offset = 0;
	while (true) {
		const url = new URL("https://datasets-server.huggingface.co/rows");
		url.searchParams.set("dataset", slug);
		url.searchParams.set("config", "default");
		url.searchParams.set("split", "train");
		url.searchParams.set("offset", String(offset));
		url.searchParams.set("length", String(pageSize));
		const res = await fetch(url);
		if (!res.ok)
			throw new Error(`HF ${slug} ${res.status}: ${await res.text()}`);
		const data = (await res.json()) as {
			rows: HfRow[];
			num_rows_total: number;
		};
		all.push(...data.rows);
		if (data.rows.length < pageSize) break;
		offset += pageSize;
		if (offset > data.num_rows_total) break;
	}
	return all;
}

// Map: question_normalized → mean_sas scores from each -sas dataset
const perQuestion = new Map<
	string,
	{
		articleNumber: number | undefined;
		question: string;
		scores: number[];
	}
>();

for (const slug of sasDatasets) {
	console.log(`Fetching ${slug.slice(slug.lastIndexOf("/") + 1)}...`);
	const rows = await fetchAll(slug);
	console.log(`  → ${rows.length} rows`);
	for (const r of rows) {
		const q = String(r.row.question ?? "").trim();
		const key = q.toLowerCase().replace(/\s+/g, " ");
		const score = Number(r.row.mean_sas ?? 0);
		const articleNumber = r.row.number as number | undefined;
		const entry = perQuestion.get(key) ?? {
			articleNumber,
			question: q,
			scores: [],
		};
		entry.scores.push(score);
		perQuestion.set(key, entry);
	}
}
console.log(`\nUnique questions across -sas datasets: ${perQuestion.size}`);

// Load gold and enrich
interface GoldEntry {
	id: string;
	question: string;
	expectedNorms: string[];
	category: string;
	source: {
		origin: string;
		dataset: string;
		article: string | number | null;
		answerSnippet: string;
	};
	externalQualityScore?: number;
	externalScoresN?: number;
}

const gold = (await Bun.file(goldPath).json()) as { results: GoldEntry[] };
console.log(`\nGold entries loaded: ${gold.results.length}`);

let matched = 0;
let constitucionMatched = 0;
for (const e of gold.results) {
	const key = e.question.toLowerCase().replace(/\s+/g, " ").trim();
	const ext = perQuestion.get(key);
	if (ext && ext.scores.length > 0) {
		const avg = ext.scores.reduce((s, x) => s + x, 0) / ext.scores.length;
		e.externalQualityScore = avg;
		e.externalScoresN = ext.scores.length;
		matched++;
		if (e.expectedNorms[0] === "BOE-A-1978-31229") constitucionMatched++;
	}
}
console.log(
	`Matched ${matched} entries with -sas scores (${constitucionMatched} Constitución).`,
);

// Histogram of scores
const bins = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const hist = new Array(bins.length).fill(0);
for (const e of gold.results) {
	const s = e.externalQualityScore;
	if (s === undefined) continue;
	for (let i = bins.length - 1; i >= 0; i--) {
		if (s >= bins[i]!) {
			hist[i]++;
			break;
		}
	}
}
console.log(`\nExternal quality score histogram:`);
for (let i = 0; i < bins.length; i++) {
	console.log(`  >= ${bins[i]!.toFixed(2)}: ${hist[i]}`);
}

await Bun.write(enrichedOut, JSON.stringify(gold, null, 2));
console.log(`\nWrote enriched gold → ${enrichedOut}`);

// Filtered output: drop entries with externalQualityScore < threshold
// (entries without scores like Código Civil / Vivienda are kept because we
// have no signal either way for them)
const filtered = gold.results.filter((e) => {
	if (e.externalQualityScore === undefined) return true;
	return e.externalQualityScore >= threshold;
});
await Bun.write(filteredOut, JSON.stringify({ results: filtered }, null, 2));
console.log(`Filtered (threshold ${threshold}): ${filtered.length} kept of ${gold.results.length}`);
console.log(`Wrote filtered → ${filteredOut}`);
