/**
 * Score judge verdicts (judge-prompt.md) against the checklists.
 *
 *   bun run packages/eval/src/fichas/score.ts --judge DIR --checklists DIR
 *
 * DIR (--judge) holds verdict-<law>.json (judge output) and
 * labels-<law>.json ({"A": "openai/gpt-6-luna", …}, never shown to the judge).
 *
 * coverage = Σ weight·credit / Σ weight, with weight critical 3, important 2,
 * minor 1 and credit ok 1, partial 0.5, missing 0, wrong −0.5. Errors
 * (must_not violations + other_errors) are reported apart, not folded in.
 */

import { readdirSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		judge: { type: "string" },
		checklists: { type: "string" },
	},
});
if (!values.judge || !values.checklists) {
	console.error("usage: score.ts --judge DIR --checklists DIR");
	process.exit(1);
}

const WEIGHT = { critical: 3, important: 2, minor: 1 } as const;
const CREDIT: Record<string, number> = {
	ok: 1,
	partial: 0.5,
	missing: 0,
	wrong: -0.5,
};

interface Checklist {
	facts: Array<{ id: string; weight: keyof typeof WEIGHT }>;
}
interface Verdict {
	law: string;
	fichas: Record<
		string,
		{
			facts: Record<string, string>;
			must_not: Record<string, { violated: boolean }>;
			other_errors?: unknown[];
			clarity: number;
		}
	>;
}

interface Row {
	law: string;
	who: string;
	coverage: number;
	critical: string;
	violations: number;
	otherErrors: number;
	clarity: number;
}

const rows: Row[] = [];
for (const file of readdirSync(values.judge).filter((f) =>
	/^verdict-.*\.json$/.test(f),
)) {
	const v = (await Bun.file(`${values.judge}/${file}`).json()) as Verdict;
	const labels = (await Bun.file(
		`${values.judge}/labels-${v.law}.json`,
	).json()) as Record<string, string>;
	const ck = (await Bun.file(
		`${values.checklists}/${v.law}.checklist.json`,
	).json()) as Checklist;
	for (const [label, f] of Object.entries(v.fichas)) {
		let got = 0;
		let max = 0;
		let critOk = 0;
		let crit = 0;
		for (const fact of ck.facts) {
			const w = WEIGHT[fact.weight];
			max += w;
			got += w * (CREDIT[f.facts[fact.id] ?? "missing"] ?? 0);
			if (fact.weight === "critical") {
				crit++;
				if (f.facts[fact.id] === "ok") critOk++;
			}
		}
		rows.push({
			law: v.law,
			who: labels[label] ?? `?${label}`,
			coverage: got / max,
			critical: `${critOk}/${crit}`,
			violations: Object.values(f.must_not).filter((m) => m.violated).length,
			otherErrors: f.other_errors?.length ?? 0,
			clarity: f.clarity,
		});
	}
}

rows.sort((a, b) => a.law.localeCompare(b.law) || b.coverage - a.coverage);
console.log("law\twho\tcoverage\tcritical ok\tmust_not\tother errors\tclarity");
for (const r of rows) {
	console.log(
		`${r.law}\t${r.who}\t${(r.coverage * 100).toFixed(0)}%\t${r.critical}\t${r.violations}\t${r.otherErrors}\t${r.clarity}`,
	);
}

const byWho = new Map<string, Row[]>();
for (const r of rows) byWho.set(r.who, [...(byWho.get(r.who) ?? []), r]);
console.log("\nwho\tlaws\tmean coverage\tmust_not\tother errors\tmean clarity");
for (const [who, rs] of [...byWho].sort(
	(a, b) =>
		b[1].reduce((s, r) => s + r.coverage, 0) / b[1].length -
		a[1].reduce((s, r) => s + r.coverage, 0) / a[1].length,
)) {
	const mean = (k: "coverage" | "clarity") =>
		rs.reduce((s, r) => s + r[k], 0) / rs.length;
	console.log(
		`${who}\t${rs.length}\t${(mean("coverage") * 100).toFixed(0)}%\t${rs.reduce((s, r) => s + r.violations, 0)}\t${rs.reduce((s, r) => s + r.otherErrors, 0)}\t${mean("clarity").toFixed(1)}`,
	);
}
