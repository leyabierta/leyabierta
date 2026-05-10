/**
 * Canonical schema for the Ley Abierta retrieval/RAG eval dataset (v3).
 *
 * Replaces the legacy 50-question `citizen-queries.json` and the 64-unique
 * `eval-answers-*.json` runs with a unified, article-level, multi-answer,
 * provenance-tracked format.
 *
 * Stable across train/val/test splits and across generations.
 */

export type Voice = "citizen" | "formal";
export type Difficulty = "easy" | "medium" | "hard";
export type Split = "train" | "val" | "test";

export type ProvenanceSource =
	| "human-citizen" // imported from citizen-queries.json (50)
	| "human-rag" // imported from eval-answers-*.json unique 64
	| "agent-generated"; // produced by the multi-agent pipeline

export type JudgeVerdict = "accept" | "reject";

export interface JudgeVote {
	model: string; // e.g. "qwen3.6-nan", "gemma4-nan"
	prompt: string; // prompt id used (e.g. "judge-strict-v1")
	verdict: JudgeVerdict;
	reason: string;
	tookMs: number;
}

export interface ExpectedArticle {
	norm: string; // BOE-A-YYYY-NNNNN or similar
	article: string; // article id as stored in DB (e.g. "a-38", "art-9.1")
	primary: boolean; // true if this is THE article that answers; false for adjacent context
}

export interface AgentProvenance {
	seedNorm: string; // the (norm, article) the question was generated from
	seedArticle: string;
	persona: string; // "inquilino agobiado", "autónomo nuevo", ...
	generatorModel: string; // "qwen3.6-nan" | "gemma4-nan"
	generatorPrompt: string; // prompt id
	leakChecks: { passed: boolean; reasons: string[] };
	answerabilityCheck: { passed: boolean; reason: string };
	citizenVoiceRewrites: number; // how many rewrite passes the critic ran
	alternativesFound: ExpectedArticle[]; // returned by Alternative Finder
	judges: JudgeVote[];
	humanReviewed: boolean;
	humanVerdict?: JudgeVerdict;
	humanNote?: string;
}

export interface HumanProvenance {
	importedFrom: string; // file path of origin
	originalId: string | number;
	originalCategory: string; // ad-hoc category before normalization
	originalExpectedAnswer?: string; // present for human-rag
}

export interface EvalQuestion {
	/** Stable hash-based id, e.g. "q_8a3b...". Survives across reruns. */
	id: string;
	/** The user-facing question text. */
	question: string;
	/** Citizen (lowercase, jargon-free) vs formal register. */
	voice: Voice;
	/** Norms that legitimately answer the question. Multi-answer allowed. */
	expectedNorms: string[];
	/** Articles within those norms. Per-article granularity for retrieval eval
	 *  on top of our per-article embeddings. Empty array allowed for
	 *  imported human-norm-only questions until annotation pass runs. */
	expectedArticles: ExpectedArticle[];
	/** BOE-style materia (normalized, not the ad-hoc category strings). */
	materia: string;
	/** ELI jurisdiction code: "es", "es-an", "es-pv", ... */
	jurisdiction: string;
	difficulty: Difficulty;
	/** Train/val/test. Disjoint by norm: same BOE-ID never in two splits. */
	split: Split;
	provenance:
		| ({ source: "agent-generated" } & AgentProvenance)
		| ({ source: "human-citizen" | "human-rag" } & HumanProvenance);
	/** ISO-8601 UTC timestamp of when this entry was finalized. */
	createdAt: string;
	/** Schema version this row was written against. */
	schemaVersion: 3;
}

export interface DatasetMeta {
	version: 3;
	createdAt: string;
	description: string;
	totalQuestions: number;
	bySource: Record<ProvenanceSource, number>;
	byVoice: Record<Voice, number>;
	bySplit: Record<Split, number>;
	byMateria: Record<string, number>;
	byJurisdiction: Record<string, number>;
}

export interface Dataset {
	meta: DatasetMeta;
	questions: EvalQuestion[];
}

/** Borderline queue entry for human review when judges disagree. */
export interface BorderlineEntry {
	question: EvalQuestion;
	votes: { accept: number; reject: number };
	rationale: string; // joined reasons from judges
}
