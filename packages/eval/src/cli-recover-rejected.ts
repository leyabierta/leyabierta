/**
 * Recovery script: re-applies the leak detector's bigram-overlap layer
 * to existing `rejected-*.jsonl` records, using the data-driven domain
 * whitelist added in leak-detector-whitelist.ts. Records that would no
 * longer fail the bigram threshold are saved to
 * `datasets/v3/recovery-candidates.jsonl`.
 *
 * IMPORTANT: these are "candidates", not full accepts. The original
 * pipeline runs rare-overlap and an LLM critic AFTER bigram-overlap; we
 * skip those here because (a) rare-overlap needs the corpus frequency
 * map at pipeline init, and (b) the LLM critic would re-spend NaN
 * budget. Recovered candidates should be re-fed through the pipeline
 * starting from those two stages — out of scope for this script.
 *
 * Usage:
 *   bun packages/eval/src/cli-recover-rejected.ts \
 *     [--in packages/eval/datasets/v3] \
 *     [--out packages/eval/datasets/v3/recovery-candidates.jsonl] \
 *     [--min-overlap N]
 *
 * Emits stats: per-file rejection breakdown + total recovery potential.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const inDir = flag("in") ?? "packages/eval/datasets/v3";
const outPath = flag("out") ?? `${inDir}/recovery-candidates.jsonl`;
const minOverlap = Number(flag("min-overlap") ?? 2);

// Import the whitelist + reuse the tokenizer. We re-implement the bigram
// match here against the rejection reasons (we don't have the article
// text in rejected records); the whitelist is the same source of truth
// as the production detector.
const { DOMAIN_INEVITABLE_BIGRAMS } = await import(
	"./agents/prompts/leak-detector-whitelist.ts"
);

interface RejectedRecord {
	seed: string;
	reason: string;
	draft: string;
}

interface RecoveryCandidate {
	seed: string;
	draft: string;
	originalReason: string;
	originalBigrams: string[];
	whitelistedBigrams: string[];
	remainingBigrams: string[];
	sourceFile: string;
}

/** Parse `leak: bigram-overlap: "a b", "c d"` into the list of bigrams. */
function parseBigramReason(reason: string): string[] | null {
	if (!reason.startsWith("leak: bigram-overlap")) return null;
	const out: string[] = [];
	for (const m of reason.matchAll(/"([^"]+)"/g)) {
		const bg = m[1]!;
		if (bg.split(/\s+/).length === 2) out.push(bg);
	}
	return out;
}

const entries = await readdir(inDir);
const files = entries
	.filter((f) => f.startsWith("rejected-") && f.endsWith(".jsonl"))
	.map((f) => join(inDir, f));

if (files.length === 0) {
	console.error(`No rejected-*.jsonl in ${inDir}`);
	process.exit(1);
}

interface FileStats {
	file: string;
	totalRecords: number;
	leakRejects: number;
	bigramRejects: number;
	bigramWouldPassNow: number;
	recoveryPercent: number;
}

const candidates: RecoveryCandidate[] = [];
const stats: FileStats[] = [];
let grandTotalRecords = 0;
let grandBigramRejects = 0;
let grandRecovered = 0;

for (const file of files) {
	const text = await Bun.file(file).text();
	if (!text.trim()) {
		stats.push({
			file,
			totalRecords: 0,
			leakRejects: 0,
			bigramRejects: 0,
			bigramWouldPassNow: 0,
			recoveryPercent: 0,
		});
		continue;
	}
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	let total = 0;
	let leakRejects = 0;
	let bigramRejects = 0;
	let bigramWouldPassNow = 0;

	for (const line of lines) {
		total++;
		let r: RejectedRecord;
		try {
			r = JSON.parse(line) as RejectedRecord;
		} catch {
			continue;
		}
		if (typeof r.reason !== "string") continue;
		if (r.reason.startsWith("leak")) leakRejects++;

		const bigrams = parseBigramReason(r.reason);
		if (!bigrams) continue;
		bigramRejects++;

		const whitelisted: string[] = [];
		const remaining: string[] = [];
		for (const bg of bigrams) {
			if (DOMAIN_INEVITABLE_BIGRAMS.has(bg)) whitelisted.push(bg);
			else remaining.push(bg);
		}

		if (remaining.length < minOverlap) {
			bigramWouldPassNow++;
			candidates.push({
				seed: r.seed,
				draft: r.draft,
				originalReason: r.reason,
				originalBigrams: bigrams,
				whitelistedBigrams: whitelisted,
				remainingBigrams: remaining,
				sourceFile: file,
			});
		}
	}

	stats.push({
		file,
		totalRecords: total,
		leakRejects,
		bigramRejects,
		bigramWouldPassNow,
		recoveryPercent:
			bigramRejects > 0 ? (bigramWouldPassNow / bigramRejects) * 100 : 0,
	});
	grandTotalRecords += total;
	grandBigramRejects += bigramRejects;
	grandRecovered += bigramWouldPassNow;
}

await Bun.write(outPath, candidates.map((c) => JSON.stringify(c)).join("\n"));

console.log(`\n=== Recovery report ===`);
console.log(`Files processed: ${files.length}`);
console.log(`Total rejected records: ${grandTotalRecords}`);
console.log(`Bigram-overlap rejections: ${grandBigramRejects}`);
console.log(
	`Would pass bigram layer NOW: ${grandRecovered} (${grandBigramRejects > 0 ? ((grandRecovered / grandBigramRejects) * 100).toFixed(1) : 0}%)`,
);
console.log(`\nPer-file breakdown:`);
for (const s of stats) {
	if (s.bigramRejects === 0) continue;
	console.log(
		`  ${s.file.split("/").pop()}: ${s.bigramRejects} bigram-rejects → ${s.bigramWouldPassNow} recovered (${s.recoveryPercent.toFixed(1)}%)`,
	);
}
console.log(`\nCandidates written: ${candidates.length} → ${outPath}`);
console.log(`\nReminder: candidates are NOT fully accepted. They still need to`);
console.log(`pass rare-overlap + LLM critic + answerability + voice + 5-judge`);
console.log(`panel + dedup. Re-feed via the pipeline starting at rare-overlap.`);
