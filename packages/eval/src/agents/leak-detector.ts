import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import {
	detectBigramOverlap,
	detectLeaksRegex,
	detectLongLiteralOverlap,
	detectRareTermOverlap,
	LEAK_DETECTOR_JSON_SCHEMA,
	LEAK_DETECTOR_PROMPT_ID,
	LEAK_DETECTOR_SYSTEM,
	type LeakDetectorOutput,
	leakDetectorUserPrompt,
} from "./prompts/leak-detector.ts";
import type { ArticleSeed, LeakDetectorAgent, QuestionDraft } from "./types.ts";

export interface LeakDetectorOpts {
	/** Returns the article text to compare against the question, lazily. */
	articleText?: () => string;
	/**
	 * Optional global corpus document-frequency map. If provided AND
	 * `articleText` is provided, we run the rare-term overlap layer
	 * between regex and LLM. Pass via `cli.ts` after building once at
	 * pipeline startup.
	 */
	rareTermFrequency?: Map<string, number>;
	/** Tunables for `detectRareTermOverlap`. */
	rareOverlap?: {
		minRareCooccurrence?: number;
		rareThreshold?: number;
	};
	/**
	 * Tunables for `detectBigramOverlap`. Enabled by default whenever
	 * article text is available; pass `enabled: false` to disable in
	 * tests or for explicit opt-out.
	 */
	bigramOverlap?: {
		enabled?: boolean;
		minOverlapBigrams?: number;
	};
}

/**
 * Three-layer leak detector:
 *  1. Deterministic regex (BOE-IDs, "art. N", "ley N/YYYY", "según el ...").
 *  2. Article-grounded checks against the source article text:
 *     a) long literal overlap (>=6 consecutive words shared).
 *     b) rare-term overlap (TF-IDF style: tokens shared between question
 *        and article whose corpus document-frequency is below
 *        `rareThreshold`). Requires the corpus frequency map.
 *  3. LLM critic for subtler leaks the deterministic layers miss.
 *
 * If any deterministic layer fires, we short-circuit with `passed=false`
 * and skip the LLM call (saves NaN budget).
 */
export function makeLeakDetectorAgent(
	llm: NanLlmClient,
	trace?: EvalTrace,
	opts: LeakDetectorOpts = {},
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

			const articleText = opts.articleText
				? opts.articleText()
				: draft.articleText;
			if (articleText) {
				const overlap = detectLongLiteralOverlap(draft.text, articleText);
				if (overlap) {
					return { passed: false, reasons: [`literal-overlap:"${overlap}"`] };
				}

				if (opts.bigramOverlap?.enabled !== false) {
					const bigram = detectBigramOverlap(draft.text, articleText, {
						minOverlapBigrams: opts.bigramOverlap?.minOverlapBigrams,
					});
					if (bigram) {
						return {
							passed: false,
							reasons: [
								`bigram-overlap: ${bigram.matched
									.map((b) => `"${b}"`)
									.join(", ")}`,
							],
						};
					}
				}

				if (opts.rareTermFrequency) {
					const rare = detectRareTermOverlap(
						draft.text,
						articleText,
						opts.rareTermFrequency,
						opts.rareOverlap,
					);
					if (rare) {
						return {
							passed: false,
							reasons: [`rare-overlap: ${rare.matched.join(", ")}`],
						};
					}
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
	opts: { rareTermFrequency?: Map<string, number> } = {},
): LeakDetectorAgent {
	return makeLeakDetectorAgent(llm, trace, {
		articleText: () => seed.articleText,
		rareTermFrequency: opts.rareTermFrequency,
	});
}
