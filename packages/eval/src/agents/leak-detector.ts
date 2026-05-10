import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import {
	detectLeaksRegex,
	detectLongLiteralOverlap,
	LEAK_DETECTOR_JSON_SCHEMA,
	LEAK_DETECTOR_PROMPT_ID,
	LEAK_DETECTOR_SYSTEM,
	type LeakDetectorOutput,
	leakDetectorUserPrompt,
} from "./prompts/leak-detector.ts";
import type { ArticleSeed, LeakDetectorAgent, QuestionDraft } from "./types.ts";

/**
 * Two-layer leak detector: cheap regex first (catches BOE-IDs, "art. N",
 * "ley N/YYYY"), then LLM for subtler leaks. If regex fires, we short-circuit
 * with `passed=false` and skip the LLM call (saves NaN budget).
 */
export function makeLeakDetectorAgent(
	llm: NanLlmClient,
	trace?: EvalTrace,
	opts: { articleText?: () => string } = {},
): LeakDetectorAgent {
	return {
		async check(draft: QuestionDraft) {
			const regexLeaks = detectLeaksRegex(draft.text);
			if (regexLeaks.length > 0) {
				return {
					passed: false,
					reasons: regexLeaks.map((l) => `regex:${l.pattern} (${l.matched})`),
				};
			}

			if (opts.articleText) {
				const overlap = detectLongLiteralOverlap(
					draft.text,
					opts.articleText(),
				);
				if (overlap) {
					return { passed: false, reasons: [`literal-overlap:"${overlap}"`] };
				}
			}

			const result = await llm.complete<LeakDetectorOutput>({
				systemPrompt: LEAK_DETECTOR_SYSTEM,
				userPrompt: leakDetectorUserPrompt(draft.text),
				jsonSchema: LEAK_DETECTOR_JSON_SCHEMA as unknown as Record<
					string,
					unknown
				>,
				jsonSchemaName: LEAK_DETECTOR_PROMPT_ID,
				temperature: 0,
				maxTokens: 300,
				trace,
				spanName: "leak-detector",
			});
			return {
				passed: result.value.verdict === "clean",
				reasons: result.value.reasons,
			};
		},
	};
}

/**
 * Variant binding the article text up-front so callers don't have to pass
 * a closure each time. Use inside the pipeline where each draft has its
 * own seed.articleText.
 */
export function makeLeakDetectorAgentForSeed(
	llm: NanLlmClient,
	seed: ArticleSeed,
	trace?: EvalTrace,
): LeakDetectorAgent {
	return makeLeakDetectorAgent(llm, trace, {
		articleText: () => seed.articleText,
	});
}
