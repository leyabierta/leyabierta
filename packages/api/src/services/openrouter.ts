/**
 * Shared OpenRouter API client with retry, rate limit handling, and JSON parsing.
 *
 * Used by: generate-reform-summaries.ts
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RETRIES = 2;
const BACKOFF_MS = 2000;

export interface OpenRouterMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface OpenRouterOptions {
	model: string;
	messages: OpenRouterMessage[];
	temperature?: number;
	maxTokens?: number;
	jsonResponse?: boolean;
	jsonSchema?: { name: string; schema: Record<string, unknown> };
	timeoutMs?: number;
}

export interface OpenRouterResult<T> {
	data: T;
	cost: number;
	tokensIn: number;
	tokensOut: number;
	elapsed: number;
}

export class OpenRouterError extends Error {
	constructor(
		public code: string,
		message: string,
	) {
		super(message);
		this.name = "OpenRouterError";
	}
}

export async function callOpenRouter<T>(
	apiKey: string,
	options: OpenRouterOptions,
): Promise<OpenRouterResult<T>> {
	const {
		model,
		messages,
		temperature = 0.2,
		maxTokens = 4000,
		jsonResponse = true,
		jsonSchema,
		timeoutMs,
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
			response = await fetch(OPENROUTER_URL, {
				method: "POST",
				...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://leyabierta.es",
					"X-Title": "Ley Abierta",
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
								plugins: [{ id: "response-healing" }],
							}
						: jsonResponse
							? { response_format: { type: "json_object" } }
							: {}),
				}),
			});
		} catch (err) {
			lastError = new OpenRouterError("fetch_error", `Network error: ${err}`);
			continue;
		}

		const elapsed = Date.now() - startTime;

		if (response.status === 429) {
			lastError = new OpenRouterError("rate_limit", "Rate limited");
			continue;
		}

		if (!response.ok) {
			const errorText = await response.text();
			lastError = new OpenRouterError(
				`http_${response.status}`,
				`API error ${response.status}: ${errorText.slice(0, 200)}`,
			);
			if (response.status === 401 || response.status === 403) {
				throw lastError; // auth errors don't retry
			}
			continue;
		}

		const rawData = await response.json();
		const usage = rawData.usage ?? {};
		const resultText = rawData.choices?.[0]?.message?.content ?? "";

		if (!resultText) {
			lastError = new OpenRouterError(
				"empty_response",
				"LLM returned empty content",
			);
			continue;
		}

		// Clean markdown code fences if present
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
			lastError = new OpenRouterError(
				"json_parse",
				`JSON parse failed: ${cleanText.slice(0, 200)}`,
			);
			continue;
		}

		return {
			data: parsed,
			cost: usage.cost ?? 0,
			tokensIn: usage.prompt_tokens ?? 0,
			tokensOut: usage.completion_tokens ?? 0,
			elapsed,
		};
	}

	throw lastError ?? new OpenRouterError("unknown", "All retries exhausted");
}
