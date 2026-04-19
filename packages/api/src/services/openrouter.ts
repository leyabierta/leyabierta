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

export interface StreamDelta {
	type: "delta";
	text: string;
}

export interface StreamDone {
	type: "done";
	tokensIn: number;
	tokensOut: number;
	cost: number;
}

export async function* callOpenRouterStream(
	apiKey: string,
	options: Omit<OpenRouterOptions, "jsonResponse" | "jsonSchema">,
): AsyncGenerator<StreamDelta | StreamDone> {
	const { model, messages, temperature = 0.2, maxTokens = 4000 } = options;

	const response = await fetch(OPENROUTER_URL, {
		method: "POST",
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
			stream: true,
			stream_options: { include_usage: true },
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new OpenRouterError(
			`http_${response.status}`,
			`API error ${response.status}: ${errorText.slice(0, 200)}`,
		);
	}

	if (!response.body) {
		throw new OpenRouterError("no_body", "Response has no body");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let tokensIn = 0;
	let tokensOut = 0;
	let cost = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		const lines = buffer.split("\n");
		buffer = lines.pop()!;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed?.startsWith("data: ")) continue;
			const payload = trimmed.slice(6);
			if (payload === "[DONE]") continue;

			try {
				const parsed = JSON.parse(payload) as {
					choices?: Array<{ delta?: { content?: string } }>;
					usage?: {
						prompt_tokens?: number;
						completion_tokens?: number;
						cost?: number;
					};
				};
				const content = parsed.choices?.[0]?.delta?.content;
				if (content) {
					yield { type: "delta", text: content };
				}
				if (parsed.usage) {
					tokensIn = parsed.usage.prompt_tokens ?? 0;
					tokensOut = parsed.usage.completion_tokens ?? 0;
					cost = parsed.usage.cost ?? 0;
				}
			} catch {
				// skip unparseable lines
			}
		}
	}

	yield { type: "done", tokensIn, tokensOut, cost };
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

		const rawData = (await response.json()) as {
			usage?: {
				cost?: number;
				prompt_tokens?: number;
				completion_tokens?: number;
			};
			choices?: Array<{ message?: { content?: string } }>;
		};
		const usage = rawData.usage ?? {};
		if (process.env.DEBUG_OPENROUTER) {
			console.log("    DEBUG openrouter usage:", JSON.stringify(usage));
		}
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
