/**
 * Enrichment CLI: reads a normalized QAEntry JSONL, maps citations_raw to
 * boe_a_ids via the local norms DB, and writes an enriched JSONL + audit sidecar.
 *
 * Usage:
 *   bun run packages/eval/src/enrich-citations.ts \
 *     --in  /path/to/normalized.jsonl \
 *     --out /path/to/enriched.jsonl   \
 *     [--limit N]
 *
 * Outputs:
 *   <out>            enriched JSONL (QAEntry with norms.citations[] + norms.boe_a_ids populated)
 *   <out>.audit.jsonl sidecar with full CitationMatch[] per entry
 *
 * Schema (norms object):
 *   citations_raw: string[]  — verbatim citation strings from the source document
 *   citations: Array<{       — aligned: one entry per citations_raw element, same order
 *     raw: string;           —   verbatim input
 *     boe_a_id: string|null; —   resolved BOE-A-YYYY-NNNN, or null if not found
 *     article: string|null;  —   article number extracted from raw (e.g. "90", "79.1")
 *   }>
 *   boe_a_ids: string[]      — deduplicated resolved IDs (backwards-compat, derived from citations)
 *
 * IMPORTANT: distinct legal references (different Ley/RD/RDLeg numbers) MUST resolve
 * to distinct BOE-A IDs. The mapper returns null rather than collapsing to a wrong target.
 * Downstream consumers MUST use citations[] for per-citation lookup, not boe_a_ids[0].
 */

import { Database } from "bun:sqlite";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, join } from "node:path";
import { type CitationMatch, mapCitations } from "./boe-mapping.ts";

// ---------------------------------------------------------------------------
// Article number extraction (mirrors verify-gold.ts parseArticle)
// Centralised here so both enrich and verify use the same logic.
// ---------------------------------------------------------------------------
function extractArticleNumber(citation: string): string | null {
	const m = citation.match(
		/art(?:[íi]culo|\.)\s*([0-9]+(?:[.\s]?(?:bis|ter|quater))?(?:\.[0-9]+)?)/i,
	);
	if (!m) return null;
	return m[1]!.trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const inPath = flag("in");
const outPath = flag("out");
const limitArg = flag("limit");
const limit = limitArg ? parseInt(limitArg, 10) : undefined;

if (!inPath || !outPath) {
	console.error(
		"Usage: enrich-citations.ts --in <in.jsonl> --out <out.jsonl> [--limit N]",
	);
	process.exit(1);
}

function resolve(p: string): string {
	return isAbsolute(p) ? p : join(process.cwd(), p);
}

const repoRoot = join(import.meta.dir, "../../../");
const DB_PATH = join(repoRoot, "data/leyabierta.db");

const db = new Database(DB_PATH, { readonly: true });

// ---------------------------------------------------------------------------
// Process — streaming line-by-line to handle large files (>1GB)
// ---------------------------------------------------------------------------
console.log(`Processing entries from ${inPath}… (streaming)`);

const outWriter = createWriteStream(resolve(outPath), { encoding: "utf8" });
const auditWriter = createWriteStream(`${resolve(outPath)}.audit.jsonl`, { encoding: "utf8" });

// Stats
let processed = 0;
let skipped = 0;
let totalCitations = 0;
let mappedCitations = 0;
const byConfidence: Record<string, number> = {
	exact: 0,
	fuzzy: 0,
	ambiguous: 0,
	none: 0,
};
const boeIdFreq: Record<string, number> = {};
let entriesWithAtLeastOne = 0;
let totalBoeIds = 0;

const rl = createInterface({
	input: createReadStream(resolve(inPath), { encoding: "utf8" }),
	crlfDelay: Number.POSITIVE_INFINITY,
});

for await (const line of rl) {
	const trimmed = line.trim();
	if (!trimmed) continue;
	if (limit !== undefined && processed >= limit) break;

	// biome-ignore lint/suspicious/noExplicitAny: raw JSON from file
	let entry: any;
	try {
		entry = JSON.parse(trimmed);
	} catch (e) {
		skipped++;
		console.error(`  [skip] JSON parse error on row ${processed + skipped}: ${e}`);
		continue;
	}

	const rawCitations: string[] = entry?.norms?.citations_raw ?? [];
	let matches: CitationMatch[];
	try {
		matches = mapCitations(rawCitations, { db });
	} catch (e) {
		skipped++;
		console.error(`  [skip] mapCitations error on entry ${entry?.id ?? "?"}: ${e}`);
		continue;
	}

	totalCitations += rawCitations.length;

	const boeIds = new Set<string>();
	// Build the aligned citations array: one entry per raw citation, same order.
	// Each entry carries the extracted article number so consumers don't need to re-parse.
	const citationsAligned = matches.map((m) => {
		byConfidence[m.confidence] = (byConfidence[m.confidence] ?? 0) + 1;
		if (m.boe_a_id) {
			mappedCitations++;
			boeIds.add(m.boe_a_id);
			boeIdFreq[m.boe_a_id] = (boeIdFreq[m.boe_a_id] ?? 0) + 1;
		}
		return {
			raw: m.raw,
			boe_a_id: m.boe_a_id,
			article: extractArticleNumber(m.raw),
		};
	});

	const boeIdList = [...boeIds];
	if (boeIdList.length > 0) entriesWithAtLeastOne++;
	totalBoeIds += boeIdList.length;

	// Build enriched entry.
	// norms.citations[] is the canonical aligned array.
	// norms.boe_a_ids[] is kept for backwards compat (derived: deduplicated resolved IDs).
	const enriched = {
		...entry,
		norms: {
			...(entry.norms ?? {}),
			citations: citationsAligned,
			boe_a_ids: boeIdList,
		},
	};
	outWriter.write(`${JSON.stringify(enriched)}\n`);

	// Build audit record
	auditWriter.write(`${JSON.stringify({ id: entry.id, citations: matches })}\n`);

	processed++;
	if (processed % 10000 === 0) {
		process.stdout.write(`  … ${processed} rows processed\r`);
	}
}

// Close writers and wait for flush
await new Promise<void>((res, rej) => outWriter.end((err) => err ? rej(err) : res()));
await new Promise<void>((res, rej) => auditWriter.end((err) => err ? rej(err) : res()));

const total = processed;
if (skipped > 0) {
	console.log(`\n  [warn] Skipped ${skipped} rows due to parse/mapping errors`);
}

// ---------------------------------------------------------------------------
// Summary report
// ---------------------------------------------------------------------------
const mappingRate =
	totalCitations > 0
		? ((mappedCitations / totalCitations) * 100).toFixed(1)
		: "0.0";
const entriesPct =
	total > 0 ? ((entriesWithAtLeastOne / total) * 100).toFixed(1) : "0.0";
const meanBoePerEntry = total > 0 ? (totalBoeIds / total).toFixed(2) : "0.00";

console.log(`\n── Summary ─────────────────────────────────`);
console.log(`  Entries processed:         ${total}`);
console.log(
	`  Entries with ≥1 BOE-A ID:  ${entriesWithAtLeastOne} (${entriesPct}%)`,
);
console.log(`  Mean BOE-A IDs per entry:  ${meanBoePerEntry}`);
console.log(`  Total citations attempted: ${totalCitations}`);
console.log(
	`  Total citations mapped:    ${mappedCitations} (${mappingRate}%)`,
);
console.log(`\n── By confidence ───────────────────────────`);
for (const [conf, count] of Object.entries(byConfidence).sort()) {
	console.log(`  ${conf.padEnd(10)}: ${count}`);
}

const top10 = Object.entries(boeIdFreq)
	.sort((a, b) => b[1] - a[1])
	.slice(0, 10);
console.log(`\n── Top 10 most-cited BOE-A IDs ─────────────`);
for (const [id, count] of top10) {
	console.log(`  ${count}x  ${id}`);
}

console.log(`\nWrote enriched → ${outPath}`);
console.log(`Wrote audit    → ${outPath}.audit.jsonl`);

db.close();
