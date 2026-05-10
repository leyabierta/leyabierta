/**
 * Importer for `data/eval-answers-*.json`.
 *
 * The 24 RAG run files are 24 different configs run over the SAME ~64
 * formal-register questions. We dedupe by exact question string. For each
 * unique question we pick a representative row from `eval-answers-484k-v2.json`
 * when available (it contains all 64), otherwise the first occurrence.
 *
 * - voice: "formal"
 * - provenance.source: "human-rag"
 * - provenance.originalExpectedAnswer: copied from `expectedAnswer`.
 * - materia: "unclassified" (the original categories — clear / cross-law /
 *   out-of-scope — are about RAG difficulty, not topical area).
 * - jurisdiction: derived from expectedNorms; defaults to "es".
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EvalQuestion } from "../schema.ts";
import { hashQuestionId, jurisdictionFromNorms } from "./util.ts";

interface RagRow {
	id: number;
	question: string;
	category: string;
	expectedAnswer?: string;
	expectedNorms?: string[];
}

interface RagFile {
	results: RagRow[];
	timestamp?: string;
}

const PREFERRED_FILE = "eval-answers-484k-v2.json";

export async function importRagQuestions(
	repoRoot: string,
	now: string,
): Promise<EvalQuestion[]> {
	const dataDir = resolve(repoRoot, "data");
	const allFiles = await readdir(dataDir);
	const ragFiles = allFiles
		.filter((f) => f.startsWith("eval-answers-") && f.endsWith(".json"))
		.sort((a, b) => {
			// Bring the preferred representative first.
			if (a === PREFERRED_FILE) return -1;
			if (b === PREFERRED_FILE) return 1;
			return a.localeCompare(b);
		});

	const seen = new Map<string, { row: RagRow; sourceFile: string }>();

	for (const file of ragFiles) {
		const path = resolve(dataDir, file);
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as RagFile;
		for (const row of parsed.results) {
			const q = row.question.trim();
			if (!seen.has(q)) {
				seen.set(q, { row, sourceFile: file });
			}
		}
	}

	const out: EvalQuestion[] = [];
	for (const [question, { row, sourceFile }] of seen) {
		const expectedNorms = row.expectedNorms ?? [];
		out.push({
			id: hashQuestionId(question),
			question,
			voice: "formal",
			expectedNorms: [...expectedNorms],
			expectedArticles: [],
			materia: "unclassified",
			jurisdiction: jurisdictionFromNorms(expectedNorms),
			difficulty: "medium",
			split: "train",
			provenance: {
				source: "human-rag",
				importedFrom: `data/${sourceFile}`,
				originalId: row.id,
				originalCategory: row.category,
				originalExpectedAnswer: row.expectedAnswer,
			},
			createdAt: now,
			schemaVersion: 3,
		});
	}

	return out;
}
