/**
 * Bill Linter — test suite for the bill impact preview system.
 *
 * Runs 3 historical bills through the parser+analyzer and validates results:
 * 1. BOCG-14-A-62-1 (solo si es si) -> should detect CRITICAL penalty reduction + missing DT
 * 2. BOCG-10-A-66-1 (reforma CP 2015) -> should detect changes but OK transitional provisions
 * 3. BOCG-14-B-295-1 (sedicion/malversacion) -> should detect type elimination + good DTs
 *
 * Usage:
 *   bun run packages/api/src/scripts/spike-bill-linter.ts
 *   bun run packages/api/src/scripts/spike-bill-linter.ts --bill solo-si-es-si
 *   bun run packages/api/src/scripts/spike-bill-linter.ts --bill reforma-2015
 *   bun run packages/api/src/scripts/spike-bill-linter.ts --bill sedicion
 */

import { Database } from "bun:sqlite";
import { analyzeBill, formatReport } from "../services/bill-parser/analyzer";
import { extractTextFromPdf, parseBill } from "../services/bill-parser/parser";

// ── Config ──

const DB_PATH = "./data/leyabierta.db";

interface BillTestCase {
	id: string;
	pdf: string;
	description: string;
	expectedVerdict: "critical" | "ok" | "critical-with-dt";
	expectations: {
		minModifications: number;
		minGroups: number;
		modifiesPenalCode: boolean;
		expectPenaltyAlerts: boolean;
		expectTypeElimination: boolean;
		expectTransitionalDT: boolean;
		expectRevisionDT: boolean;
	};
}

const BILLS: BillTestCase[] = [
	{
		id: "solo-si-es-si",
		pdf: "./data/spike-bills/BOCG-14-A-62-1.PDF",
		description: "LO 10/2022 — Ley de garantia integral de la libertad sexual",
		expectedVerdict: "critical",
		expectations: {
			minModifications: 5,
			minGroups: 1,
			modifiesPenalCode: true,
			expectPenaltyAlerts: true,
			expectTypeElimination: false,
			expectTransitionalDT: false,
			expectRevisionDT: false,
		},
	},
	{
		id: "reforma-2015",
		pdf: "./data/spike-bills/BOCG-10-A-66-1.PDF",
		description:
			"LO 1/2015 — Reforma masiva del Codigo Penal (240+ modificaciones)",
		expectedVerdict: "critical-with-dt",
		expectations: {
			minModifications: 100,
			minGroups: 1,
			modifiesPenalCode: true,
			expectPenaltyAlerts: false, // has DTs so risk should be mitigated (note: some medium alerts may appear)
			expectTypeElimination: true, // suppresses chapters (restructured, not truly eliminated)
			expectTransitionalDT: true,
			expectRevisionDT: true,
		},
	},
	{
		id: "sedicion",
		pdf: "./data/spike-bills/BOCG-14-B-295-1.PDF",
		description: "LO 14/2022 — Sedicion, malversacion, transposicion UE",
		expectedVerdict: "critical-with-dt",
		expectations: {
			minModifications: 10,
			minGroups: 1,
			modifiesPenalCode: true,
			expectPenaltyAlerts: false,
			expectTypeElimination: true,
			expectTransitionalDT: true,
			expectRevisionDT: true,
		},
	},
];

// ── Test runner ──

async function runBill(
	bill: BillTestCase,
	db: Database,
): Promise<{
	passed: boolean;
	failures: string[];
}> {
	const failures: string[] = [];

	console.log(`\n${"=".repeat(70)}`);
	console.log(`  TESTING: ${bill.id}`);
	console.log(`  ${bill.description}`);
	console.log(`${"=".repeat(70)}\n`);

	// Step 1: Extract text
	console.log("  [1/4] Extracting text from PDF...");
	let text: string;
	try {
		text = extractTextFromPdf(bill.pdf);
		console.log(
			`         ${text.length.toLocaleString()} characters extracted`,
		);
	} catch (err) {
		console.log(`         FAILED: ${err}`);
		return { passed: false, failures: [`PDF extraction failed: ${err}`] };
	}

	// Step 2: Parse
	console.log("  [2/4] Parsing bill structure...");
	const parsed = await parseBill(text);
	console.log(`         BOCG ID: ${parsed.bocgId}`);
	console.log(`         Date: ${parsed.publicationDate}`);
	console.log(`         Groups: ${parsed.modificationGroups.length}`);
	const totalMods = parsed.modificationGroups.reduce(
		(sum, g) => sum + g.modifications.length,
		0,
	);
	console.log(`         Total modifications: ${totalMods}`);
	console.log(
		`         Transitional provisions: ${parsed.transitionalProvisions.length}`,
	);

	// Print group summary
	for (const group of parsed.modificationGroups) {
		const typeCounts = new Map<string, number>();
		for (const mod of group.modifications) {
			typeCounts.set(mod.changeType, (typeCounts.get(mod.changeType) ?? 0) + 1);
		}
		console.log(
			`         - ${group.targetLaw.slice(0, 60)}: ${group.modifications.length} mods [${[...typeCounts.entries()].map(([t, c]) => `${t}:${c}`).join(", ")}]`,
		);
	}

	// Step 3: Analyze
	console.log("  [3/4] Running impact analysis...");
	const report = analyzeBill(db, parsed);

	// Print formatted report
	console.log("");
	console.log(formatReport(report));

	// Step 4: Validate expectations
	console.log("  [4/4] Validating expectations...");

	const exp = bill.expectations;

	if (totalMods < exp.minModifications) {
		failures.push(
			`Expected >= ${exp.minModifications} modifications, got ${totalMods}`,
		);
	}

	if (parsed.modificationGroups.length < exp.minGroups) {
		failures.push(
			`Expected >= ${exp.minGroups} groups, got ${parsed.modificationGroups.length}`,
		);
	}

	if (report.transitionalCheck.modifiesPenalCode !== exp.modifiesPenalCode) {
		failures.push(
			`Expected modifiesPenalCode=${exp.modifiesPenalCode}, got ${report.transitionalCheck.modifiesPenalCode}`,
		);
	}

	const hasPenaltyAlerts = report.penaltyAnalysis.some(
		(c) => c.risk === "critical" || c.risk === "high",
	);
	if (exp.expectPenaltyAlerts && !hasPenaltyAlerts) {
		failures.push("Expected penalty alerts but found none");
	}

	const hasTypeElimination = report.typeEliminations.length > 0;
	if (exp.expectTypeElimination !== hasTypeElimination) {
		failures.push(
			`Expected typeElimination=${exp.expectTypeElimination}, got ${hasTypeElimination}`,
		);
	}

	if (
		exp.expectTransitionalDT !== report.transitionalCheck.hasPenaltyTransitional
	) {
		failures.push(
			`Expected hasPenaltyTransitional=${exp.expectTransitionalDT}, got ${report.transitionalCheck.hasPenaltyTransitional}`,
		);
	}

	if (
		exp.expectRevisionDT !== report.transitionalCheck.hasRevisionTransitional
	) {
		failures.push(
			`Expected hasRevisionTransitional=${exp.expectRevisionDT}, got ${report.transitionalCheck.hasRevisionTransitional}`,
		);
	}

	// Check verdict
	const verdict =
		report.summary.criticalAlerts > 0
			? report.transitionalCheck.hasPenaltyTransitional ||
				report.transitionalCheck.hasRevisionTransitional
				? "critical-with-dt"
				: "critical"
			: "ok";

	if (verdict !== bill.expectedVerdict) {
		failures.push(
			`Expected verdict="${bill.expectedVerdict}", got "${verdict}"`,
		);
	}

	// Print validation results
	if (failures.length === 0) {
		console.log("         PASSED - All expectations met\n");
	} else {
		console.log("         FAILED:");
		for (const f of failures) {
			console.log(`           - ${f}`);
		}
		console.log("");
	}

	return { passed: failures.length === 0, failures };
}

// ── Main ──

const args = process.argv.slice(2);
const billFilter = args.includes("--bill")
	? args[args.indexOf("--bill") + 1]
	: null;

const billsToRun = billFilter
	? BILLS.filter((b) => b.id === billFilter)
	: BILLS;

if (billsToRun.length === 0) {
	console.error(`Unknown bill: ${billFilter}`);
	console.error(`Available: ${BILLS.map((b) => b.id).join(", ")}`);
	process.exit(1);
}

console.log("=".repeat(70));
console.log("  BILL LINTER — Impact Preview Test Suite");
console.log(`  Testing ${billsToRun.length} bill(s)`);
console.log("=".repeat(70));

const db = new Database(DB_PATH, { readonly: true });
const results: Array<{ id: string; passed: boolean; failures: string[] }> = [];

for (const bill of billsToRun) {
	const result = await runBill(bill, db);
	results.push({ id: bill.id, ...result });
}

db.close();

// Final summary
console.log(`\n${"=".repeat(70)}`);
console.log("  FINAL RESULTS");
console.log(`${"=".repeat(70)}\n`);

let allPassed = true;
for (const r of results) {
	const status = r.passed ? "PASS" : "FAIL";
	console.log(`  [${status}] ${r.id}`);
	if (!r.passed) {
		allPassed = false;
		for (const f of r.failures) {
			console.log(`         - ${f}`);
		}
	}
}

console.log(
	`\n  ${results.filter((r) => r.passed).length}/${results.length} bills passed\n`,
);

process.exit(allPassed ? 0 : 1);
