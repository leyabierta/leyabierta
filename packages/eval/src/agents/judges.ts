import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import type { JudgeVote, Voice } from "../schema.ts";
import {
	JUDGE_ADVERSARIAL_PROMPT_ID,
	JUDGE_ADVERSARIAL_SYSTEM,
	JUDGE_BALANCED_PROMPT_ID,
	JUDGE_BALANCED_SYSTEM,
	JUDGE_JSON_SCHEMA,
	JUDGE_PERMISSIVE_PROMPT_ID,
	JUDGE_PERMISSIVE_SYSTEM,
	type JudgeOutput,
	judgeUserPrompt,
} from "./prompts/judges.ts";
import type { JudgeAgent, JudgePanel, JudgePanelDecision } from "./types.ts";

interface ArticleText {
	norm: string;
	article: string;
	title: string;
	text: string;
}

function makeJudge(
	llm: NanLlmClient,
	systemPrompt: string,
	promptId: string,
	spanName: string,
	trace?: EvalTrace,
	articleTextLookup?: (
		norm: string,
		article: string,
	) => { title: string; text: string } | undefined,
): JudgeAgent {
	return {
		model: llm.model,
		promptId,
		async judge(input) {
			const articleTexts: ArticleText[] = articleTextLookup
				? input.expectedArticles
						.map((a) => {
							const t = articleTextLookup(a.norm, a.article);
							if (!t) return null;
							return {
								norm: a.norm,
								article: a.article,
								title: t.title,
								text: t.text,
							};
						})
						.filter((x): x is ArticleText => x !== null)
				: [];

			const result = await llm.complete<JudgeOutput>({
				systemPrompt,
				userPrompt: judgeUserPrompt({
					question: input.question,
					voice: input.voice,
					expectedArticles: input.expectedArticles,
					articleTexts,
				}),
				jsonSchema: JUDGE_JSON_SCHEMA as unknown as Record<string, unknown>,
				jsonSchemaName: promptId,
				temperature: 0.1,
				maxTokens: 1200,
				trace,
				spanName,
			});
			const concerns = Array.isArray(result.value.concerns)
				? result.value.concerns
				: [];
			const concernsSummary =
				concerns.length > 0
					? ` || concerns: ${concerns
							.map((c) => `[${c.severity} ${c.type}] ${c.text}`)
							.join("; ")}`
					: "";
			const vote: JudgeVote = {
				model: llm.model,
				prompt: promptId,
				verdict: result.value.verdict,
				reason: result.value.reason + concernsSummary,
				concerns,
				tookMs: result.tookMs,
			};
			return vote;
		},
	};
}

export function makePermissiveJudge(
	llm: NanLlmClient,
	trace?: EvalTrace,
	articleTextLookup?: (
		norm: string,
		article: string,
	) => { title: string; text: string } | undefined,
): JudgeAgent {
	return makeJudge(
		llm,
		JUDGE_PERMISSIVE_SYSTEM,
		JUDGE_PERMISSIVE_PROMPT_ID,
		"judge-permissive",
		trace,
		articleTextLookup,
	);
}

export function makeBalancedJudge(
	llm: NanLlmClient,
	trace?: EvalTrace,
	articleTextLookup?: (
		norm: string,
		article: string,
	) => { title: string; text: string } | undefined,
): JudgeAgent {
	return makeJudge(
		llm,
		JUDGE_BALANCED_SYSTEM,
		JUDGE_BALANCED_PROMPT_ID,
		"judge-balanced",
		trace,
		articleTextLookup,
	);
}

export function makeAdversarialJudge(
	llm: NanLlmClient,
	trace?: EvalTrace,
	articleTextLookup?: (
		norm: string,
		article: string,
	) => { title: string; text: string } | undefined,
): JudgeAgent {
	return makeJudge(
		llm,
		JUDGE_ADVERSARIAL_SYSTEM,
		JUDGE_ADVERSARIAL_PROMPT_ID,
		"judge-adversarial",
		trace,
		articleTextLookup,
	);
}

/**
 * Critical concern types — a `major` concern of one of these types from a
 * rejecting judge requires unanimity to accept (Fix A). Anything else is
 * treated as a non-critical axis and obeys the simple majority rule.
 */
const CRITICAL_CONCERN_TYPES: ReadonlySet<string> = new Set([
	"leak",
	"answer-fit",
	"ambiguity",
]);

/**
 * Decision rule for the 5-judge panel.
 *
 * - `strict-5-of-5`: only unanimous accept produces `accept`; unanimous
 *   reject produces `reject`; any disagreement falls through to
 *   `borderline`. Maximizes precision of the accepted bucket.
 * - `balanced-4-of-5`: extension of Fix A from the original 3-judge
 *   panel — accept needs at least 4/5 votes AND no rejecting judge
 *   raised a major critical concern; otherwise borderline / reject.
 *   Trades a bit of precision for recall.
 */
export type PanelRule = "strict-5-of-5" | "balanced-4-of-5";

export interface MakeJudgePanelOpts {
	rule: PanelRule;
}

/**
 * 5-judge panel.
 *
 * The pilot configures two judges per family/voice combination so each
 * "axis" (permissive, adversarial) is rated by both qwen and gemma, with
 * a single balanced gemma in the middle. The panel calls all five
 * judges concurrently (each takes a slot from the NaN semaphore).
 *
 * The decision rule is selectable via `opts.rule` so we can A/B
 * `strict-5-of-5` vs `balanced-4-of-5` on the same generated dataset
 * without re-running the judges.
 */
export function makeJudgePanel(
	judges: JudgeAgent[],
	opts: MakeJudgePanelOpts,
): JudgePanel {
	if (judges.length !== 5) {
		throw new Error(
			`Judge panel requires exactly 5 judges, got ${judges.length}`,
		);
	}
	const { rule } = opts;
	return {
		judges,
		async decide(input: {
			question: string;
			voice: Voice;
			expectedArticles: { norm: string; article: string; primary: boolean }[];
		}): Promise<JudgePanelDecision> {
			const votes = await Promise.all(judges.map((j) => j.judge(input)));
			return decidePanel(votes, rule);
		},
	};
}

/**
 * Pure decision function (exported for testing). Applies the rule
 * documented above without any LLM calls.
 *
 * `strict-5-of-5`:
 *   5/5 accept → accept
 *   0/5 accept → reject
 *   anything else → borderline
 *
 * `balanced-4-of-5` (Fix A extended to 5 judges):
 *   critical concern types = {leak, answer-fit, ambiguity}
 *   if accepts >= 4:
 *     if any major critical concern was raised AND rejects > 0
 *       → borderline (escalate to human review)
 *     else → accept
 *   elif accepts == 0 → reject
 *   else → borderline (1-3 accepts is too weak for confidence)
 */
export function decidePanel(
	votes: JudgeVote[],
	rule: PanelRule,
): JudgePanelDecision {
	const acceptVotes = votes.filter((v) => v.verdict === "accept");
	const rejectVotes = votes.filter((v) => v.verdict === "reject");
	const accepts = acceptVotes.length;
	const rejects = rejectVotes.length;
	const total = votes.length;

	const criticalSet = new Set<string>();
	for (const vote of votes) {
		for (const concern of vote.concerns ?? []) {
			if (
				concern.severity === "major" &&
				CRITICAL_CONCERN_TYPES.has(concern.type)
			) {
				criticalSet.add(concern.type);
			}
		}
	}
	const criticalConcernsRaised = Array.from(criticalSet).sort();

	let verdict: JudgePanelDecision["verdict"];

	if (rule === "strict-5-of-5") {
		if (accepts === total) {
			verdict = "accept";
		} else if (accepts === 0) {
			verdict = "reject";
		} else {
			verdict = "borderline";
		}
	} else {
		// balanced-4-of-5
		if (accepts >= 4) {
			if (criticalConcernsRaised.length > 0 && rejects > 0) {
				verdict = "borderline";
			} else {
				verdict = "accept";
			}
		} else if (accepts === 0) {
			verdict = "reject";
		} else {
			verdict = "borderline";
		}
	}

	return { verdict, votes, accepts, rejects, criticalConcernsRaised };
}
