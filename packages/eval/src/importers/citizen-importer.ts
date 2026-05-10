/**
 * Importer for `packages/api/research/datasets/citizen-queries.json`.
 *
 * Converts the 50 citizen-voice questions to the v3 EvalQuestion schema.
 *
 * - voice: "citizen"
 * - provenance.source: "human-citizen"
 * - materia: kept as the original ad-hoc category string (will be normalized
 *   by a later annotation pass).
 * - jurisdiction: derived from `expectedNorms` prefixes; defaults to "es".
 * - expectedArticles: empty (filled later by annotation pass).
 * - difficulty: "medium" placeholder.
 * - split: "train" placeholder; real split assigned in Fase 5.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EvalQuestion } from "../schema.ts";
import { hashQuestionId, jurisdictionFromNorms } from "./util.ts";

interface CitizenRow {
	id: number;
	question: string;
	category: string;
	expectedNorms: string[];
	rationale?: string;
}

interface CitizenFile {
	results: CitizenRow[];
}

export const CITIZEN_QUERIES_PATH =
	"packages/api/research/datasets/citizen-queries.json";

export async function importCitizenQuestions(
	repoRoot: string,
	now: string,
): Promise<EvalQuestion[]> {
	const path = resolve(repoRoot, CITIZEN_QUERIES_PATH);
	const raw = await readFile(path, "utf8");
	const parsed = JSON.parse(raw) as CitizenFile;

	const seen = new Set<string>();
	const out: EvalQuestion[] = [];

	for (const row of parsed.results) {
		const question = row.question.trim();
		if (seen.has(question)) continue;
		seen.add(question);

		out.push({
			id: hashQuestionId(question),
			question,
			voice: "citizen",
			expectedNorms: [...row.expectedNorms],
			expectedArticles: [],
			materia: row.category || "unclassified",
			jurisdiction: jurisdictionFromNorms(row.expectedNorms),
			difficulty: "medium",
			split: "train",
			provenance: {
				source: "human-citizen",
				importedFrom: CITIZEN_QUERIES_PATH,
				originalId: row.id,
				originalCategory: row.category,
			},
			createdAt: now,
			schemaVersion: 3,
		});
	}

	return out;
}
