/**
 * Agent role contracts. Every stage of the pipeline is a small async function
 * with a typed input/output. The orchestrator (`pipeline.ts`) wires them.
 *
 * Models live behind a thin `LlmClient` interface so we can mock for tests,
 * route to Qwen vs Gemma per stage, and add a third judge later without
 * touching call sites.
 */

import type {
	ExpectedArticle,
	JudgeVerdict,
	JudgeVote,
	Voice,
} from "../schema.ts";

export interface LlmClient {
	/** Identifier for traces and provenance, e.g. "qwen3.6-nan". */
	model: string;
	complete<T>(opts: {
		systemPrompt: string;
		userPrompt: string;
		jsonSchema?: object;
		temperature?: number;
		maxTokens?: number;
	}): Promise<{ value: T; tookMs: number }>;
}

// ── Sampler ───────────────────────────────────────────────────────────────

export interface ArticleSeed {
	normId: string;
	articleId: string;
	articleTitle: string;
	articleText: string;
	materia: string;
	jurisdiction: string;
	rank: string;
	publicationYear: number;
}

export interface Sampler {
	/**
	 * Returns up to `n` `(norm, article)` candidates, stratified by
	 * (materia × jurisdiction × rank × decade). Avoids previously sampled
	 * seeds via `seenSeeds`.
	 */
	sample(opts: {
		n: number;
		seenSeeds: Set<string>; // "normId#articleId"
	}): Promise<ArticleSeed[]>;
}

// ── Persona generator ─────────────────────────────────────────────────────

export interface Persona {
	label: string; // "inquilino agobiado tras subida del IPC"
	situation: string; // 2-3 sentence backstory
	register: Voice; // citizen | formal
}

export interface PersonaAgent {
	generate(seed: ArticleSeed): Promise<Persona[]>;
}

// ── Question generator ────────────────────────────────────────────────────

export interface QuestionDraft {
	text: string;
	persona: Persona;
	generator: { model: string; prompt: string };
}

export interface QuestionGeneratorAgent {
	generate(seed: ArticleSeed, persona: Persona): Promise<QuestionDraft>;
}

// ── Filters / critics ─────────────────────────────────────────────────────

export interface LeakDetectorAgent {
	check(draft: QuestionDraft): Promise<{ passed: boolean; reasons: string[] }>;
}

export interface AnswerabilityAgent {
	check(
		draft: QuestionDraft,
		seed: ArticleSeed,
	): Promise<{ passed: boolean; reason: string }>;
}

export interface CitizenVoiceCriticAgent {
	rewrite(draft: QuestionDraft): Promise<{
		text: string;
		passes: number; // how many rewrite passes were needed
		passed: boolean; // false if it remained too formal after retries
	}>;
}

// ── Alternative finder (uses our retrieval) ───────────────────────────────

export interface AlternativeFinderAgent {
	/**
	 * Given a final question and a primary (norm, article), returns other
	 * articles that legitimately answer it. Implementation calls our hybrid
	 * retrieval (BM25 + vectors) and asks an LLM to vote per candidate.
	 */
	find(question: string, primary: ExpectedArticle): Promise<ExpectedArticle[]>;
}

// ── Judges ────────────────────────────────────────────────────────────────

export interface JudgeAgent {
	model: string;
	promptId: string;
	judge(input: {
		question: string;
		voice: Voice;
		expectedArticles: ExpectedArticle[];
	}): Promise<JudgeVote>;
}

export interface JudgePanelDecision {
	verdict: JudgeVerdict | "borderline";
	votes: JudgeVote[];
	accepts: number;
	rejects: number;
}

export interface JudgePanel {
	judges: JudgeAgent[];
	/** Decide. 3 judges, 3/3 → accept, 0/3 → reject, 1-2 → borderline. */
	decide(input: {
		question: string;
		voice: Voice;
		expectedArticles: ExpectedArticle[];
	}): Promise<JudgePanelDecision>;
}

// ── Difficulty ────────────────────────────────────────────────────────────

export interface DifficultyScorerAgent {
	score(input: {
		question: string;
		expectedArticles: ExpectedArticle[];
	}): Promise<"easy" | "medium" | "hard">;
}

// ── Dedup ─────────────────────────────────────────────────────────────────

export interface DedupAgent {
	/** Returns true if the question is too similar to one already accepted. */
	isDuplicate(question: string): Promise<boolean>;
	add(question: string): Promise<void>;
}
