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
				maxTokens: 600,
				trace,
				spanName,
			});
			const vote: JudgeVote = {
				model: llm.model,
				prompt: promptId,
				verdict: result.value.verdict,
				reason:
					result.value.reason +
					(result.value.concerns.length > 0
						? ` || concerns: ${result.value.concerns.join("; ")}`
						: ""),
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
 * 3-judge panel with explicit decision rules:
 *   3/3 accept  → accept
 *   2/3 accept  → accept
 *   1/3 accept  → borderline (human review queue)
 *   0/3 accept  → reject
 *
 * Calls the three judges concurrently (each takes a slot from the NaN
 * semaphore — so the panel uses 3 of 5 slots while it runs).
 */
export function makeJudgePanel(judges: JudgeAgent[]): JudgePanel {
	if (judges.length !== 3) {
		throw new Error(
			`Judge panel requires exactly 3 judges, got ${judges.length}`,
		);
	}
	return {
		judges,
		async decide(input: {
			question: string;
			voice: Voice;
			expectedArticles: { norm: string; article: string; primary: boolean }[];
		}): Promise<JudgePanelDecision> {
			const votes = await Promise.all(judges.map((j) => j.judge(input)));
			const accepts = votes.filter((v) => v.verdict === "accept").length;
			const rejects = votes.length - accepts;
			let verdict: JudgePanelDecision["verdict"];
			if (accepts >= 2) verdict = "accept";
			else if (accepts === 0) verdict = "reject";
			else verdict = "borderline";
			return { verdict, votes, accepts, rejects };
		},
	};
}
