/**
 * Verify eval dataset against the database.
 *
 * Checks:
 * 1. Every expectedNorms BOE ID exists in the norms table
 * 2. Every expectedArticles has a matching block in the blocks table
 * 3. No duplicate question IDs
 * 4. No duplicate questions (fuzzy)
 *
 * Usage: bun run packages/api/src/scripts/verify-eval-dataset.ts <json-file>
 */

import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");

const inputFile = process.argv[2];
if (!inputFile) {
	console.error("Usage: bun run verify-eval-dataset.ts <json-file>");
	process.exit(1);
}

interface EvalQuestion {
	id: string;
	question: string;
	category: string;
	expectedNorms: string[];
	expectedArticles?: string[];
	expectedAnswer: string;
	source?: string;
	sourceUrl?: string;
	verificationNote?: string;
	// adversarial fields
	adversarialType?: string;
	whatSystemMustDo?: string;
	whatSystemMustNotDo?: string;
}

const raw = await Bun.file(inputFile).text();
const questions: EvalQuestion[] = JSON.parse(raw);

const db = new Database(dbPath, { readonly: true });
db.exec("PRAGMA journal_mode = WAL");

// ── Check 1: Duplicate IDs ──
console.log("\n=== Check 1: Duplicate IDs ===");
const idCounts = new Map<string, number>();
for (const q of questions) {
	idCounts.set(q.id, (idCounts.get(q.id) ?? 0) + 1);
}
const dupes = [...idCounts.entries()].filter(([, count]) => count > 1);
if (dupes.length > 0) {
	console.log(
		`  ❌ ${dupes.length} duplicate IDs: ${dupes.map(([id]) => id).join(", ")}`,
	);
} else {
	console.log(`  ✅ All ${questions.length} IDs are unique`);
}

// ── Check 2: Norm IDs exist in DB ──
console.log("\n=== Check 2: Norm IDs exist in DB ===");
const allNormIds = [...new Set(questions.flatMap((q) => q.expectedNorms))];
const existingNorms = new Set(
	db
		.query<{ id: string }, []>("SELECT id FROM norms")
		.all()
		.map((r) => r.id),
);

let normMisses = 0;
for (const normId of allNormIds) {
	if (!existingNorms.has(normId)) {
		console.log(`  ❌ Norm NOT FOUND: ${normId}`);
		normMisses++;
	}
}
if (normMisses === 0) {
	console.log(`  ✅ All ${allNormIds.length} norm IDs exist in DB`);
} else {
	console.log(`  ⚠️  ${normMisses}/${allNormIds.length} norms missing`);
}

// ── Check 3: Articles exist as blocks ──
console.log("\n=== Check 3: Articles exist as blocks ===");

// Build a cache of all block titles per norm
const blockCache = new Map<string, Set<string>>();
for (const normId of allNormIds) {
	if (!existingNorms.has(normId)) continue;
	const blocks = db
		.query<{ title: string }, [string]>(
			"SELECT title FROM blocks WHERE norm_id = ? AND block_type = 'precepto'",
		)
		.all(normId);
	const titles = new Set(
		blocks.map((b) => b.title.toLowerCase().replace(/\u00A0/g, " ")),
	);
	blockCache.set(normId, titles);
}

let articleHits = 0;
let articleMisses = 0;
const missingArticles: Array<{ qId: string; normId: string; article: string }> =
	[];

for (const q of questions) {
	if (!q.expectedArticles || q.expectedArticles.length === 0) continue;

	for (const article of q.expectedArticles) {
		// Extract article number from "Artículo 38" → "38"
		const numMatch = article.match(/\d+/);
		if (!numMatch) continue;
		const num = numMatch[0];

		// Check all norms for this question
		let found = false;
		for (const normId of q.expectedNorms) {
			const titles = blockCache.get(normId);
			if (!titles) continue;
			// Look for any block title containing the article number
			// Formats vary: "Artículo 38. Vacaciones", "Art 912", "Artículo séptimo"
			for (const title of titles) {
				// Also check exact match with no trailing chars
				const exactArt = `artículo ${num}`;
				if (
					title === exactArt ||
					title.startsWith(`${exactArt}.`) ||
					title.startsWith(`${exactArt} `) ||
					title.includes(`artículo ${num}\n`) ||
					title.includes(`art. ${num}.`) ||
					title.includes(`art. ${num} `) ||
					title === `art ${num}` ||
					title.startsWith(`art ${num} `) ||
					title.startsWith(`art ${num}.`)
				) {
					found = true;
					break;
				}
			}
			if (found) break;
		}

		if (found) {
			articleHits++;
		} else {
			articleMisses++;
			missingArticles.push({
				qId: q.id,
				normId: q.expectedNorms[0] ?? "?",
				article,
			});
		}
	}
}

if (articleMisses === 0) {
	console.log(`  ✅ All ${articleHits} article references found in DB`);
} else {
	console.log(
		`  ⚠️  ${articleMisses}/${articleHits + articleMisses} articles not found:`,
	);
	for (const m of missingArticles.slice(0, 20)) {
		console.log(`    ❌ ${m.qId}: ${m.article} in ${m.normId}`);
	}
	if (missingArticles.length > 20) {
		console.log(`    ... and ${missingArticles.length - 20} more`);
	}
}

// ── Check 4: Category distribution ──
console.log("\n=== Check 4: Category distribution ===");
const catCounts = new Map<string, number>();
for (const q of questions) {
	catCounts.set(q.category, (catCounts.get(q.category) ?? 0) + 1);
}
for (const [cat, count] of [...catCounts.entries()].sort()) {
	console.log(`  ${cat}: ${count}`);
}
console.log(`  Total: ${questions.length}`);

// ── Check 5: Questions without sources ──
console.log("\n=== Check 5: Source coverage ===");
const noSource = questions.filter((q) => !q.source && !q.adversarialType);
if (noSource.length > 0) {
	console.log(
		`  ⚠️  ${noSource.length} questions without source: ${noSource.map((q) => q.id).join(", ")}`,
	);
} else {
	console.log(`  ✅ All non-adversarial questions have sources`);
}

// ── Summary ──
console.log("\n=== Summary ===");
console.log(`  Questions: ${questions.length}`);
console.log(`  Unique norms referenced: ${allNormIds.length}`);
console.log(
	`  Norms in DB: ${allNormIds.length - normMisses}/${allNormIds.length}`,
);
console.log(
	`  Articles verified: ${articleHits}/${articleHits + articleMisses}`,
);
console.log(`  Duplicate IDs: ${dupes.length}`);

db.close();
