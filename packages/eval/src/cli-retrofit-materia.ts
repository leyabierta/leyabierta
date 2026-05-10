/**
 * Retrofit script: re-applies `pickMostRelevantMateria` to existing
 * `accepted-*.jsonl` records, producing a parallel file with corrected
 * materia labels for review.
 *
 * Does NOT modify the source files. Writes to
 * `datasets/v3/accepted-retrofitted-materia.jsonl` (configurable via --out).
 *
 * Pure file + DB read, no NaN/LLM calls. Safe to run alongside the
 * generation pipeline.
 *
 * Usage:
 *   bun packages/eval/src/cli-retrofit-materia.ts \
 *     [--in packages/eval/datasets/v3] \
 *     [--out packages/eval/datasets/v3/accepted-retrofitted-materia.jsonl] \
 *     [--db data/leyabierta.db]
 *
 * Emits stats: how many records had their materia changed, breakdown of
 * old → new transitions.
 */

import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isGeographicMateria } from "./sampling/quotas.ts";
import { pickMostRelevantMateria } from "./sampling/strata.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const inDir = flag("in") ?? "packages/eval/datasets/v3";
const outPath = flag("out") ?? `${inDir}/accepted-retrofitted-materia.jsonl`;
const dbPath = flag("db") ?? "data/leyabierta.db";

interface AcceptedRecord {
	id: string;
	question: string;
	materia: string;
	expectedArticles: Array<{ norm: string; article: string; primary: boolean }>;
	jurisdiction?: string;
	[k: string]: unknown;
}

// Helper to extract the article text from the DB for a given (norm, article).
function articleTextFor(
	db: Database,
	norm: string,
	article: string,
): string | null {
	const row = db
		.query<{ current_text: string }, [string, string]>(
			"SELECT current_text FROM blocks WHERE norm_id = ? AND block_id = ? LIMIT 1",
		)
		.get(norm, article);
	return row?.current_text ?? null;
}

function materiasFor(db: Database, norm: string): string[] {
	// Mirror strata.ts:ensureLoaded — drop geographic materia tags like
	// "Cataluña", "Andalucía" etc. They are not topical and would dominate
	// any token-overlap score on regional norms.
	return db
		.query<{ materia: string }, [string]>(
			"SELECT materia FROM materias WHERE norm_id = ?",
		)
		.all(norm)
		.map((r) => r.materia)
		.filter((m) => !isGeographicMateria(m));
}

const db = new Database(dbPath, { readonly: true });

// Build the corpus top-materia set (top 100 by frequency, mirroring strata.ts).
// Filter out geographic tags so the relevance scorer doesn't pick a region
// name on regional norms.
const topMaterias = new Set(
	db
		.query<{ materia: string }, []>(
			"SELECT materia, COUNT(*) as n FROM materias GROUP BY materia ORDER BY n DESC LIMIT 200",
		)
		.all()
		.map((r) => r.materia)
		.filter((m) => !isGeographicMateria(m))
		.slice(0, 100),
);
console.log(`Loaded top-materia set: ${topMaterias.size} entries`);

const entries = await readdir(inDir);
const files = entries
	.filter(
		(f) =>
			f.startsWith("accepted-") &&
			f.endsWith(".jsonl") &&
			// Exclude our own output if it ended up in the dir.
			!f.includes("retrofitted") &&
			!f.includes("recovery") &&
			!f.includes("audit"),
	)
	.map((f) => join(inDir, f));

let total = 0;
let changed = 0;
let unchanged = 0;
let primaryMissing = 0;
let textMissing = 0;
const transitions = new Map<string, number>();

const outRecords: Array<{
	id: string;
	question: string;
	originalMateria: string;
	newMateria: string;
	transitionTag: "kept" | "changed" | "no-primary" | "no-text" | "no-materias";
	primary?: { norm: string; article: string };
	candidateMaterias?: string[];
}> = [];

for (const file of files) {
	const text = await Bun.file(file).text();
	if (!text.trim()) continue;
	for (const line of text.split("\n").filter(Boolean)) {
		total++;
		let r: AcceptedRecord;
		try {
			r = JSON.parse(line) as AcceptedRecord;
		} catch {
			continue;
		}
		const primary = r.expectedArticles?.find((a) => a.primary);
		if (!primary) {
			primaryMissing++;
			outRecords.push({
				id: r.id,
				question: r.question,
				originalMateria: r.materia,
				newMateria: r.materia,
				transitionTag: "no-primary",
			});
			continue;
		}

		const articleText = articleTextFor(db, primary.norm, primary.article);
		if (!articleText) {
			textMissing++;
			outRecords.push({
				id: r.id,
				question: r.question,
				originalMateria: r.materia,
				newMateria: r.materia,
				transitionTag: "no-text",
				primary,
			});
			continue;
		}

		const materias = materiasFor(db, primary.norm);
		if (materias.length === 0) {
			outRecords.push({
				id: r.id,
				question: r.question,
				originalMateria: r.materia,
				newMateria: r.materia,
				transitionTag: "no-materias",
				primary,
			});
			continue;
		}

		const newMateria = pickMostRelevantMateria(
			materias,
			articleText,
			topMaterias,
		);
		const tag = newMateria === r.materia ? "kept" : "changed";
		if (tag === "changed") {
			changed++;
			const key = `${r.materia} → ${newMateria}`;
			transitions.set(key, (transitions.get(key) ?? 0) + 1);
		} else {
			unchanged++;
		}
		outRecords.push({
			id: r.id,
			question: r.question,
			originalMateria: r.materia,
			newMateria,
			transitionTag: tag,
			primary,
			candidateMaterias: materias,
		});
	}
}

await Bun.write(outPath, outRecords.map((r) => JSON.stringify(r)).join("\n"));

console.log(`\n=== Materia retrofit report ===`);
console.log(`Total accepted records: ${total}`);
console.log(`Kept (no change): ${unchanged}`);
console.log(
	`Changed: ${changed} (${total > 0 ? ((changed / total) * 100).toFixed(1) : 0}%)`,
);
console.log(`No primary article: ${primaryMissing}`);
console.log(`Article text not in DB: ${textMissing}`);

console.log(`\nTop 20 transitions (old → new):`);
const sorted = [...transitions].sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted.slice(0, 20)) {
	console.log(`  ${v}× ${k}`);
}
console.log(`\nFull output: ${outPath}`);
console.log(
	`\nReminder: the original accepted-*.jsonl files are NOT modified.`,
);
console.log(
	`To apply: re-feed records through the pipeline or manually merge.`,
);

db.close();
