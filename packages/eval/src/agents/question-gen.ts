import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import {
	QUESTION_GEN_JSON_SCHEMA,
	QUESTION_GEN_PROMPT_ID,
	QUESTION_GEN_SYSTEM,
	type QuestionGenOutput,
	questionGenUserPrompt,
} from "./prompts/question-gen.ts";
import {
	QUESTION_SELF_CRITIQUE_JSON_SCHEMA,
	QUESTION_SELF_CRITIQUE_PROMPT_ID,
	QUESTION_SELF_CRITIQUE_SYSTEM,
	type QuestionSelfCritiqueOutput,
	questionSelfCritiqueUserPrompt,
} from "./prompts/question-self-critique.ts";
import type {
	ArticleSeed,
	Persona,
	QuestionDraft,
	QuestionGeneratorAgent,
} from "./types.ts";

/**
 * Round-robin between Qwen and Gemma to avoid mode collapse from a single
 * model's habits. Caller passes both clients; each call alternates.
 *
 * Two-pass design:
 *  1. Generate question with the chosen model (Qwen or Gemma).
 *  2. Self-critique with the SAME model — keeps coherence with the
 *     generator's vocabulary so the critique notices its own jargon.
 *     Verdict drives whether we keep the original (`ok`), use the
 *     rewritten text (`rewritten`), or throw to drop the question
 *     (`irrecoverable`). Throwing is caught by the pipeline's
 *     per-persona try/catch and counted in `droppedAtError`.
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

			const original = result.value.question;

			// Self-critique with the SAME model.
			const critique = await llm.complete<QuestionSelfCritiqueOutput>({
				systemPrompt: QUESTION_SELF_CRITIQUE_SYSTEM,
				userPrompt: questionSelfCritiqueUserPrompt({
					question: original,
					persona,
					articleTitle: seed.articleTitle,
					articleText: seed.articleText,
					materia: seed.materia,
				}),
				jsonSchema: QUESTION_SELF_CRITIQUE_JSON_SCHEMA as unknown as Record<
					string,
					unknown
				>,
				jsonSchemaName: QUESTION_SELF_CRITIQUE_PROMPT_ID,
				temperature: 0.2,
				maxTokens: 400,
				trace,
				spanName: "question-gen-self-critique",
			});

			let finalText: string;
			if (critique.value.verdict === "irrecoverable") {
				throw new Error(
					`question-gen-self-critique:irrecoverable: ${critique.value.reason}`,
				);
			}
			if (
				critique.value.verdict === "rewritten" &&
				critique.value.revised.trim().length > 0
			) {
				finalText = critique.value.revised.trim();
			} else {
				finalText = original;
			}

			return {
				text: finalText,
				persona,
				generator: { model: llm.model, prompt: QUESTION_GEN_PROMPT_ID },
				articleText: seed.articleText,
			};
		},
	};
}
