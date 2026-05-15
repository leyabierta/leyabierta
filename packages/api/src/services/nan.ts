/**
 * NaN (api.nan.builders) client. OpenAI-compatible chat completions endpoint.
 *
 * Mirrors the `callOpenRouter` interface so we can swap providers per-call
 * (analyzer, reranker, synthesis) without rewriting call sites. NaN supports
 * `qwen3.6` and `gemma4` for chat, with `response_format: json_object` and
 * `json_schema` (strict).
 *
 * Cost: zero. Rate limit: 100 RPM / 5 concurrent (per the NaN docs).
 *
 * 429 retry strategy: NaN's 429s are almost always concurrency-slot exhaustion
 * (>5 in-flight), not RPM exhaustion. Slots free up in ~1-2s, so we use a
 * short base backoff (500ms) with full jitter to avoid thundering herd when
 * multiple requests retry simultaneously. Up to MAX_RETRIES_429 retries for
 * 429, fewer for transient 5xx errors.
 */

import {
	OpenRouterError,
	type OpenRouterMessage,
	type OpenRouterOptions,
	type OpenRouterResult,
	type StreamDelta,
	type StreamDone,
} from "./openrouter.ts";

const NAN_URL = "https://api.nan.builders/v1/chat/completions";
const MAX_RETRIES = 4; // transient 5xx / network errors
const MAX_RETRIES_429 = 8; // more retries for rate limit — slots free up quickly
const BACKOFF_BASE_MS = 500; // short base: NaN slots free in ~1-2s
const BACKOFF_MAX_MS = 8000; // cap to avoid very long waits

/** Exponential backoff with full jitter: random in [0, min(cap, base * 2^attempt)]. */
function jitteredBackoff(attempt: number): number {
	const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
	return Math.random() * cap;
}

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
	let rateLimit429 = 0;
	let transientErrors = 0;

	// We loop until we succeed, exhaust 429 retries, or exhaust transient retries.
	while (true) {
		if (rateLimit429 > 0 || transientErrors > 0) {
			const attempt = rateLimit429 + transientErrors;
			await new Promise((r) => setTimeout(r, jitteredBackoff(attempt)));
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
			rateLimit429++;
			lastError = new OpenRouterError("rate_limit", "NaN rate limited");
			if (rateLimit429 >= MAX_RETRIES_429) break;
			continue;
		}

		if (response.status >= 500) {
			transientErrors++;
			lastError = new OpenRouterError(
				`http_${response.status}`,
				`NaN ${response.status} (transient)`,
			);
			if (transientErrors >= MAX_RETRIES) break;
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

/**
 * Streaming chat completion via NaN. Same SSE protocol as OpenRouter; we
 * mirror `callOpenRouterStream` so the synthesis route can treat both
 * providers identically.
 */
export async function* callNanStream(
	apiKey: string,
	options: Omit<OpenRouterOptions, "jsonResponse" | "jsonSchema"> & {
		disableThinking?: boolean;
	},
): AsyncGenerator<StreamDelta | StreamDone> {
	const {
		model,
		messages,
		temperature = 0.2,
		maxTokens = 4000,
		disableThinking = true,
	} = options;

	let response: Response | null = null;
	let lastError: Error | null = null;
	let rateLimit429 = 0;
	let transientErrors = 0;

	while (true) {
		if (rateLimit429 > 0 || transientErrors > 0) {
			const attempt = rateLimit429 + transientErrors;
			await new Promise((r) => setTimeout(r, jitteredBackoff(attempt)));
		}
		let res: Response;
		try {
			res = await fetch(NAN_URL, {
				method: "POST",
				signal: AbortSignal.timeout(180_000),
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					messages,
					temperature,
					max_tokens: maxTokens,
					stream: true,
					...(disableThinking
						? { chat_template_kwargs: { enable_thinking: false } }
						: {}),
				}),
			});
		} catch (err) {
			transientErrors++;
			lastError = new OpenRouterError(
				"fetch_error",
				`NaN stream network error: ${err}`,
			);
			if (transientErrors >= MAX_RETRIES) break;
			continue;
		}
		if (res.status === 429) {
			rateLimit429++;
			lastError = new OpenRouterError("rate_limit", "NaN stream rate limited");
			if (rateLimit429 >= MAX_RETRIES_429) break;
			continue;
		}
		if (res.status >= 500) {
			transientErrors++;
			lastError = new OpenRouterError(
				`http_${res.status}`,
				`NaN stream ${res.status} (transient)`,
			);
			if (transientErrors >= MAX_RETRIES) break;
			continue;
		}
		if (!res.ok) {
			const errorText = await res.text();
			throw new OpenRouterError(
				`http_${res.status}`,
				`NaN stream error ${res.status}: ${errorText.slice(0, 200)}`,
			);
		}
		response = res;
		break;
	}
	if (!response) {
		throw (
			lastError ??
			new OpenRouterError("rate_limit", "NaN stream rate limited after retries")
		);
	}
	if (!response.body) {
		throw new OpenRouterError("no_body", "NaN response has no body");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let tokensIn = 0;
	let tokensOut = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed?.startsWith("data: ")) continue;
			const payload = trimmed.slice(6);
			if (payload === "[DONE]") continue;
			try {
				const parsed = JSON.parse(payload) as {
					choices?: Array<{ delta?: { content?: string } }>;
					usage?: { prompt_tokens?: number; completion_tokens?: number };
				};
				const content = parsed.choices?.[0]?.delta?.content;
				if (content) yield { type: "delta", text: content };
				if (parsed.usage) {
					tokensIn = parsed.usage.prompt_tokens ?? 0;
					tokensOut = parsed.usage.completion_tokens ?? 0;
				}
			} catch {
				// skip unparseable lines
			}
		}
	}
	yield { type: "done", tokensIn, tokensOut, cost: 0 };
}
