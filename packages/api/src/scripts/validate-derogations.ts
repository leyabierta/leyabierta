/**
 * Validate extractDerogations() across all spike-bills PDFs.
 *
 * For each PDF:
 * 1. Extract text and run parseBill (derogations only — no LLM)
 * 2. Independently search raw text for derogation indicators
 * 3. Compare parser output vs raw text matches
 *
 * Usage: bun run packages/api/src/scripts/validate-derogations.ts
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractTextFromPdf, parseBill } from "../services/bill-parser/parser.ts";

const DATA_DIR = resolve(import.meta.dirname!, "../../../../data/spike-bills");

// ── Raw text detection patterns ──

/** Matches "Disposición derogatoria" section headers */
const DEROG_SECTION_RE = /Disposición derogatoria\s+[\p{L}\d]+\./gu;

/** Matches specific derogation verbs with a law reference nearby (direct or via provisions) */
const DEROG_VERB_RE =
	/(?:Se deroga[n]?|Queda(?:n)? derogada?s?|Se suprime[n]?)\s+(?:expresamente\s+|íntegramente\s+)?(?:la |el |los |las )?(?:Ley|Real Decreto|Decreto|texto refundido|Código|Estatuto|Reglamento|art[ií]culos?\s|libro\s|t[ií]tulo\s|apartado\s|disposición\s+(?:adicional|final|transitoria))/gi;

/** Generic clause — should NOT be counted as a specific derogation */
const GENERIC_RE =
	/cuantas?\s+disposiciones?\s+(?:de\s+igual\s+o\s+inferior\s+rango|contrarias?|que\s+se\s+opongan)/gi;

interface RawMatch {
	pattern: string;
	text: string;
	isGeneric: boolean;
}

function findRawDerogations(text: string): RawMatch[] {
	const matches: RawMatch[] = [];

	// Find derogation verb patterns
	for (const m of text.matchAll(DEROG_VERB_RE)) {
		// Grab surrounding context (200 chars after match start)
		const context = text.slice(m.index!, Math.min(m.index! + 300, text.length)).replace(/\n/g, " ");
		const isGeneric = GENERIC_RE.test(context);
		// Reset lastIndex since we're reusing the regex
		GENERIC_RE.lastIndex = 0;
		matches.push({
			pattern: "Se deroga / Queda derogada",
			text: context.slice(0, 120) + "...",
			isGeneric,
		});
	}

	return matches;
}

function countDerogSections(text: string): number {
	return [...text.matchAll(DEROG_SECTION_RE)].length;
}

// ── Main ──

interface Result {
	bocgId: string;
	file: string;
	parserCount: number;
	rawSpecificCount: number;
	rawGenericCount: number;
	sectionCount: number;
	falsePositives: number;
	falseNegatives: number;
	parserDerogations: Array<{ targetLaw: string; scope: string }>;
	rawMatches: RawMatch[];
}

async function main() {
	const files = readdirSync(DATA_DIR)
		.filter((f) => f.endsWith(".PDF"))
		.sort();

	console.log(`Found ${files.length} PDFs in ${DATA_DIR}\n`);
	console.log("=".repeat(100));

	const results: Result[] = [];

	for (const file of files) {
		const pdfPath = join(DATA_DIR, file);
		console.log(`\nProcessing: ${file}`);

		try {
			const text = extractTextFromPdf(pdfPath);
			const bill = await parseBill(text); // no apiKey = no LLM

			// Parser results
			const parserDerogations = bill.derogations.map((d) => ({
				targetLaw: d.targetLaw,
				scope: d.scope,
			}));

			// Raw text analysis
			const rawMatches = findRawDerogations(text);
			const sectionCount = countDerogSections(text);
			const rawSpecific = rawMatches.filter((m) => !m.isGeneric);
			const rawGeneric = rawMatches.filter((m) => m.isGeneric);

			// Heuristic FP/FN calculation
			// FN = raw specific matches that the parser didn't find
			const falseNegatives = Math.max(0, rawSpecific.length - parserDerogations.length);
			// FP = parser found more than raw specific matches (unlikely but possible)
			const falsePositives = Math.max(0, parserDerogations.length - rawSpecific.length);

			const result: Result = {
				bocgId: bill.bocgId || file.replace(".PDF", ""),
				file,
				parserCount: parserDerogations.length,
				rawSpecificCount: rawSpecific.length,
				rawGenericCount: rawGeneric.length,
				sectionCount,
				falsePositives,
				falseNegatives,
				parserDerogations,
				rawMatches,
			};

			results.push(result);

			// Detailed output per bill
			if (parserDerogations.length > 0 || rawMatches.length > 0) {
				console.log(`  BOCG ID: ${result.bocgId}`);
				console.log(`  Derogation sections found: ${sectionCount}`);
				console.log(`  Parser derogations: ${parserDerogations.length}`);
				for (const d of parserDerogations) {
					console.log(`    - [${d.scope}] ${d.targetLaw}`);
				}
				console.log(`  Raw matches (specific): ${rawSpecific.length}`);
				console.log(`  Raw matches (generic, skipped): ${rawGeneric.length}`);
				for (const m of rawMatches) {
					const tag = m.isGeneric ? "GENERIC" : "SPECIFIC";
					console.log(`    - [${tag}] ${m.text}`);
				}
				if (falseNegatives > 0) {
					console.log(`  >>> POSSIBLE FALSE NEGATIVES: ${falseNegatives}`);
				}
				if (falsePositives > 0) {
					console.log(`  >>> POSSIBLE FALSE POSITIVES: ${falsePositives}`);
				}
			} else {
				console.log(`  No derogations (parser or raw). OK.`);
			}
		} catch (err) {
			console.error(`  ERROR: ${err}`);
			results.push({
				bocgId: file.replace(".PDF", ""),
				file,
				parserCount: 0,
				rawSpecificCount: 0,
				rawGenericCount: 0,
				sectionCount: 0,
				falsePositives: 0,
				falseNegatives: 0,
				parserDerogations: [],
				rawMatches: [],
			});
		}
	}

	// ── Summary table ──
	console.log("\n\n" + "=".repeat(100));
	console.log("SUMMARY TABLE");
	console.log("=".repeat(100));
	console.log(
		"BOCG ID".padEnd(25) +
			"| derog: N".padEnd(12) +
			"| raw spec: M".padEnd(15) +
			"| raw gen: G".padEnd(14) +
			"| sections".padEnd(12) +
			"| FP: X".padEnd(9) +
			"| FN: Y",
	);
	console.log("-".repeat(100));

	let totalParser = 0;
	let totalRawSpec = 0;
	let totalRawGen = 0;
	let totalFP = 0;
	let totalFN = 0;
	let billsWithDerog = 0;
	let billsWithIssues = 0;

	for (const r of results) {
		totalParser += r.parserCount;
		totalRawSpec += r.rawSpecificCount;
		totalRawGen += r.rawGenericCount;
		totalFP += r.falsePositives;
		totalFN += r.falseNegatives;
		if (r.parserCount > 0 || r.rawSpecificCount > 0) billsWithDerog++;
		if (r.falsePositives > 0 || r.falseNegatives > 0) billsWithIssues++;

		const fpStr = r.falsePositives > 0 ? `FP: ${r.falsePositives}` : "FP: 0";
		const fnStr = r.falseNegatives > 0 ? `FN: ${r.falseNegatives}` : "FN: 0";
		const flag = r.falsePositives > 0 || r.falseNegatives > 0 ? " <<<" : "";

		console.log(
			`${r.bocgId.padEnd(25)}| derog: ${String(r.parserCount).padEnd(4)}| raw spec: ${String(r.rawSpecificCount).padEnd(4)}| raw gen: ${String(r.rawGenericCount).padEnd(4)}| sect: ${String(r.sectionCount).padEnd(5)}| ${fpStr.padEnd(7)}| ${fnStr}${flag}`,
		);
	}

	// ── Verdict ──
	console.log("\n" + "=".repeat(100));
	console.log("VERDICT");
	console.log("=".repeat(100));
	console.log(`Total PDFs analyzed:          ${results.length}`);
	console.log(`Bills with derogations:       ${billsWithDerog}`);
	console.log(`Total parser derogations:     ${totalParser}`);
	console.log(`Total raw specific matches:   ${totalRawSpec}`);
	console.log(`Total raw generic (skipped):  ${totalRawGen}`);
	console.log(`Total false positives (est.): ${totalFP}`);
	console.log(`Total false negatives (est.): ${totalFN}`);
	console.log(`Bills with issues:            ${billsWithIssues}`);

	if (totalFN === 0 && totalFP === 0) {
		console.log("\nRESULT: PASS — Parser matches all raw derogation patterns.");
	} else {
		console.log(
			`\nRESULT: ISSUES FOUND — ${billsWithIssues} bill(s) with discrepancies. Review details above.`,
		);
	}
}

main().catch(console.error);
