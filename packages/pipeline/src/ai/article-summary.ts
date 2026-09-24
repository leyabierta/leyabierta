/**
 * Per-article citizen summaries: one request, one validation and one write
 * for every live path that generates them —
 *
 *   - the daily cron (packages/pipeline/src/scripts/generate-citizen-tags.ts),
 *   - the lazy API route (packages/api/src/services/citizen-summary.ts),
 *   - the RAG background fill (packages/api/src/services/rag/synthesis.ts).
 *
 * Until 2026-09 each path had its own prompt, model and length rules (the
 * cron cut articles to 500 characters and batched 10 per call with an old
 * prompt); now all of them send the prompt v10 (article-summary-prompt.ts)
 * with the whole article to ARTICLE_SUMMARIES_MODEL (default
 * openai/gpt-6-luna, reasoning minimal: judged 7.80 vs 7.51 for Qwen, 0 vs 2
 * serious errors, on 40 articles never used before) and store the model,
 * prompt version and date next to the summary.
 *
 * The offline import (packages/api/src/scripts/article-summary-import.ts)
 * uses the same validation.
 */

import type { Database } from "bun:sqlite";
import { FOREIGN_SCRIPT } from "../utils/generated-text.ts";
import { openRouterProviderField } from "../utils/openrouter-privacy.ts";
import {
	ARTICLE_SUMMARY_PROMPT_VERSION,
	BATCH_SCHEMA,
	buildBatchPrompt,
	parseBatchContent,
	SYSTEM_PROMPT,
} from "./article-summary-prompt.ts";

// ── Model and request ──

export const DEFAULT_ARTICLE_SUMMARIES_MODEL = "openai/gpt-6-luna";

/** OpenRouter model id for per-article summaries (`ARTICLE_SUMMARIES_MODEL`). */
export function articleSummariesModel(
	env: Record<string, string | undefined> = process.env,
): string {
	return env.ARTICLE_SUMMARIES_MODEL?.trim() || DEFAULT_ARTICLE_SUMMARIES_MODEL;
}

/**
 * Reasoning settings as evaluated: openai/* (gpt-6-luna) with minimal effort
 * (its default, medium, is slower for no measured gain), Qwen with thinking
 * off. Other models get the provider default.
 */
export function articleSummaryReasoning(
	model: string,
): { effort: "minimal" } | { enabled: false } | undefined {
	if (model.startsWith("openai/")) return { effort: "minimal" };
	if (model.startsWith("qwen/")) return { enabled: false };
	return undefined;
}

export const ARTICLE_SUMMARY_TEMPERATURE = 0.2;
// Reasoning tokens count against max_tokens on openai/*: ~100 of them plus a
// ~150-token answer, with room to spare.
export const ARTICLE_SUMMARY_MAX_TOKENS = 1000;
/**
 * Longest article sent whole (~20K tokens). Longer ones are skipped, not cut:
 * a summary of the first part would read as a summary of the whole article.
 * The offline backfill handles them.
 */
export const ARTICLE_MAX_INPUT_CHARS = 60_000;

export interface ArticleInput {
	norm_title: string;
	block_title: string;
	current_text: string;
}

/**
 * The OpenRouter chat-completions body for one article. Same fields, in the
 * same shape, as `callOpenRouter` in packages/api builds for a JSON-schema
 * request (tests compare both).
 */
export function articleSummaryRequestBody(
	article: ArticleInput,
	model: string,
	env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
	const reasoning = articleSummaryReasoning(model);
	return {
		model,
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{
				role: "user",
				content: buildBatchPrompt([
					{
						norm_id: "",
						block_id: "",
						norm_title: article.norm_title,
						block_title: article.block_title,
						current_text: article.current_text,
					},
				]),
			},
		],
		temperature: ARTICLE_SUMMARY_TEMPERATURE,
		max_tokens: ARTICLE_SUMMARY_MAX_TOKENS,
		...(reasoning ? { reasoning } : {}),
		...openRouterProviderField(env),
		response_format: {
			type: "json_schema",
			json_schema: {
				name: BATCH_SCHEMA.name,
				strict: true,
				schema: BATCH_SCHEMA.schema,
			},
		},
		plugins: [{ id: "response-healing" }],
	};
}

// ── Validation (shared with the offline import) ──

// Prompt v10 asks for 80-300 characters. Very short articles legitimately
// produce shorter summaries; longer ones are accepted up to maxSummaryChars,
// although the prompt says 300, because for long articles a blind judge
// preferred them 35/5 over the summaries in production (2026-09-23).
export const MIN_SUMMARY_CHARS = 20;
/** Absolute cap, for the longest articles; see maxSummaryChars. */
export const MAX_SUMMARY_CHARS = 600;

/**
 * Longest acceptable summary for an article of `articleChars` characters. A
 * fixed 320-character cap rejected 29% of the summaries of the main codes
 * (long articles with several apartados, where the essentials don't fit), and
 * forcing them shorter drops data. Short articles keep the 320 cap.
 */
export function maxSummaryChars(articleChars: number): number {
	if (articleChars < 1000) return 320;
	if (articleChars < 2000) return 400;
	if (articleChars < 5000) return 500;
	return MAX_SUMMARY_CHARS;
}
export const MIN_TAGS = 3;
export const MAX_TAGS = 5;
export const MAX_TAG_CHARS = 60;

// Control and invisible format characters (NUL, zero-width space...) and
// HTML-like tags. Bare < and > stay: "municipios <10.000 hab" is legitimate.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}]|<\/?[a-z][^<>]*>/iu;
// `\b` only knows ASCII letters (even with the `u` flag): "túneles" would
// match "tú" and "andén" would match "and". Use Unicode letter lookarounds.
const word = (alternatives: string) =>
	new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives})(?![\\p{L}\\p{N}])`, "iu");
const SECOND_PERSON = word("tú|tienes|puedes|usted|ustedes|debes");
const ENGLISH = word("the|and|shall|which|must|summary");
const REASONING = /<\/?think>|(?<![\p{L}])thinking(?![\p{L}])/iu;

/** Script, control-character and reasoning problems in generated text. */
export function generatedTextProblem(text: string): string | null {
	if (REASONING.test(text)) return "reasoning_leak";
	if (UNSAFE_CHARS.test(text)) return "unsafe_chars";
	if (FOREIGN_SCRIPT.test(text)) return "foreign_script";
	if (ENGLISH.test(text)) return "english";
	return null;
}

/**
 * Checks a generated summary and its tags. With `articleChars`, also the
 * length cap for that article (maxSummaryChars); without it, only the
 * absolute cap (the offline import checks the article's current length
 * itself). Tags are trimmed and deduplicated case-insensitively.
 */
export function validateArticleSummary(
	rawSummary: unknown,
	rawTags: unknown,
	articleChars?: number,
):
	| { ok: true; summary: string; tags: string[] }
	| { ok: false; reason: string } {
	const summary = typeof rawSummary === "string" ? rawSummary.trim() : "";
	if (summary.length < MIN_SUMMARY_CHARS)
		return { ok: false, reason: "too_short" };
	const cap =
		articleChars === undefined
			? MAX_SUMMARY_CHARS
			: maxSummaryChars(articleChars);
	if (summary.length > cap) return { ok: false, reason: "too_long" };

	if (!Array.isArray(rawTags)) return { ok: false, reason: "bad_tags" };
	// Dedupe case-insensitively (the tag PK is case-sensitive), keeping the
	// first spelling: tags can be proper nouns ("País Vasco").
	const byLower = new Map<string, string>();
	for (const t of rawTags) {
		if (typeof t !== "string") continue;
		const tag = t.trim();
		if (tag && !byLower.has(tag.toLowerCase()))
			byLower.set(tag.toLowerCase(), tag);
	}
	const tags = [...byLower.values()];
	if (tags.length < MIN_TAGS || tags.length > MAX_TAGS)
		return { ok: false, reason: "bad_tag_count" };
	if (tags.some((t) => t.length > MAX_TAG_CHARS))
		return { ok: false, reason: "tag_too_long" };

	const all = `${summary} ${tags.join(" ")}`;
	if (REASONING.test(all)) return { ok: false, reason: "reasoning_leak" };
	if (UNSAFE_CHARS.test(all)) return { ok: false, reason: "unsafe_chars" };
	if (FOREIGN_SCRIPT.test(all)) return { ok: false, reason: "foreign_script" };
	if (SECOND_PERSON.test(summary))
		return { ok: false, reason: "second_person" };
	if (ENGLISH.test(summary)) return { ok: false, reason: "english" };

	return { ok: true, summary, tags };
}

/**
 * Placeholder articles with nothing to summarize: "(Suprimido)", "(Derogado)",
 * or a bare chapter/title heading stored as a precepto.
 */
export function articleHasSubstance(text: string): boolean {
	const lines = text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const body = lines.slice(1).join(" ").replace(/\*+/g, "").trim();
	if (body.length < 40) return false;
	if (/^\(?(suprimido|derogad[oa]|sin contenido|anulad[oa])\)?\.?$/i.test(body))
		return false;
	if (
		/^(CAPÍTULO|TÍTULO|SECCIÓN|LIBRO|SUBSECCIÓN)\b/.test(lines[0] ?? "") &&
		lines.length <= 2 &&
		body.length < 120
	)
		return false;
	return true;
}

// ── Generation ──

export type ArticleSummaryResult =
	| {
			ok: true;
			summary: string;
			tags: string[];
			model: string;
			promptVersion: string;
			cost: number;
	  }
	| { ok: false; reason: string; detail?: string };

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Pause before retry N (tests set OPENROUTER_BACKOFF_MS=0). */
function backoffMs(attempt: number, env: Record<string, string | undefined>) {
	const raw = env.OPENROUTER_BACKOFF_MS;
	const base = raw ? Number(raw) : 2000;
	return (Number.isFinite(base) && base >= 0 ? base : 2000) * attempt;
}

/**
 * Generates and validates the summary of one article. Never throws.
 *
 * Retries (up to `maxAttempts`) network errors, timeouts, 429/5xx and the
 * upstream failures OpenRouter reports inside an HTTP 200 without content
 * (e.g. gpt-6-luna's upstream 429 under concurrency). A summary that fails
 * validation is not retried: the caller decides (the lazy route remembers
 * the attempt so it is not paid again).
 */
export async function generateArticleSummary(opts: {
	apiKey: string;
	article: ArticleInput;
	model?: string;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
	maxAttempts?: number;
	env?: Record<string, string | undefined>;
}): Promise<ArticleSummaryResult> {
	const env = opts.env ?? process.env;
	const model = opts.model ?? articleSummariesModel(env);
	const fetchFn = opts.fetchFn ?? fetch;
	const text = opts.article.current_text;
	if (text.length > ARTICLE_MAX_INPUT_CHARS)
		return { ok: false, reason: "article_too_long" };
	const body = JSON.stringify(
		articleSummaryRequestBody(opts.article, model, env),
	);
	const maxAttempts = opts.maxAttempts ?? 3;

	let last: { reason: string; detail?: string } = { reason: "no_attempt" };
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0)
			await new Promise((r) => setTimeout(r, backoffMs(attempt, env)));
		let res: Response;
		try {
			res = await fetchFn(OPENROUTER_URL, {
				method: "POST",
				signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
				headers: {
					Authorization: `Bearer ${opts.apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://leyabierta.es",
					"X-Title": "Ley Abierta",
				},
				body,
			});
		} catch (err) {
			last = { reason: "fetch_error", detail: String(err).slice(0, 200) };
			continue;
		}
		if (res.status === 429 || res.status >= 500) {
			last = { reason: `http_${res.status}` };
			continue;
		}
		if (!res.ok) {
			// Auth, bad request, model without a ZDR endpoint (404): retrying
			// cannot help.
			const detail = (await res.text().catch(() => "")).slice(0, 200);
			return { ok: false, reason: `http_${res.status}`, detail };
		}
		let data: {
			choices?: Array<{ message?: { content?: string | null } }>;
			usage?: { cost?: number };
			error?: { code?: number | string; message?: string };
		};
		try {
			data = (await res.json()) as typeof data;
		} catch {
			last = { reason: "bad_response" };
			continue;
		}
		const content = data.choices?.[0]?.message?.content ?? "";
		if (!content) {
			last = data.error
				? {
						reason: data.error.code === 429 ? "rate_limit" : "upstream_error",
						detail: String(data.error.message ?? "").slice(0, 200),
					}
				: { reason: "empty_response" };
			continue;
		}
		const parsed = parseBatchContent(content, 1);
		if ("error" in parsed) {
			last = { reason: "json_parse", detail: parsed.error.slice(0, 200) };
			continue;
		}
		const out = parsed.outputs[0];
		if (!out) {
			last = { reason: "empty_output" };
			continue;
		}
		const v = validateArticleSummary(
			out.citizen_summary,
			out.citizen_tags,
			text.length,
		);
		if (!v.ok) return { ok: false, reason: v.reason };
		return {
			ok: true,
			summary: v.summary,
			tags: v.tags,
			model,
			promptVersion: ARTICLE_SUMMARY_PROMPT_VERSION,
			cost: data.usage?.cost ?? 0,
		};
	}
	return { ok: false, ...last };
}

// ── Storage ──

/**
 * Stores a generated summary with its model, prompt version and date. Never
 * overwrites: an existing row (even an empty one) wins. The tags are written
 * only when the summary was, and only if the article has none yet.
 * Returns true when the summary was stored.
 */
export function storeArticleSummary(
	db: Database,
	normId: string,
	blockId: string,
	result: {
		summary: string;
		tags: string[];
		model: string;
		promptVersion: string;
	},
): boolean {
	const write = db.transaction(() => {
		const res = db
			.query(
				`INSERT OR IGNORE INTO citizen_article_summaries
				   (norm_id, block_id, summary, model, prompt_version, generated_at)
				 VALUES (?, ?, ?, ?, ?, datetime('now'))`,
			)
			.run(normId, blockId, result.summary, result.model, result.promptVersion);
		if (res.changes === 0) return false;
		const hasTags = db
			.query(
				"SELECT 1 FROM citizen_tags WHERE norm_id = ? AND block_id = ? LIMIT 1",
			)
			.get(normId, blockId);
		if (!hasTags) {
			const insertTag = db.query(
				"INSERT OR IGNORE INTO citizen_tags (norm_id, block_id, tag) VALUES (?, ?, ?)",
			);
			for (const tag of result.tags) insertTag.run(normId, blockId, tag);
		}
		return true;
	});
	return write.immediate();
}
