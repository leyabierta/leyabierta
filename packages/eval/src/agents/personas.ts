import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import {
	PERSONAS_JSON_SCHEMA,
	PERSONAS_PROMPT_ID,
	PERSONAS_SYSTEM,
	type PersonaOutput,
	personasUserPrompt,
} from "./prompts/personas.ts";
import type { ArticleSeed, Persona, PersonaAgent } from "./types.ts";

export function makePersonaAgent(
	llm: NanLlmClient,
	trace?: EvalTrace,
): PersonaAgent {
	return {
		async generate(seed: ArticleSeed): Promise<Persona[]> {
			const result = await llm.complete<PersonaOutput>({
				systemPrompt: PERSONAS_SYSTEM,
				userPrompt: personasUserPrompt({
					normId: seed.normId,
					articleTitle: seed.articleTitle,
					articleText: seed.articleText,
					materia: seed.materia,
				}),
				jsonSchema: PERSONAS_JSON_SCHEMA as unknown as Record<string, unknown>,
				jsonSchemaName: PERSONAS_PROMPT_ID,
				temperature: 0.7,
				maxTokens: 800,
				trace,
				spanName: "personas",
			});
			return result.value.personas;
		},
	};
}
