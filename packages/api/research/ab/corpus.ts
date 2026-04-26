/**
 * Corpus selection for the embeddings A/B.
 *
 * Builds a mixed corpus of:
 *  - All norms referenced in eval-answers-504-omnibus.json (23 ground-truth norms)
 *  - Top-100 most-cited vigente norms by (reforms * 2 + articles) — as distractors
 *
 * Returns the same sub-chunked block list that production's sync-embeddings.ts
 * would produce, using identical formatting:
 *   `title: {norm_title} | text: {chunk_title}\n\n{chunk_text}`
 *
 * This guarantees the A/B compares the *same semantic units* across models.
 */

import type { Database } from "bun:sqlite";
import { splitByApartados } from "../../src/services/rag/subchunk.ts";

export interface PreparedBlock {
	normId: string;
	blockId: string;
	text: string; // formatted exactly like production
	/** Raw article text (no title prefix) — for "raw" variants if we add one later. */
	rawText: string;
	/** Parent article if this is a sub-chunk, same as blockId otherwise. */
	parentBlockId: string;
}

export interface CorpusPlan {
	normIds: string[];
	blocks: PreparedBlock[];
	/** For debugging / logging. */
	counts: {
		evalNorms: number;
		distractorNorms: number;
		articles: number;
		chunks: number;
	};
}

const DEFAULT_EVAL_PATH = "./data/eval-answers-504-omnibus.json";

interface EvalData {
	results: Array<{
		id: number;
		question: string;
		expectedNorms?: string[];
	}>;
}

export async function readEvalNorms(evalPath: string): Promise<Set<string>> {
	const data = (await Bun.file(evalPath).json()) as EvalData;
	const norms = new Set<string>();
	for (const r of data.results) {
		for (const n of r.expectedNorms ?? []) norms.add(n);
	}
	return norms;
}

export function selectTopNorms(
	db: Database,
	n: number,
	exclude: Set<string>,
): string[] {
	// Same ranking as sync-embeddings.ts: reforms * 2 + articles.
	const rows = db
		.query<{ id: string }, [number]>(
			`SELECT n.id FROM norms n
			 WHERE n.status != 'derogada'
			 ORDER BY (SELECT COUNT(*) FROM reforms r WHERE r.norm_id = n.id) * 2
			        + (SELECT COUNT(*) FROM blocks b WHERE b.norm_id = n.id AND b.block_type = 'precepto' AND b.current_text != '') DESC
			 LIMIT ?`,
		)
		.all(n * 2); // over-fetch so we can skip excluded

	const out: string[] = [];
	for (const r of rows) {
		if (out.length >= n) break;
		if (exclude.has(r.id)) continue;
		out.push(r.id);
	}
	return out;
}

export async function buildCorpusPlan(
	db: Database,
	opts: {
		evalPath?: string;
		distractors?: number;
	} = {},
): Promise<CorpusPlan> {
	const evalPath = opts.evalPath ?? DEFAULT_EVAL_PATH;
	const evalNorms = await readEvalNorms(evalPath);
	const distractors = selectTopNorms(db, opts.distractors ?? 100, evalNorms);
	const normIds = [...evalNorms, ...distractors];

	const ph = normIds.map(() => "?").join(",");
	const articles = db
		.query<
			{
				norm_id: string;
				norm_title: string;
				block_id: string;
				title: string;
				current_text: string;
			},
			string[]
		>(
			`SELECT b.norm_id, n.title as norm_title, b.block_id, b.title, b.current_text
			 FROM blocks b
			 JOIN norms n ON n.id = b.norm_id
			 WHERE b.norm_id IN (${ph})
			   AND b.block_type = 'precepto'
			   AND b.current_text != ''
			   AND n.status != 'derogada'
			 ORDER BY b.norm_id, b.position`,
		)
		.all(...normIds);

	const blocks: PreparedBlock[] = [];
	for (const a of articles) {
		const sub = splitByApartados(a.block_id, a.title, a.current_text);
		if (sub) {
			for (const chunk of sub) {
				blocks.push({
					normId: a.norm_id,
					blockId: chunk.blockId,
					parentBlockId: a.block_id,
					text: `title: ${a.norm_title} | text: ${chunk.title}\n\n${chunk.text}`,
					rawText: chunk.text,
				});
			}
		} else {
			blocks.push({
				normId: a.norm_id,
				blockId: a.block_id,
				parentBlockId: a.block_id,
				text: `title: ${a.norm_title} | text: ${a.title}\n\n${a.current_text}`,
				rawText: a.current_text,
			});
		}
	}

	return {
		normIds,
		blocks,
		counts: {
			evalNorms: evalNorms.size,
			distractorNorms: distractors.length,
			articles: articles.length,
			chunks: blocks.length,
		},
	};
}
