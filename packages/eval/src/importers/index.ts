/**
 * Combined importer for the 114 human seed questions (50 citizen + 64 RAG).
 *
 * Writes `packages/eval/datasets/seeds/v3-seeds.json` as a Dataset object
 * with a populated `meta` block. This is the canonical v3 seed file used by
 * subsequent stages (annotation, splitting, evaluation).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Dataset, DatasetMeta, EvalQuestion } from "../schema.ts";
import { importCitizenQuestions } from "./citizen-importer.ts";
import { importRagQuestions } from "./rag-importer.ts";

export { importCitizenQuestions } from "./citizen-importer.ts";
export { importRagQuestions } from "./rag-importer.ts";

export const SEED_OUT_PATH = "packages/eval/datasets/seeds/v3-seeds.json";

export interface RunImportOptions {
	/** Repo root. Defaults to process.cwd(). */
	repoRoot?: string;
	/** Output path relative to repoRoot. Defaults to SEED_OUT_PATH. */
	outPath?: string;
	/** Override the createdAt timestamp (for deterministic tests). */
	now?: string;
}

export interface RunImportResult {
	dataset: Dataset;
	outAbsPath: string;
}

export async function runImport(
	opts: RunImportOptions = {},
): Promise<RunImportResult> {
	const repoRoot = opts.repoRoot ?? process.cwd();
	const outPath = opts.outPath ?? SEED_OUT_PATH;
	const now = opts.now ?? new Date().toISOString();

	const [citizen, rag] = await Promise.all([
		importCitizenQuestions(repoRoot, now),
		importRagQuestions(repoRoot, now),
	]);

	// Final dedup across both sources by exact question text. Citizen wins
	// over RAG if the same string somehow appears in both (citizen voice is
	// the more curated source).
	const byQuestion = new Map<string, EvalQuestion>();
	for (const q of citizen) byQuestion.set(q.question, q);
	for (const q of rag) {
		if (!byQuestion.has(q.question)) byQuestion.set(q.question, q);
	}

	const questions = [...byQuestion.values()];
	const meta = buildMeta(questions, now);
	const dataset: Dataset = { meta, questions };

	const outAbsPath = resolve(repoRoot, outPath);
	await mkdir(dirname(outAbsPath), { recursive: true });
	await writeFile(outAbsPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");

	return { dataset, outAbsPath };
}

function buildMeta(questions: EvalQuestion[], now: string): DatasetMeta {
	const bySource: DatasetMeta["bySource"] = {
		"human-citizen": 0,
		"human-rag": 0,
		"agent-generated": 0,
	};
	const byVoice: DatasetMeta["byVoice"] = { citizen: 0, formal: 0 };
	const bySplit: DatasetMeta["bySplit"] = { train: 0, val: 0, test: 0 };
	const byMateria: Record<string, number> = {};
	const byJurisdiction: Record<string, number> = {};

	for (const q of questions) {
		bySource[q.provenance.source]++;
		byVoice[q.voice]++;
		bySplit[q.split]++;
		byMateria[q.materia] = (byMateria[q.materia] ?? 0) + 1;
		byJurisdiction[q.jurisdiction] = (byJurisdiction[q.jurisdiction] ?? 0) + 1;
	}

	return {
		version: 3,
		createdAt: now,
		description:
			"Ley Abierta v3 eval seeds: 114 human-imported questions (50 citizen-voice + 64 formal-register RAG). expectedArticles and materia normalization to be filled by a later annotation pass; splits assigned in Fase 5.",
		totalQuestions: questions.length,
		bySource,
		byVoice,
		bySplit,
		byMateria,
		byJurisdiction,
	};
}
