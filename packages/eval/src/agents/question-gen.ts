import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import {
	QUESTION_GEN_JSON_SCHEMA,
	QUESTION_GEN_PROMPT_ID,
	QUESTION_GEN_SYSTEM,
	type QuestionGenOutput,
	questionGenUserPrompt,
} from "./prompts/question-gen.ts";
import type {
	ArticleSeed,
	Persona,
	QuestionDraft,
	QuestionGeneratorAgent,
} from "./types.ts";

/**
 * Round-robin between Qwen and Gemma to avoid mode collapse from a single
 * model's habits. Caller passes both clients; each call alternates.
 */
export function makeQuestionGeneratorAgent(
	clients: [NanLlmClient, NanLlmClient],
	trace?: EvalTrace,
): QuestionGeneratorAgent {
	let counter = 0;
	return {
		async generate(
			seed: ArticleSeed,
			persona: Persona,
		): Promise<QuestionDraft> {
			const llm = clients[counter++ % clients.length]!;
			const result = await llm.complete<QuestionGenOutput>({
				systemPrompt: QUESTION_GEN_SYSTEM,
				userPrompt: questionGenUserPrompt({
					persona,
					articleTitle: seed.articleTitle,
					articleText: seed.articleText,
					materia: seed.materia,
				}),
				jsonSchema: QUESTION_GEN_JSON_SCHEMA as unknown as Record<
					string,
					unknown
				>,
				jsonSchemaName: QUESTION_GEN_PROMPT_ID,
				temperature: 0.8,
				maxTokens: 400,
				trace,
				spanName: `question-gen-${llm.model}`,
			});
			return {
				text: result.value.question,
				persona,
				generator: { model: llm.model, prompt: QUESTION_GEN_PROMPT_ID },
			};
		},
	};
}
