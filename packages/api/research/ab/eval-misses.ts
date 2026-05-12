/**
 * Qualitative analysis: where does Qwen miss and Gemini hit?
 *
 * Usage:
 *   bun packages/api/research/ab/eval-misses.ts [path-to-eval.json]
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

interface PerQ {
	id: number;
	question: string;
	expectedNorms: string[];
	hitRank: number | null;
	topNorms: string[];
}
interface VariantBlob {
	variant: string;
	label: string;
	perQuestion: PerQ[];
}

const repoRoot = join(import.meta.dir, "../../../../");
const inputArg = process.argv[2];
let path: string;
if (inputArg) {
	path = inputArg;
} else {
	const dir = join(repoRoot, "data", "ab-results");
	const files = readdirSync(dir)
		.filter((f) => f.startsWith("eval-") && f.endsWith(".json"))
		.sort();
	path = join(dir, files.at(-1)!);
}
console.log(`Reading: ${path}\n`);

const blob = (await Bun.file(path).json()) as { results: VariantBlob[] };
const byId = new Map<string, VariantBlob>(
	blob.results.map((r) => [r.variant, r]),
);

const A = byId.get("A"); // Gemini
const H = byId.get("H"); // Qwen + Instruct (4096)
const I = byId.get("I"); // Qwen + Instruct MRL@3072
if (!A || !H || !I) {
	console.error("Missing variants A/H/I in this eval JSON.");
	process.exit(1);
}

const map = (v: VariantBlob): Map<number, PerQ> =>
	new Map(v.perQuestion.map((q) => [q.id, q]));
const _aMap = map(A);
const hMap = map(H);
const iMap = map(I);

interface MissCase {
	id: number;
	question: string;
	expected: string[];
	gemini: { rank: number | null; top: string[] };
	qwen4096: { rank: number | null; top: string[] };
	qwen3072: { rank: number | null; top: string[] };
}

const cases: MissCase[] = [];
for (const a of A.perQuestion) {
	const h = hMap.get(a.id);
	const i = iMap.get(a.id);
	if (!h || !i) continue;
	const aHit1 = a.hitRank === 1;
	const hHit1 = h.hitRank === 1;
	const iHit1 = i.hitRank === 1;
	if (aHit1 && !hHit1 && !iHit1) {
		cases.push({
			id: a.id,
			question: a.question,
			expected: a.expectedNorms,
			gemini: { rank: a.hitRank, top: a.topNorms },
			qwen4096: { rank: h.hitRank, top: h.topNorms },
			qwen3072: { rank: i.hitRank, top: i.topNorms },
		});
	}
}

console.log(
	`Found ${cases.length} cases where Gemini=R@1 but Qwen (H & I) missed R@1\n`,
);
console.log("=".repeat(100));

for (const c of cases) {
	console.log(`\n[#${c.id}] ${c.question}`);
	console.log(`  expected: ${c.expected.join(", ")}`);
	console.log(
		`  Gemini   rank=${c.gemini.rank}  top5=[${c.gemini.top.join(", ")}]`,
	);
	console.log(
		`  Qwen4096 rank=${c.qwen4096.rank}  top5=[${c.qwen4096.top.join(", ")}]`,
	);
	console.log(
		`  Qwen3072 rank=${c.qwen3072.rank}  top5=[${c.qwen3072.top.join(", ")}]`,
	);
}

// Patterns
console.log(`\n${"=".repeat(100)}\nPATTERNS`);
const ranksH = cases.map((c) => c.qwen4096.rank ?? 999);
const stillTop5 = ranksH.filter((r) => r <= 5).length;
const stillTop10 = ranksH.filter((r) => r <= 10).length;
const beyondTop10 = ranksH.filter((r) => r > 10).length;
console.log(
	`Of the ${cases.length} misses:\n` +
		`  Qwen still in top-5:   ${stillTop5} (R@5 would still hit)\n` +
		`  Qwen still in top-10:  ${stillTop10}\n` +
		`  Qwen beyond top-10:    ${beyondTop10} (real misses)`,
);

// Question length distribution
const qLens = cases.map((c) => c.question.length);
console.log(
	`\nQuestion length: avg=${Math.round(qLens.reduce((s, n) => s + n, 0) / qLens.length)} chars, min=${Math.min(...qLens)}, max=${Math.max(...qLens)}`,
);
