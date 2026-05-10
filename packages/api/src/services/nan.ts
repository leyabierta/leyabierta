/**
 * NaN (api.nan.builders) client. OpenAI-compatible chat completions endpoint.
 *
 * Mirrors the `callOpenRouter` interface so we can swap providers per-call
 * (analyzer, reranker, synthesis) without rewriting call sites. NaN supports
 * `qwen3.6` and `gemma4` for chat, with `response_format: json_object` and
 * `json_schema` (strict).
 *
 * Cost: zero. Rate limit: 100 RPM / 5 concurrent (per the NaN docs).
 */

import {
	type OpenRouterMessage,
	type OpenRouterOptions,
	type OpenRouterResult,
	OpenRouterError,
} from "./openrouter.ts";

const NAN_URL = "https://api.nan.builders/v1/chat/completions";
const MAX_RETRIES = 4;
const BACKOFF_MS = 2000;

/**
 * NaN chat completion. Identical contract to `callOpenRouter` so existing
 * call sites can swap by setting a different llmFn. Note: NaN's qwen3.6
 * supports the `chat_template_kwargs.enable_thinking` toggle; we default
 * to `false` for analyzer/reranker (deterministic, fast).
 */
export async function callNan<T>(
	apiKey: string,
	options: OpenRouterOptions & {
		/** Disable Qwen 3.6 reasoning trace. Default true (off for speed). */
		disableThinking?: boolean;
	},
): Promise<OpenRouterResult<T>> {
	const {
		model,
		messages,
		temperature = 0.2,
		maxTokens = 4000,
		jsonResponse = true,
		jsonSchema,
		disableThinking = true,
	} = options;

	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			const delay = BACKOFF_MS * attempt;
			await new Promise((r) => setTimeout(r, delay));
		}

		const startTime = Date.now();
		let response: Response;
		try {
			response = await fetch(NAN_URL, {
				method: "POST",
				signal: AbortSignal.timeout(120_000),
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					messages,
					temperature,
					max_tokens: maxTokens,
					...(jsonSchema
						? {
								response_format: {
									type: "json_schema",
									json_schema: {
										name: jsonSchema.name,
										strict: true,
										schema: jsonSchema.schema,
									},
								},
							}
						: jsonResponse
							? { response_format: { type: "json_object" } }
							: {}),
					...(disableThinking
						? { chat_template_kwargs: { enable_thinking: false } }
						: {}),
				}),
			});
		} catch (err) {
			lastError = new OpenRouterError(
				"fetch_error",
				`NaN network error: ${err}`,
			);
			continue;
		}

		const elapsed = Date.now() - startTime;

		if (response.status === 429) {
			lastError = new OpenRouterError("rate_limit", "NaN rate limited");
			continue;
		}

		if (response.status >= 500) {
			lastError = new OpenRouterError(
				`http_${response.status}`,
				`NaN ${response.status} (transient)`,
			);
			continue;
		}

		if (!response.ok) {
			const errorText = await response.text();
			lastError = new OpenRouterError(
				`http_${response.status}`,
				`NaN error ${response.status}: ${errorText.slice(0, 200)}`,
			);
			if (response.status === 401 || response.status === 403) {
				throw lastError;
			}
			continue;
		}

		const rawData = (await response.json()) as {
			usage?: { prompt_tokens?: number; completion_tokens?: number };
			choices?: Array<{
				message?: { content?: string; reasoning_content?: string };
			}>;
		};
		const usage = rawData.usage ?? {};
		const resultText = rawData.choices?.[0]?.message?.content ?? "";

		if (!resultText) {
			lastError = new OpenRouterError(
				"empty_response",
				"NaN returned empty content",
			);
			continue;
		}

		// Strip code fences if present
		let cleanText = resultText.trim();
		if (cleanText.startsWith("```")) {
			cleanText = cleanText
				.replace(/^```(?:json)?\n?/, "")
				.replace(/\n?```$/, "");
		}

		let parsed: T;
		try {
			parsed = JSON.parse(cleanText);
		} catch {
			// Try to extract JSON object from raw text
			const m = cleanText.match(/\{[\s\S]*\}/);
			if (m) {
				try {
					parsed = JSON.parse(m[0]) as T;
				} catch {
					lastError = new OpenRouterError(
						"json_parse",
						`NaN JSON parse failed: ${cleanText.slice(0, 200)}`,
					);
					continue;
				}
			} else {
				lastError = new OpenRouterError(
					"json_parse",
					`NaN JSON parse failed: ${cleanText.slice(0, 200)}`,
				);
				continue;
			}
		}

		return {
			data: parsed!,
			cost: 0, // NaN is free
			tokensIn: usage.prompt_tokens ?? 0,
			tokensOut: usage.completion_tokens ?? 0,
			elapsed,
		};
	}

	throw lastError ?? new OpenRouterError("unknown", "NaN call failed");
}

export type NanMessage = OpenRouterMessage;
