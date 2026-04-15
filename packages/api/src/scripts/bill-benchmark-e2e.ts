/**
 * E2E Precision Benchmark for Bill Parser.
 *
 * Runs the full parser (with or without LLM) against all test PDFs and saves
 * a detailed JSON snapshot. When a previous baseline exists, compares and reports
 * regressions/improvements.
 *
 * Usage:
 *   # Deterministic only (free, fast)
 *   bun run packages/api/src/scripts/bill-benchmark-e2e.ts
 *
 *   # With LLM verification + fallback (~$0.05 per run)
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/bill-benchmark-e2e.ts --llm
 *
 *   # Compare against a specific baseline
 *   bun run packages/api/src/scripts/bill-benchmark-e2e.ts --baseline data/bill-benchmarks/baseline-2026-04-11.json
 *
 *   # Save result as the new baseline
 *   bun run packages/api/src/scripts/bill-benchmark-e2e.ts --save-baseline
 *
 * Snapshots are saved in data/bill-benchmarks/
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	extractTextFromPdf,
	parseBill,
} from "../services/bill-parser/parser.ts";
import { getArg, hasFlag } from "./shared.ts";

// ── Config ──

const BILLS_DIR = "./data/spike-bills";
const SNAPSHOTS_DIR = "./data/bill-benchmarks";
const useLLM = hasFlag("llm");
const apiKey = process.env.OPENROUTER_API_KEY ?? "";
const saveBaseline = hasFlag("save-baseline");
const baselinePath = getArg("baseline");

// ── Types ──

interface GroupSnapshot {
	title: string;
	targetLaw: string;
	modCount: number;
	changeTypes: Record<string, number>;
}

interface BillSnapshot {
	bocgId: string;
	filename: string;
	textLength: number;
	publicationDate: string;
	groups: GroupSnapshot[];
	totalMods: number;
	transitionalProvisions: number;
	warnings: number;
}

interface BenchmarkSnapshot {
	timestamp: string;
	mode: "deterministic" | "llm";
	parserVersion: string;
	bills: BillSnapshot[];
	summary: {
		totalBills: number;
		billsWithMods: number;
		totalGroups: number;
		totalMods: number;
		totalWarnings: number;
		classification: number;
		groupRecall: { found: number; expected: number; pct: number };
	};
}

interface ComparisonResult {
	bill: string;
	field: string;
	baseline: string | number;
	current: string | number;
	change: "regression" | "improvement" | "neutral";
}

// ── Expected groups (from text scan) ──

function countExpectedGroups(text: string): number {
	const seen = new Set<number>();

	for (const m of text.matchAll(
		/Disposición final [\p{L}\d]+\.\s+Modificación (?:de|del) /gu,
	)) {
		seen.add(m.index!);
	}
	for (const m of text.matchAll(
		/Disposición adicional [\p{L}\d]+\.\s+Modificación (?:de|del) /gu,
	)) {
		seen.add(m.index!);
	}
	for (const m of text.matchAll(
		/Artículo [\p{L}\d]+\.\s+Modificación (?:de|del) /gu,
	)) {
		seen.add(m.index!);
	}
	const artUnico = text.match(/Artículo único\./);
	if (artUnico) {
		const body = text.slice(artUnico.index!, artUnico.index! + 500);
		if (/Se modifica|queda redactad|Modificación/i.test(body)) {
			seen.add(artUnico.index!);
		}
	}
	for (const m of text.matchAll(
		/\n(Disposición (?:final|adicional) [\p{L}\d]+\.)\s+/gu,
	)) {
		if (seen.has(m.index! + 1)) continue;
		const bodyStart = m.index! + m[0].length;
		const chunk = text.slice(bodyStart, bodyStart + 300);
		if (
			/Se modifica[n]?\s+(?:el |la |los |las )?(?:artículo|apartado|párrafo)/i.test(
				chunk,
			) ||
			/queda(?:n)?\s+(?:redactad|modificad)/i.test(chunk)
		) {
			seen.add(m.index! + 1);
		}
	}
	for (const m of text.matchAll(/\nArtículo [\p{L}\d]+\.\s+/gu)) {
		if (seen.has(m.index! + 1)) continue;
		const bodyStart = m.index! + m[0].length;
		const chunk = text.slice(bodyStart, bodyStart + 500);
		if (
			/Se modifica[n]?\s+(?:el |la |los |las )?(?:artículo|apartado).+?(?:de|del) (?:la |el )(?:Ley|Código|Estatuto|Real Decreto|texto refundido)/i.test(
				chunk,
			)
		) {
			seen.add(m.index! + 1);
		}
	}

	const positions = [...seen].sort((a, b) => a - b);
	let count = 0;
	for (let i = 0; i < positions.length; i++) {
		const pos = positions[i]!;
		const nextPos = positions[i + 1] ?? text.length;
		if (nextPos - pos >= 300) count++;
	}
	return count;
}

// ── Main ──

async function main() {
	const mode = useLLM && apiKey ? "llm" : "deterministic";

	console.log("═══════════════════════════════════════════════════════");
	console.log("  E2E PRECISION BENCHMARK — Bill Parser");
	console.log(`  Mode: ${mode.toUpperCase()}`);
	console.log("═══════════════════════════════════════════════════════\n");

	if (!existsSync(BILLS_DIR)) {
		console.error(`No bills directory found at ${BILLS_DIR}`);
		process.exit(1);
	}

	const pdfs = readdirSync(BILLS_DIR)
		.filter((f) => f.endsWith(".PDF"))
		.sort();
	console.log(`  Found ${pdfs.length} PDFs\n`);

	// Capture warnings
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) =>
		warnings.push(args.map(String).join(" "));

	const billSnapshots: BillSnapshot[] = [];
	let totalExpectedGroups = 0;
	let totalFoundGroups = 0;

	for (const pdf of pdfs) {
		warnings.length = 0;
		const pdfPath = join(BILLS_DIR, pdf);

		try {
			const text = extractTextFromPdf(pdfPath);
			const bill = await parseBill(
				text,
				useLLM && apiKey ? { apiKey } : undefined,
			);

			const groups: GroupSnapshot[] = bill.modificationGroups.map((g) => {
				const changeTypes: Record<string, number> = {};
				for (const m of g.modifications) {
					changeTypes[m.changeType] = (changeTypes[m.changeType] ?? 0) + 1;
				}
				return {
					title: g.title.slice(0, 150),
					targetLaw: g.targetLaw,
					modCount: g.modifications.length,
					changeTypes,
				};
			});

			const totalMods = bill.modificationGroups.reduce(
				(s, g) => s + g.modifications.length,
				0,
			);
			const expected = countExpectedGroups(text);
			totalExpectedGroups += expected;
			totalFoundGroups += bill.modificationGroups.length;

			const recallPct =
				expected > 0
					? ((bill.modificationGroups.length / expected) * 100).toFixed(0)
					: "-";
			const status = totalMods > 0 ? "OK" : "NO_MODS";
			console.log(
				`  ${status === "OK" ? "+" : "-"} ${bill.bocgId} | ${groups.length}/${expected} groups (${recallPct}%) | ${totalMods} mods | ${warnings.length} warns`,
			);

			billSnapshots.push({
				bocgId: bill.bocgId,
				filename: pdf,
				textLength: text.length,
				publicationDate: bill.publicationDate,
				groups,
				totalMods,
				transitionalProvisions: bill.transitionalProvisions.length,
				warnings: warnings.length,
			});
		} catch (err) {
			console.log(`  ! ${pdf} — ERROR: ${String(err).slice(0, 80)}`);
		}
	}

	console.warn = originalWarn;

	// Build snapshot
	const totalMods = billSnapshots.reduce((s, b) => s + b.totalMods, 0);
	const totalWarnings = billSnapshots.reduce((s, b) => s + b.warnings, 0);

	const snapshot: BenchmarkSnapshot = {
		timestamp: new Date().toISOString(),
		mode,
		parserVersion: `e2e-${new Date().toISOString().slice(0, 10)}`,
		bills: billSnapshots,
		summary: {
			totalBills: billSnapshots.length,
			billsWithMods: billSnapshots.filter((b) => b.totalMods > 0).length,
			totalGroups: totalFoundGroups,
			totalMods,
			totalWarnings,
			classification:
				totalMods > 0
					? Number(((totalMods / (totalMods + totalWarnings)) * 100).toFixed(1))
					: 0,
			groupRecall: {
				found: totalFoundGroups,
				expected: totalExpectedGroups,
				pct:
					totalExpectedGroups > 0
						? Number(
								((totalFoundGroups / totalExpectedGroups) * 100).toFixed(1),
							)
						: 0,
			},
		},
	};

	// Summary
	console.log("\n═══════════════════════════════════════════════════════");
	console.log("  SUMMARY");
	console.log("═══════════════════════════════════════════════════════\n");
	console.log(`  Bills:          ${snapshot.summary.totalBills}`);
	console.log(`  With mods:      ${snapshot.summary.billsWithMods}`);
	console.log(`  Total groups:   ${snapshot.summary.totalGroups}`);
	console.log(`  Total mods:     ${snapshot.summary.totalMods}`);
	console.log(`  Warnings:       ${snapshot.summary.totalWarnings}`);
	console.log(`  Classification: ${snapshot.summary.classification}%`);
	console.log(
		`  Group recall:   ${snapshot.summary.groupRecall.found}/${snapshot.summary.groupRecall.expected} (${snapshot.summary.groupRecall.pct}%)`,
	);

	// Save snapshot
	mkdirSync(SNAPSHOTS_DIR, { recursive: true });
	const snapshotFile = join(
		SNAPSHOTS_DIR,
		`${mode}-${new Date().toISOString().slice(0, 10)}.json`,
	);
	writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
	console.log(`\n  Snapshot saved: ${snapshotFile}`);

	if (saveBaseline) {
		const baselineFile = join(SNAPSHOTS_DIR, `baseline-${mode}.json`);
		writeFileSync(baselineFile, JSON.stringify(snapshot, null, 2));
		console.log(`  Baseline saved: ${baselineFile}`);
	}

	// Compare against baseline
	const compareFile =
		baselinePath ?? join(SNAPSHOTS_DIR, `baseline-${mode}.json`);
	if (existsSync(compareFile)) {
		console.log("\n═══════════════════════════════════════════════════════");
		console.log("  COMPARISON vs BASELINE");
		console.log("═══════════════════════════════════════════════════════\n");

		const baseline: BenchmarkSnapshot = JSON.parse(
			readFileSync(compareFile, "utf-8"),
		);
		const diffs = compareSnapshots(baseline, snapshot);

		if (diffs.length === 0) {
			console.log("  No changes detected.");
		} else {
			const regressions = diffs.filter((d) => d.change === "regression");
			const improvements = diffs.filter((d) => d.change === "improvement");

			if (improvements.length > 0) {
				console.log(`  IMPROVEMENTS (${improvements.length}):`);
				for (const d of improvements) {
					console.log(
						`    + ${d.bill} ${d.field}: ${d.baseline} -> ${d.current}`,
					);
				}
				console.log();
			}

			if (regressions.length > 0) {
				console.log(`  REGRESSIONS (${regressions.length}):`);
				for (const d of regressions) {
					console.log(
						`    - ${d.bill} ${d.field}: ${d.baseline} -> ${d.current}`,
					);
				}
				console.log();
			}

			// Exit with error code if regressions found
			if (regressions.length > 0) {
				console.log(`  VERDICT: ${regressions.length} regressions detected!`);
				process.exit(1);
			} else {
				console.log(
					`  VERDICT: ${improvements.length} improvements, 0 regressions.`,
				);
			}
		}
	} else {
		console.log(`\n  No baseline found at ${compareFile}`);
		console.log("  Run with --save-baseline to create one.");
	}

	console.log();
}

function compareSnapshots(
	baseline: BenchmarkSnapshot,
	current: BenchmarkSnapshot,
): ComparisonResult[] {
	const diffs: ComparisonResult[] = [];

	// Summary-level comparisons
	const sumFields: Array<{
		key: keyof BenchmarkSnapshot["summary"];
		higher: "good" | "bad";
	}> = [
		{ key: "totalMods", higher: "good" },
		{ key: "totalWarnings", higher: "bad" },
		{ key: "totalGroups", higher: "good" },
		{ key: "billsWithMods", higher: "good" },
	];

	for (const { key, higher } of sumFields) {
		const bVal = baseline.summary[key] as number;
		const cVal = current.summary[key] as number;
		if (bVal !== cVal) {
			const isHigher = cVal > bVal;
			diffs.push({
				bill: "SUMMARY",
				field: key,
				baseline: bVal,
				current: cVal,
				change:
					(isHigher && higher === "good") || (!isHigher && higher === "bad")
						? "improvement"
						: "regression",
			});
		}
	}

	// Per-bill comparisons
	const baselineMap = new Map(baseline.bills.map((b) => [b.filename, b]));
	for (const bill of current.bills) {
		const base = baselineMap.get(bill.filename);
		if (!base) continue;

		if (bill.totalMods !== base.totalMods) {
			diffs.push({
				bill: bill.bocgId,
				field: "totalMods",
				baseline: base.totalMods,
				current: bill.totalMods,
				change: bill.totalMods > base.totalMods ? "improvement" : "regression",
			});
		}

		if (bill.groups.length !== base.groups.length) {
			diffs.push({
				bill: bill.bocgId,
				field: "groups",
				baseline: base.groups.length,
				current: bill.groups.length,
				change:
					bill.groups.length > base.groups.length
						? "improvement"
						: "regression",
			});
		}

		if (bill.warnings !== base.warnings) {
			diffs.push({
				bill: bill.bocgId,
				field: "warnings",
				baseline: base.warnings,
				current: bill.warnings,
				change: bill.warnings < base.warnings ? "improvement" : "regression",
			});
		}
	}

	return diffs;
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
