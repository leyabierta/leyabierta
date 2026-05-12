import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import {
	DIFFICULTY_JSON_SCHEMA,
	DIFFICULTY_PROMPT_ID,
	DIFFICULTY_SYSTEM,
	type DifficultyOutput,
	difficultyUserPrompt,
} from "./prompts/difficulty.ts";
import type { DifficultyScorerAgent } from "./types.ts";

export function makeDifficultyAgent(
	llm: NanLlmClient,
	trace?: EvalTrace,
	articleTextLookup?: (
		norm: string,
		article: string,
	) => { title: string; text: string } | undefined,
): DifficultyScorerAgent {
	return {
		async score(input) {
			const enriched = articleTextLookup
				? input.expectedArticles.map((a) => {
						const t = articleTextLookup(a.norm, a.article);
						return {
							norm: a.norm,
							article: a.article,
							title: t?.title,
							text: t?.text,
						};
					})
				: input.expectedArticles.map((a) => ({
						norm: a.norm,
						article: a.article,
					}));

			const result = await llm.complete<DifficultyOutput>({
				systemPrompt: DIFFICULTY_SYSTEM,
				userPrompt: difficultyUserPrompt({
					question: input.question,
					expectedArticles: enriched,
				}),
				jsonSchema: DIFFICULTY_JSON_SCHEMA as unknown as Record<
					string,
					unknown
				>,
				jsonSchemaName: DIFFICULTY_PROMPT_ID,
				temperature: 0.1,
				maxTokens: 200,
				trace,
				spanName: "difficulty",
			});
			return result.value.difficulty;
		},
	};
}
