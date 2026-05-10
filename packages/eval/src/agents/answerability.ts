import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import {
	ANSWERABILITY_JSON_SCHEMA,
	ANSWERABILITY_PROMPT_ID,
	ANSWERABILITY_SYSTEM,
	type AnswerabilityOutput,
	answerabilityUserPrompt,
} from "./prompts/answerability.ts";
import type {
	AnswerabilityAgent,
	ArticleSeed,
	QuestionDraft,
} from "./types.ts";

export function makeAnswerabilityAgent(
	llm: NanLlmClient,
	trace?: EvalTrace,
): AnswerabilityAgent {
	return {
		async check(draft: QuestionDraft, seed: ArticleSeed) {
			const result = await llm.complete<AnswerabilityOutput>({
				systemPrompt: ANSWERABILITY_SYSTEM,
				userPrompt: answerabilityUserPrompt({
					question: draft.text,
					articleTitle: seed.articleTitle,
					articleText: seed.articleText,
				}),
				jsonSchema: ANSWERABILITY_JSON_SCHEMA as unknown as Record<
					string,
					unknown
				>,
				jsonSchemaName: ANSWERABILITY_PROMPT_ID,
				temperature: 0.1,
				maxTokens: 300,
				trace,
				spanName: "answerability",
			});
			return {
				passed: result.value.verdict === "answers",
				reason: result.value.reason,
			};
		},
	};
}
