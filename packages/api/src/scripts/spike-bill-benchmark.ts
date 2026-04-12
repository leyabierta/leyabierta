/**
 * Phase 0: Bill Parser Benchmark
 *
 * Runs the parser against all PDFs in data/spike-bills/ and reports:
 * - How many modification groups were found
 * - How many individual modifications were classified
 * - How many modifications failed to classify (warnings)
 * - Text extraction quality
 *
 * Usage:
 *   bun run packages/api/src/scripts/spike-bill-benchmark.ts
 *   bun run packages/api/src/scripts/spike-bill-benchmark.ts --verbose
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { extractTextFromPdf, parseBill } from "../services/bill-parser/parser.ts";

const BILLS_DIR = "./data/spike-bills";
const verbose = process.argv.includes("--verbose");
const useLLM = process.argv.includes("--llm");
const apiKey = process.env.OPENROUTER_API_KEY || "";

interface BillResult {
	filename: string;
	textLength: number;
	bocgId: string;
	title: string;
	publicationDate: string;
	groupsFound: number;
	groupsExpected: number;
	totalModifications: number;
	byType: Record<string, number>;
	transitionalProvisions: number;
	warnings: string[];
	error: string | null;
}

/**
 * Count expected modification groups by scanning raw text for known patterns.
 * This gives a CEILING estimate for group recall measurement.
 */
function countExpectedGroups(text: string): number {
	const seen = new Set<number>(); // dedup by position

	// Pattern 1: "Disposición final X. Modificación de..."
	for (const m of text.matchAll(/Disposición final [\p{L}\d]+\.\s+Modificación (?:de|del) /gu)) {
		seen.add(m.index!);
	}

	// Pattern 2: "Disposición adicional X. Modificación de..."
	for (const m of text.matchAll(/Disposición adicional [\p{L}\d]+\.\s+Modificación (?:de|del) /gu)) {
		seen.add(m.index!);
	}

	// Pattern 3: "Artículo X. Modificación de..."
	for (const m of text.matchAll(/Artículo [\p{L}\d]+\.\s+Modificación (?:de|del) /gu)) {
		seen.add(m.index!);
	}

	// Pattern 4: "Artículo único." followed by mod keywords in first 500 chars
	const artUnico = text.match(/Artículo único\./);
	if (artUnico) {
		const body = text.slice(artUnico.index!, artUnico.index! + 500);
		if (/Se modifica|queda redactad|Modificación/i.test(body)) {
			seen.add(artUnico.index!);
		}
	}

	// Pattern 5: Bare disposiciones (DA/DF) whose body contains "Se modifica" in first 300 chars
	for (const m of text.matchAll(/\n(Disposición (?:final|adicional) [\p{L}\d]+\.)\s+/gu)) {
		if (seen.has(m.index! + 1)) continue; // Already counted from patterns above
		const bodyStart = m.index! + m[0].length;
		const chunk = text.slice(bodyStart, bodyStart + 300);
		if (/Se modifica[n]?\s+(?:el |la |los |las )?(?:artículo|apartado|párrafo)/i.test(chunk) ||
			/queda(?:n)?\s+(?:redactad|modificad)/i.test(chunk)) {
			seen.add(m.index! + 1);
		}
	}

	// Pattern 6: Articles whose body contains "Se modifica X de la Ley Y" (implicit mods)
	for (const m of text.matchAll(/\nArtículo [\p{L}\d]+\.\s+/gu)) {
		if (seen.has(m.index! + 1)) continue;
		const bodyStart = m.index! + m[0].length;
		const chunk = text.slice(bodyStart, bodyStart + 500);
		if (/Se modifica[n]?\s+(?:el |la |los |las )?(?:artículo|apartado).+?(?:de|del) (?:la |el )(?:Ley|Código|Estatuto|Real Decreto|texto refundido)/i.test(chunk) ||
			/queda(?:n)?\s+(?:redactad|modificad).+?(?:de|del) (?:la |el )(?:Ley|Código)/i.test(chunk)) {
			seen.add(m.index! + 1);
		}
	}

	// Dedup: PDFs often have an "índice" (table of contents) that lists all DFs/articles
	// as short entries, then the full text appears later. The index entries are short
	// (< 300 chars to next section), body entries are long (> 300 chars).
	// Only count entries where the section body is substantial.
	const positions = [...seen].sort((a, b) => a - b);
	let count = 0;
	for (let i = 0; i < positions.length; i++) {
		const pos = positions[i]!;
		const nextPos = positions[i + 1] ?? text.length;
		const sectionLength = nextPos - pos;
		// Skip short entries (likely index/TOC entries, < 300 chars)
		if (sectionLength < 300) continue;
		count++;
	}

	return count;
}

// Capture console.warn to count parser warnings
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
	const msg = args.map(String).join(" ");
	warnings.push(msg);
};

const pdfs = readdirSync(BILLS_DIR)
	.filter((f) => f.endsWith(".PDF"))
	.sort();

console.log("═══════════════════════════════════════════════════════");
console.log("  PHASE 0: Bill Parser Benchmark");
console.log(`  Testing ${pdfs.length} bills`);
console.log("═══════════════════════════════════════════════════════\n");

const results: BillResult[] = [];

for (const pdf of pdfs) {
	const path = join(BILLS_DIR, pdf);
	warnings.length = 0;

	try {
		const text = extractTextFromPdf(path);
		const bill = await parseBill(text, useLLM && apiKey ? { apiKey } : undefined);

		const byType: Record<string, number> = {};
		let totalMods = 0;
		for (const group of bill.modificationGroups) {
			for (const mod of group.modifications) {
				byType[mod.changeType] = (byType[mod.changeType] ?? 0) + 1;
				totalMods++;
			}
		}

		const groupsExpected = countExpectedGroups(text);

		results.push({
			filename: pdf,
			textLength: text.length,
			bocgId: bill.bocgId,
			title: bill.title.slice(0, 80),
			publicationDate: bill.publicationDate,
			groupsFound: bill.modificationGroups.length,
			groupsExpected,
			totalModifications: totalMods,
			byType,
			transitionalProvisions: bill.transitionalProvisions.length,
			warnings: [...warnings],
			error: null,
		});

		const status = totalMods > 0 ? "OK" : bill.modificationGroups.length === 0 ? "NO_MODS" : "EMPTY_GROUPS";
		const warnCount = warnings.length;
		console.log(
			`  ${status === "OK" ? "✅" : status === "NO_MODS" ? "⚠️" : "❌"} ${pdf}`,
		);
		const recallPct = groupsExpected > 0 ? ((bill.modificationGroups.length / groupsExpected) * 100).toFixed(0) : "-";
		console.log(
			`     ${text.length.toLocaleString()} chars | ${bill.modificationGroups.length}/${groupsExpected} groups (${recallPct}%) | ${totalMods} mods | ${warnCount} warnings | ${bill.transitionalProvisions.length} DTs`,
		);

		if (verbose && bill.modificationGroups.length > 0) {
			for (const group of bill.modificationGroups) {
				console.log(
					`     📎 ${group.targetLaw.slice(0, 70)} — ${group.modifications.length} mods`,
				);
			}
		}

		if (verbose && warnings.length > 0) {
			for (const w of warnings.slice(0, 5)) {
				console.log(`     ⚠️  ${w.slice(0, 100)}`);
			}
			if (warnings.length > 5)
				console.log(`     ... and ${warnings.length - 5} more warnings`);
		}
	} catch (err) {
		results.push({
			filename: pdf,
			textLength: 0,
			bocgId: "error",
			title: "error",
			publicationDate: "error",
			groupsFound: 0,
			groupsExpected: 0,
			totalModifications: 0,
			byType: {},
			transitionalProvisions: 0,
			warnings: [],
			error: String(err),
		});
		console.log(`  ❌ ${pdf} — ERROR: ${String(err).slice(0, 100)}`);
	}
	console.log();
}

// Restore console.warn
console.warn = originalWarn;

// ── Summary ──

console.log("═══════════════════════════════════════════════════════");
console.log("  SUMMARY");
console.log("═══════════════════════════════════════════════════════\n");

const successful = results.filter((r) => !r.error);
const withMods = successful.filter((r) => r.totalModifications > 0);
const noMods = successful.filter((r) => r.totalModifications === 0);
const errors = results.filter((r) => r.error);
const totalMods = successful.reduce((s, r) => s + r.totalModifications, 0);
const totalWarnings = successful.reduce((s, r) => s + r.warnings.length, 0);

console.log(`  Bills tested:    ${results.length}`);
console.log(`  Text extracted:  ${successful.length}/${results.length}`);
console.log(`  With mods found: ${withMods.length}/${successful.length}`);
console.log(`  No mods found:   ${noMods.length}/${successful.length}`);
console.log(`  Errors:          ${errors.length}`);
console.log();
console.log(`  Total mods:      ${totalMods}`);
console.log(`  Total warnings:  ${totalWarnings} (unclassified ordinals)`);
console.log(`  Classification:  ${totalMods > 0 ? ((totalMods / (totalMods + totalWarnings)) * 100).toFixed(1) : 0}%`);

const totalGroupsFound = successful.reduce((s, r) => s + r.groupsFound, 0);
const totalGroupsExpected = successful.reduce((s, r) => s + r.groupsExpected, 0);
const groupRecall = totalGroupsExpected > 0 ? ((totalGroupsFound / totalGroupsExpected) * 100).toFixed(1) : "-";
console.log(`  Group recall:    ${totalGroupsFound}/${totalGroupsExpected} (${groupRecall}%)`);

// Bills where found > expected (catch-all finds more than text scan expects)
const overDetected = successful.filter((r) => r.groupsFound > r.groupsExpected && r.groupsExpected > 0);
if (overDetected.length > 0) {
	console.log(`  Over-detected:   ${overDetected.length} bills (found > expected, catch-all effective)`);
}

// Bills where found < expected (missing groups)
const underDetected = successful.filter((r) => r.groupsFound < r.groupsExpected);
if (underDetected.length > 0) {
	console.log(`  Under-detected:  ${underDetected.length} bills (found < expected)`);
	for (const r of underDetected) {
		console.log(`    ${r.filename}: ${r.groupsFound}/${r.groupsExpected}`);
	}
}
console.log();

// Type breakdown
const globalTypes: Record<string, number> = {};
for (const r of successful) {
	for (const [type, count] of Object.entries(r.byType)) {
		globalTypes[type] = (globalTypes[type] ?? 0) + count;
	}
}
console.log("  Types breakdown:");
for (const [type, count] of Object.entries(globalTypes).sort(
	(a, b) => b[1] - a[1],
)) {
	console.log(`    ${type}: ${count}`);
}
console.log();

// Bills with no mods (need investigation)
if (noMods.length > 0) {
	console.log("  ⚠️  Bills with NO modifications detected:");
	for (const r of noMods) {
		console.log(`    ${r.filename} (${r.textLength.toLocaleString()} chars)`);
	}
	console.log();
}

// Most common warnings
if (totalWarnings > 0) {
	console.log("  ⚠️  Sample unclassified ordinals:");
	const allWarnings = successful.flatMap((r) =>
		r.warnings.map((w) => ({ file: r.filename, msg: w })),
	);
	for (const w of allWarnings.slice(0, 10)) {
		console.log(`    [${w.file}] ${w.msg.slice(0, 120)}`);
	}
	console.log();
}

// Table for README
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  MARKDOWN TABLE (for README)");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

console.log("| # | BOCG ID | Chars | Groups | Mods | Warnings | DTs | Status |");
console.log("|---|---------|-------|--------|------|----------|-----|--------|");
for (let i = 0; i < results.length; i++) {
	const r = results[i]!;
	const status = r.error
		? "ERROR"
		: r.totalModifications > 0
			? "OK"
			: "NO_MODS";
	console.log(
		`| ${i + 1} | ${r.bocgId} | ${r.textLength.toLocaleString()} | ${r.groupsFound} | ${r.totalModifications} | ${r.warnings.length} | ${r.transitionalProvisions} | ${status} |`,
	);
}
console.log();
