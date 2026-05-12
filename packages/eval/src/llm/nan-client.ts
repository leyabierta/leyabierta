/**
 * NaN-backed `LlmClient` for the eval pipeline.
 *
 * Wraps `callNan` from packages/api/src/services/nan.ts. NaN is OpenAI-compatible,
 * supports `qwen3.6` and `gemma4`, JSON mode + json_schema (strict), free, capped
 * at 5 concurrent requests across the whole account → enforced via NAN_SEMAPHORE.
 *
 * Each call produces an Opik span under whichever parent trace the caller owns;
 * the span is attached via the `trace` parameter to `complete`. If no trace is
 * given, the call is untracked but still works.
 */

import { callNan } from "../../../api/src/services/nan.ts";
import type { LlmClient } from "../agents/types.ts";
import { NAN_SEMAPHORE, withSemaphore } from "./concurrency.ts";
import type { EvalTrace } from "./tracing.ts";

export type NanModelId = "qwen3.6" | "gemma4";

export interface MakeNanClientOpts {
	apiKey: string;
	model: NanModelId;
	/** Default span name when caller does not pass one. */
	defaultSpanName?: string;
	/** Qwen 3.6 supports `enable_thinking`; default off for speed/determinism. */
	disableThinking?: boolean;
}

export interface CompleteWithTrace {
	systemPrompt: string;
	userPrompt: string;
	jsonSchema?: Record<string, unknown>;
	jsonSchemaName?: string;
	temperature?: number;
	maxTokens?: number;
	/** Caller-owned parent trace; if omitted, no span is recorded. */
	trace?: EvalTrace;
	/** Span name within the parent trace. Falls back to `defaultSpanName`. */
	spanName?: string;
}

export interface NanLlmClient extends LlmClient {
	model: NanModelId;
	complete<T>(
		opts: CompleteWithTrace,
	): Promise<{ value: T; tookMs: number; tokensIn: number; tokensOut: number }>;
}

export function makeNanClient(opts: MakeNanClientOpts): NanLlmClient {
	const { apiKey, model } = opts;
	const disableThinking = opts.disableThinking ?? true;
	const defaultSpanName = opts.defaultSpanName ?? `nan-${model}`;

	return {
		model,
		async complete<T>(call: CompleteWithTrace) {
			const spanName = call.spanName ?? defaultSpanName;
			const span = call.trace?.span(spanName, {
				model,
				system: call.systemPrompt.slice(0, 500),
				user: call.userPrompt.slice(0, 1500),
			});

			const result = await withSemaphore(NAN_SEMAPHORE, () =>
				callNan<T>(apiKey, {
					model,
					messages: [
						{ role: "system", content: call.systemPrompt },
						{ role: "user", content: call.userPrompt },
					],
					temperature: call.temperature ?? 0.2,
					maxTokens: call.maxTokens ?? 4000,
					jsonResponse: true,
					...(call.jsonSchema
						? {
								jsonSchema: {
									name: call.jsonSchemaName ?? "output",
									schema: call.jsonSchema,
								},
							}
						: {}),
					disableThinking,
				}),
			);

			span?.end(
				{ output: result.data },
				{
					tokensIn: result.tokensIn,
					tokensOut: result.tokensOut,
					tookMs: result.elapsed,
					cost: result.cost,
				},
			);

			return {
				value: result.data,
				tookMs: result.elapsed,
				tokensIn: result.tokensIn,
				tokensOut: result.tokensOut,
			};
		},
	};
}

/** Convenience factories matching the role split in the plan. */
export const makeQwenClient = (apiKey: string, defaultSpanName?: string) =>
	makeNanClient({ apiKey, model: "qwen3.6", defaultSpanName });

export const makeGemmaClient = (apiKey: string, defaultSpanName?: string) =>
	makeNanClient({ apiKey, model: "gemma4", defaultSpanName });
