/**
 * Minimal JSON chat client for any OpenAI-compatible endpoint (OpenRouter,
 * SGLang, vLLM…), with a hard spend limit read from `usage.cost`.
 *
 * OpenRouter-only fields (reasoning effort, provider routing) are sent only
 * when the base URL is OpenRouter; other servers get a plain
 * chat-completions body plus whatever `extraBody` adds (for example
 * `{"chat_template_kwargs": {"enable_thinking": false}}`).
 *
 * Spend is kept in a JSONL ledger so the limit holds across runs.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface LlmOptions {
	baseUrl: string;
	apiKey: string;
	/** Hard limit in USD, including what the ledger already holds. */
	budget: number;
	/** Stop starting calls once spend is within this margin of the limit. */
	reserve: number;
	ledgerPath?: string;
	extraBody?: Record<string, unknown>;
	/** OpenRouter: providers to try first (fallbacks stay allowed). */
	providerOrder?: string[];
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
}

export interface CallInfo {
	step: string;
	model: string;
	cost: number;
	tokensIn: number;
	tokensOut: number;
	reasoningTokens: number;
	provider: string;
	ms: number;
}

export class BudgetExceeded extends Error {}

export function parseJson(text: string): unknown {
	const cleaned = text
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/^```(?:json)?\s*|\s*```$/g, "")
		.trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	return JSON.parse(cleaned.slice(start, end + 1));
}

export class LlmClient {
	readonly isOpenRouter: boolean;
	/** Spend before this run (ledger) and during it. */
	priorSpend = 0;
	spent = 0;

	constructor(private readonly o: LlmOptions) {
		this.isOpenRouter = /openrouter\.ai/.test(o.baseUrl);
		if (o.ledgerPath && existsSync(o.ledgerPath)) {
			for (const line of readFileSync(o.ledgerPath, "utf8").split("\n")) {
				if (!line.trim()) continue;
				this.priorSpend += (JSON.parse(line) as { cost?: number }).cost ?? 0;
			}
		}
	}

	get total(): number {
		return this.priorSpend + this.spent;
	}

	private record(info: CallInfo & { tag: string }): void {
		this.spent += info.cost;
		if (this.o.ledgerPath)
			appendFileSync(
				this.o.ledgerPath,
				`${JSON.stringify({ at: new Date().toISOString(), ...info })}\n`,
			);
	}

	/**
	 * One chat call that must return a JSON object. Retries on network errors,
	 * 5xx/429 and unparseable JSON (each paid attempt counts against the budget).
	 */
	async json<T = unknown>(args: {
		tag: string;
		step: string;
		model: string;
		reasoning?: string;
		system: string;
		user: string;
		maxTokens?: number;
		/** Returns an error message when the parsed JSON is not usable. */
		validate?: (data: T) => string | null;
	}): Promise<{ data: T; info: CallInfo }> {
		let lastErr = "";
		let truncated = false;
		// Cost and time of every attempt, failed ones included.
		const total: CallInfo = {
			step: args.step,
			model: args.model,
			cost: 0,
			tokensIn: 0,
			tokensOut: 0,
			reasoningTokens: 0,
			provider: "",
			ms: 0,
		};
		for (let attempt = 0; attempt < 3; attempt++) {
			if (this.total >= this.o.budget - this.o.reserve)
				throw new BudgetExceeded(
					`budget reached (${this.total.toFixed(4)} of ${this.o.budget})`,
				);
			if (attempt) await Bun.sleep(4000 * attempt);
			const t0 = Date.now();
			const body: Record<string, unknown> = {
				model: args.model,
				messages: [
					{ role: "system", content: args.system },
					{ role: "user", content: args.user },
				],
				// A cut-off answer is usually a repetition loop: retry warmer.
				temperature: truncated ? 0.6 : (this.o.temperature ?? 0.2),
				max_tokens: args.maxTokens ?? this.o.maxTokens ?? 16000,
				response_format: { type: "json_object" },
				...(this.isOpenRouter
					? {
							...(args.reasoning && args.reasoning !== "default"
								? { reasoning: { effort: args.reasoning } }
								: {}),
							// Same routing as run.ts: cheapest provider, no fp4 builds.
							provider: {
								sort: "price",
								...(this.o.providerOrder?.length
									? { order: this.o.providerOrder }
									: {}),
								quantizations: ["fp8", "fp16", "bf16", "fp32", "unknown"],
							},
						}
					: {}),
				...(this.o.extraBody ?? {}),
			};
			const res = await fetch(
				`${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`,
				{
					method: "POST",
					signal: AbortSignal.timeout(this.o.timeoutMs ?? 600_000),
					headers: {
						Authorization: `Bearer ${this.o.apiKey}`,
						"Content-Type": "application/json",
						...(this.isOpenRouter
							? {
									"HTTP-Referer": "https://leyabierta.es",
									"X-Title": "Ley Abierta (eval fichas)",
								}
							: {}),
					},
					body: JSON.stringify(body),
				},
			).catch((e) => e as Error);
			if (res instanceof Error) {
				lastErr = `network ${res.message}`;
				continue;
			}
			const json = (await res.json().catch(() => null)) as {
				error?: { message?: string };
				provider?: string;
				choices?: Array<{
					message?: { content?: string };
					finish_reason?: string;
				}>;
				usage?: {
					cost?: number;
					prompt_tokens?: number;
					completion_tokens?: number;
					completion_tokens_details?: { reasoning_tokens?: number };
				};
			} | null;
			const info: CallInfo = {
				step: args.step,
				model: args.model,
				cost: json?.usage?.cost ?? 0,
				tokensIn: json?.usage?.prompt_tokens ?? 0,
				tokensOut: json?.usage?.completion_tokens ?? 0,
				reasoningTokens:
					json?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
				provider: json?.provider ?? "",
				ms: Date.now() - t0,
			};
			this.record({ ...info, tag: args.tag });
			total.cost += info.cost;
			total.tokensIn += info.tokensIn;
			total.tokensOut += info.tokensOut;
			total.reasoningTokens += info.reasoningTokens;
			total.ms += info.ms;
			total.provider = info.provider;
			const content = json?.choices?.[0]?.message?.content ?? "";
			const finish = json?.choices?.[0]?.finish_reason;
			if (finish === "length") {
				truncated = true;
				lastErr = `output cut at max_tokens (${info.tokensOut} tokens)`;
				console.warn(`  ${args.tag}: ${lastErr}, retrying`);
				continue;
			}
			if (!res.ok || json?.error || !content.trim()) {
				lastErr = `${res.status} ${json?.error?.message?.slice(0, 200) ?? `empty content (finish ${finish})`}`;
				if ([400, 401, 402, 403, 404].includes(res.status)) break;
				continue;
			}
			let data: T;
			try {
				data = parseJson(content) as T;
			} catch {
				lastErr = `unparseable JSON (finish ${finish}, ${content.length} chars)`;
				continue;
			}
			const invalid = args.validate?.(data);
			if (invalid) {
				lastErr = `invalid JSON: ${invalid}`;
				console.warn(`  ${args.tag}: ${lastErr}, retrying`);
				continue;
			}
			return { data, info: total };
		}
		throw Object.assign(new Error(`${args.tag} ${args.model}: ${lastErr}`), {
			info: total,
		});
	}
}

/** Run `fn` over `items` with at most `n` in flight; results keep order. */
export async function pool<T, R>(
	items: T[],
	n: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i] as T, i);
			}
		}),
	);
	return out;
}
