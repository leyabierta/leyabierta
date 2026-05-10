/**
 * Alternative Finder.
 *
 * For the agentic pipeline: given a final question and a primary `(norm,
 * article)`, finds OTHER articles in the corpus that legitimately answer
 * the same question. Two-stage:
 *
 *   1. Retrieval (BM25 over `blocks_fts` + later: vectors): top-K
 *      candidates that aren't the primary.
 *   2. LLM voter: rules out duplicates, transitorias, tangentials.
 *
 * For now we ship a BM25-only retrieval (cheap, no embeddings required for
 * candidate generation). Vectors can be plugged in later if recall on
 * paraphrased questions is too low.
 *
 * Pilot can run with maxCandidates=0 → no alternatives, only primary. That
 * lets us iterate prompts without depending on this agent's quality.
 */

import type { Database } from "bun:sqlite";
import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import type { ExpectedArticle } from "../schema.ts";
import {
	ALTERNATIVE_FINDER_JSON_SCHEMA,
	ALTERNATIVE_FINDER_PROMPT_ID,
	ALTERNATIVE_FINDER_SYSTEM,
	type AlternativeFinderOutput,
	alternativeFinderUserPrompt,
} from "./prompts/alternative-finder.ts";
import type { AlternativeFinderAgent } from "./types.ts";

interface Candidate {
	norm: string;
	article: string;
	title: string;
	text: string;
}

export interface AlternativeFinderDeps {
	db: Database;
	llm: NanLlmClient;
	trace?: EvalTrace;
	maxCandidates?: number;
	includeOnlyVigente?: boolean;
}

export function makeAlternativeFinderAgent(
	deps: AlternativeFinderDeps,
): AlternativeFinderAgent {
	const { db, llm, trace } = deps;
	const maxCandidates = deps.maxCandidates ?? 8;
	const includeOnlyVigente = deps.includeOnlyVigente ?? true;

	return {
		async find(question: string, primary): Promise<ExpectedArticle[]> {
			if (maxCandidates === 0) return [];

			const candidates = bm25Candidates(db, question, {
				excludeNorm: primary.norm,
				excludeBlock: primary.article,
				limit: maxCandidates,
				vigenteOnly: includeOnlyVigente,
			});
			if (candidates.length === 0) return [];

			const primaryRow = loadArticle(db, primary.norm, primary.article);
			if (!primaryRow) return [];

			const result = await llm.complete<AlternativeFinderOutput>({
				systemPrompt: ALTERNATIVE_FINDER_SYSTEM,
				userPrompt: alternativeFinderUserPrompt({
					question,
					primary: primaryRow,
					candidates,
				}),
				jsonSchema: ALTERNATIVE_FINDER_JSON_SCHEMA as unknown as Record<
					string,
					unknown
				>,
				jsonSchemaName: ALTERNATIVE_FINDER_PROMPT_ID,
				temperature: 0.1,
				maxTokens: 800,
				trace,
				spanName: "alternative-finder",
			});

			return result.value.decisions
				.filter((d) => d.alsoAnswers && d.candidateIndex < candidates.length)
				.map((d): ExpectedArticle => {
					const c = candidates[d.candidateIndex]!;
					return { norm: c.norm, article: c.article, primary: false };
				});
		},
	};
}

function bm25Candidates(
	db: Database,
	question: string,
	opts: {
		excludeNorm: string;
		excludeBlock: string;
		limit: number;
		vigenteOnly: boolean;
	},
): Candidate[] {
	// blocks_fts is the article-level FTS5 index (per CLAUDE.md / blocks-fts.ts).
	// FTS5 MATCH expects a query string; sanitize basic punctuation.
	const cleanQuery = question
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.filter((w) => w.length >= 3)
		.slice(0, 8)
		.join(" OR ");
	if (!cleanQuery) return [];

	const sql = opts.vigenteOnly
		? `SELECT b.norm_id, b.block_id, b.title, b.current_text
		   FROM blocks_fts f
		   JOIN blocks b ON b.norm_id = f.norm_id AND b.block_id = f.block_id
		   JOIN norms n ON n.id = b.norm_id
		   WHERE f.blocks_fts MATCH ?
		     AND n.status = 'vigente'
		     AND b.block_type = 'precepto'
		     AND b.block_id NOT LIKE 'da%'
		     AND b.block_id NOT LIKE 'df%'
		     AND b.block_id NOT LIKE 'dt%'
		     AND b.block_id NOT LIKE 'dd%'
		     AND length(b.current_text) >= 200
		     AND NOT (b.norm_id = ? AND b.block_id = ?)
		   ORDER BY rank LIMIT ?`
		: `SELECT b.norm_id, b.block_id, b.title, b.current_text
		   FROM blocks_fts f
		   JOIN blocks b ON b.norm_id = f.norm_id AND b.block_id = f.block_id
		   WHERE f.blocks_fts MATCH ?
		     AND b.block_type = 'precepto'
		     AND b.block_id NOT LIKE 'da%'
		     AND b.block_id NOT LIKE 'df%'
		     AND b.block_id NOT LIKE 'dt%'
		     AND b.block_id NOT LIKE 'dd%'
		     AND length(b.current_text) >= 200
		     AND NOT (b.norm_id = ? AND b.block_id = ?)
		   ORDER BY rank LIMIT ?`;
	try {
		const rows = db
			.prepare(sql)
			.all(
				cleanQuery,
				opts.excludeNorm,
				opts.excludeBlock,
				opts.limit,
			) as Array<{
			norm_id: string;
			block_id: string;
			title: string;
			current_text: string;
		}>;
		return rows.map((r) => ({
			norm: r.norm_id,
			article: r.block_id,
			title: r.title,
			text: r.current_text,
		}));
	} catch (_err) {
		// FTS5 can choke on very short queries or unusual operators; degrade
		// gracefully to no alternatives rather than crashing the pipeline.
		return [];
	}
}

function loadArticle(
	db: Database,
	normId: string,
	blockId: string,
): Candidate | null {
	const row = db
		.prepare(
			"SELECT norm_id, block_id, title, current_text FROM blocks WHERE norm_id = ? AND block_id = ?",
		)
		.get(normId, blockId) as
		| { norm_id: string; block_id: string; title: string; current_text: string }
		| undefined;
	if (!row) return null;
	return {
		norm: row.norm_id,
		article: row.block_id,
		title: row.title,
		text: row.current_text,
	};
}
