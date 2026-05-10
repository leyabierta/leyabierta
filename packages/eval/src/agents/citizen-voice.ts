import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import {
	CITIZEN_VOICE_JSON_SCHEMA,
	CITIZEN_VOICE_PROMPT_ID,
	CITIZEN_VOICE_SYSTEM,
	type CitizenVoiceOutput,
	citizenVoiceUserPrompt,
} from "./prompts/citizen-voice.ts";
import type { CitizenVoiceCriticAgent, QuestionDraft } from "./types.ts";

const MAX_PASSES = 2;

/**
 * Only runs when persona register is "citizen". For "formal" register the
 * pipeline skips this stage entirely (questionGen already produced the
 * formal version directly).
 *
 * Up to MAX_PASSES rewrite attempts. After that, the question is marked
 * irrecoverable and dropped.
 */
export function makeCitizenVoiceAgent(
	llm: NanLlmClient,
	trace?: EvalTrace,
): CitizenVoiceCriticAgent {
	return {
		async rewrite(draft: QuestionDraft) {
			if (draft.persona.register !== "citizen") {
				return { text: draft.text, passes: 0, passed: true };
			}

			let current = draft.text;
			for (let pass = 1; pass <= MAX_PASSES; pass++) {
				const result = await llm.complete<CitizenVoiceOutput>({
					systemPrompt: CITIZEN_VOICE_SYSTEM,
					userPrompt: citizenVoiceUserPrompt(current),
					jsonSchema: CITIZEN_VOICE_JSON_SCHEMA as unknown as Record<
						string,
						unknown
					>,
					jsonSchemaName: CITIZEN_VOICE_PROMPT_ID,
					temperature: 0.4,
					maxTokens: 300,
					trace,
					spanName: `citizen-voice-pass-${pass}`,
				});
				if (result.value.verdict === "ok")
					return { text: current, passes: pass - 1, passed: true };
				if (result.value.verdict === "irrecoverable")
					return { text: current, passes: pass, passed: false };
				current = result.value.rewritten;
			}
			return { text: current, passes: MAX_PASSES, passed: true };
		},
	};
}
