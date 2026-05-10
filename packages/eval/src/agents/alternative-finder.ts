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

export interface AlternativeFinderStats {
	totalCalls: number;
	zeroCandidates: number; // BM25 returned nothing
	zeroAlsoAnswers: number; // candidates returned but LLM said none answer
	alternativesFound: number; // total alternatives accepted across all calls
	candidatesPerCall: number[]; // raw counts for histogram
}

export function makeAlternativeFinderAgent(
	deps: AlternativeFinderDeps,
): AlternativeFinderAgent & { stats: AlternativeFinderStats } {
	const { db, llm, trace } = deps;
	const maxCandidates = deps.maxCandidates ?? 8;
	const includeOnlyVigente = deps.includeOnlyVigente ?? true;

	const stats: AlternativeFinderStats = {
		totalCalls: 0,
		zeroCandidates: 0,
		zeroAlsoAnswers: 0,
		alternativesFound: 0,
		candidatesPerCall: [],
	};

	return {
		stats,
		async find(question: string, primary): Promise<ExpectedArticle[]> {
			if (maxCandidates === 0) return [];
			stats.totalCalls += 1;

			const primaryRow = loadArticle(db, primary.norm, primary.article);
			if (!primaryRow) return [];

			const candidates = bm25Candidates(db, question, primaryRow, {
				excludeNorm: primary.norm,
				excludeBlock: primary.article,
				limit: maxCandidates,
				vigenteOnly: includeOnlyVigente,
			});
			stats.candidatesPerCall.push(candidates.length);
			if (candidates.length === 0) {
				stats.zeroCandidates += 1;
				return [];
			}

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

			const accepted = result.value.decisions
				.filter((d) => d.alsoAnswers && d.candidateIndex < candidates.length)
				.map((d): ExpectedArticle => {
					const c = candidates[d.candidateIndex]!;
					return { norm: c.norm, article: c.article, primary: false };
				});

			if (accepted.length === 0) stats.zeroAlsoAnswers += 1;
			stats.alternativesFound += accepted.length;
			return accepted;
		},
	};
}

// Spanish stopwords likely to dominate FTS5 queries without being informative.
// Kept small and conservative; we only drop them when removing them still leaves
// at least 3 informative tokens.
const STOPWORDS = new Set([
	"que",
	"qué",
	"como",
	"cómo",
	"cuando",
	"cuándo",
	"donde",
	"dónde",
	"para",
	"por",
	"con",
	"sin",
	"los",
	"las",
	"del",
	"una",
	"uno",
	"unas",
	"unos",
	"este",
	"esta",
	"esto",
	"esos",
	"esas",
	"esa",
	"ese",
	"pero",
	"porque",
	"sobre",
	"entre",
	"hasta",
	"desde",
	"muy",
	"mas",
	"más",
	"ser",
	"soy",
	"era",
	"eres",
	"han",
	"hay",
	"haber",
	"tengo",
	"tener",
	"tiene",
	"tuve",
	"hace",
	"hacer",
	"hizo",
	"voy",
	"ido",
	"esta",
	"estoy",
	"estas",
	"estamos",
	"estan",
	"están",
	"mio",
	"mía",
	"mis",
	"tus",
	"sus",
	"nos",
	"les",
	"yo",
	"tu",
	"él",
	"ella",
	"ellos",
	"ellas",
	"nosotros",
	"vosotros",
	"si",
	"sí",
	"no",
	"ni",
	"ya",
	"aún",
	"aun",
	"todo",
	"toda",
	"todos",
	"todas",
	"otro",
	"otra",
	"otros",
	"otras",
	"algún",
	"algun",
	"alguna",
	"algunos",
	"algunas",
	"cual",
	"cuál",
	"cuales",
	"cuáles",
	"quien",
	"quién",
	"quienes",
	"quiénes",
	"a",
	"e",
	"o",
	"u",
	"y",
	"de",
	"en",
	"al",
	"el",
	"la",
	"lo",
	"me",
	"te",
	"se",
	"mi",
	"su",
]);

function tokenize(question: string): string[] {
	return question
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.filter((w) => w.length >= 3);
}

function buildTokens(question: string): string[] {
	const all = tokenize(question);
	const noStop = all.filter((w) => !STOPWORDS.has(w));
	// Only drop stopwords if doing so keeps the query meaningful.
	const chosen = noStop.length >= 3 ? noStop : all;
	// Dedupe while preserving order.
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const w of chosen) {
		if (!seen.has(w)) {
			seen.add(w);
			unique.push(w);
		}
	}
	return unique.slice(0, 8);
}

function bm25Candidates(
	db: Database,
	question: string,
	primary: Candidate,
	opts: {
		excludeNorm: string;
		excludeBlock: string;
		limit: number;
		vigenteOnly: boolean;
	},
): Candidate[] {
	// blocks_fts is the article-level FTS5 index (per CLAUDE.md / blocks-fts.ts).
	const qTokens = buildTokens(question);
	// If we can't even produce 3 informative tokens from the question, skip —
	// caller will treat as no alternatives. This avoids wildly broad
	// single-word FTS queries.
	if (qTokens.length < 3) return [];

	// Citizen vocabulary often diverges from legal vocabulary
	// ("casero" / "arrendador", "echarme" / "desahucio"). To bridge that, we
	// also pull the most informative tokens from the primary article's
	// title + first chunk of its text and add them as extra OR terms. This
	// anchors retrieval to legally-related articles even when the question
	// uses lay terms.
	const primaryTokens = buildPrimaryAnchorTokens(primary, qTokens);

	// Try a high-precision AND first restricted to question tokens.
	const andRows = runFtsQuery(db, qTokens.join(" AND "), opts);
	if (andRows.length >= 2) return andRows;

	// OR query expanded with primary-anchor tokens to overcome
	// vocabulary mismatch between citizen language and legal language.
	const orTokens = dedup([...qTokens, ...primaryTokens]).slice(0, 14);
	const orRows = runFtsQuery(db, orTokens.join(" OR "), opts);
	if (andRows.length === 0) return orRows;

	// Union: keep AND rows first (higher precision), then fill from OR rows.
	const seen = new Set<string>(andRows.map((r) => `${r.norm}#${r.article}`));
	const merged = [...andRows];
	for (const r of orRows) {
		const key = `${r.norm}#${r.article}`;
		if (!seen.has(key)) {
			seen.add(key);
			merged.push(r);
			if (merged.length >= opts.limit) break;
		}
	}
	return merged.slice(0, opts.limit);
}

function dedup(xs: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const x of xs) {
		if (!seen.has(x)) {
			seen.add(x);
			out.push(x);
		}
	}
	return out;
}

function buildPrimaryAnchorTokens(
	primary: Candidate,
	questionTokens: string[],
): string[] {
	// Extract distinctive tokens from the primary article's title + start of
	// body. The first ~600 chars typically contain the rúbrica + leading
	// definitional sentence — high-signal legal vocabulary. We score by
	// frequency and prefer multi-occurrence tokens.
	const source = `${primary.title} ${primary.text.slice(0, 600)}`;
	const tokens = tokenize(source).filter((w) => !STOPWORDS.has(w));
	const freq = new Map<string, number>();
	for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
	// Drop tokens that already appear in the question (no extra signal).
	const qSet = new Set(questionTokens);
	const ranked = [...freq.entries()]
		.filter(([t]) => !qSet.has(t))
		.filter(([t]) => t.length >= 4) // skip noise like "art"
		.sort((a, b) => b[1] - a[1])
		.map(([t]) => t);
	return ranked.slice(0, 6);
}

function runFtsQuery(
	db: Database,
	ftsQuery: string,
	opts: {
		excludeNorm: string;
		excludeBlock: string;
		limit: number;
		vigenteOnly: boolean;
	},
): Candidate[] {
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
		   ORDER BY f.rank LIMIT ?`
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
		   ORDER BY f.rank LIMIT ?`;
	try {
		const rows = db
			.prepare(sql)
			.all(ftsQuery, opts.excludeNorm, opts.excludeBlock, opts.limit) as Array<{
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
