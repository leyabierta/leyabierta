/**
 * A/B Qwen 3.6 thinking ON vs OFF (NaN endpoint).
 *
 * Same prompt v11, same articles, same schema. Two requests per article:
 *  - A: default (thinking ON)
 *  - B: chat_template_kwargs.enable_thinking=false (thinking OFF)
 *
 * Measures latency, success rate, length, and writes pairs for external
 * Sonnet judging.
 *
 * Usage:
 *   bun run packages/api/src/scripts/ab-thinking-on-off.ts [--n 20] [--out tmp/thinking-ab.json]
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";

const DB_PATH = "data/leyabierta.db";
const HERMES_BASE_URL = "https://api.nan.builders/v1";
const HERMES_API_KEY = process.env.HERMES_API_KEY ?? "";

const args = process.argv.slice(2);
const N = args.includes("--n")
	? Number(args[args.indexOf("--n") + 1] ?? 20)
	: 20;
const OUT = args.includes("--out")
	? args[args.indexOf("--out") + 1]
	: "tmp/thinking-ab.json";

mkdirSync("tmp", { recursive: true });

// Reuse v11 system prompt from compare-citizen-models.ts
const SYSTEM_PROMPT = await (async () => {
	const src = await Bun.file(
		"packages/api/src/scripts/compare-citizen-models.ts",
	).text();
	const m = src.match(/const SYSTEM_PROMPT_V10 = `([\s\S]*?)`;/);
	if (!m) throw new Error("Could not extract SYSTEM_PROMPT_V10");
	return m[1];
})();

const SCHEMA = {
	name: "citizen_metadata",
	strict: true,
	schema: {
		type: "object",
		properties: {
			citizen_summary: { type: "string" },
			citizen_tags: { type: "array", items: { type: "string" } },
		},
		required: ["citizen_summary", "citizen_tags"],
		additionalProperties: false,
	},
};

interface Article {
	norm_id: string;
	block_id: string;
	norm_title: string;
	block_title: string;
	current_text: string;
}

interface Summary {
	citizen_summary: string;
	citizen_tags: string[];
}

const db = new Database(DB_PATH);

function stratifiedSample(total: number): Article[] {
	const buckets = ["a", "dt", "da", "df", "dd"];
	const perBucket = Math.ceil(total / buckets.length);
	const out: Article[] = [];
	for (const prefix of buckets) {
		const rows = db
			.prepare(
				`
			SELECT n.id AS norm_id, n.title AS norm_title,
			       b.block_id, b.title AS block_title, b.current_text
			FROM norms n
			JOIN blocks b ON b.norm_id = n.id
			WHERE n.status = 'vigente'
			  AND b.block_type = 'precepto'
			  AND length(b.current_text) BETWEEN 200 AND 2000
			  AND b.block_id LIKE ?
			ORDER BY RANDOM()
			LIMIT ?
		`,
			)
			.all(`${prefix}%`, perBucket) as Article[];
		out.push(...rows);
	}
	return out.slice(0, total);
}

const userPromptFor = (a: Article) =>
	`LEY: ${a.norm_title}\nTÍTULO: ${a.block_title}\nTEXTO:\n${a.current_text.slice(0, 2000)}\n\nGenera el resumen ciudadano de este artículo siguiendo todas las reglas.`;

function robustParse(text: string): Summary | null {
	try {
		const v = JSON.parse(text);
		if (v && typeof v.citizen_summary === "string") return v as Summary;
	} catch {}
	const first = text.indexOf("{");
	if (first === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = first; i < text.length; i++) {
		const c = text[i];
		if (esc) {
			esc = false;
			continue;
		}
		if (c === "\\") {
			esc = true;
			continue;
		}
		if (c === '"') {
			inStr = !inStr;
			continue;
		}
		if (inStr) continue;
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				try {
					const v = JSON.parse(text.slice(first, i + 1));
					if (v && typeof v.citizen_summary === "string") return v as Summary;
				} catch {}
				break;
			}
		}
	}
	return null;
}

interface Result {
	output: Summary | null;
	error: string | null;
	latencyMs: number;
	completionTokens: number;
	thinkingTokens: number; // approx: completion - content_tokens
}

async function callQwen(a: Article, thinking: boolean): Promise<Result> {
	const start = Date.now();
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 120_000);
	try {
		const body: Record<string, unknown> = {
			model: "qwen3.6",
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: userPromptFor(a) },
			],
			temperature: 0.2,
			max_tokens: 8000,
			response_format: { type: "json_schema", json_schema: SCHEMA },
		};
		if (!thinking) {
			body.chat_template_kwargs = { enable_thinking: false };
		}
		const res = await fetch(`${HERMES_BASE_URL}/chat/completions`, {
			method: "POST",
			signal: ctrl.signal,
			headers: {
				Authorization: `Bearer ${HERMES_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		const latencyMs = Date.now() - start;
		if (!res.ok) {
			const errBody = await res.text().catch(() => "");
			return {
				output: null,
				error: `http_${res.status}: ${errBody.slice(0, 100)}`,
				latencyMs,
				completionTokens: 0,
				thinkingTokens: 0,
			};
		}
		const data = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
			usage?: { completion_tokens?: number };
		};
		const text = data.choices?.[0]?.message?.content ?? "";
		const completionTokens = data.usage?.completion_tokens ?? 0;
		const contentTokensApprox = Math.ceil(text.length / 3);
		const thinkingTokens = Math.max(0, completionTokens - contentTokensApprox);
		const parsed = robustParse(text);
		if (!parsed)
			return {
				output: null,
				error: `parse: ${text.slice(0, 80)}`,
				latencyMs,
				completionTokens,
				thinkingTokens,
			};
		return {
			output: parsed,
			error: null,
			latencyMs,
			completionTokens,
			thinkingTokens,
		};
	} catch (e) {
		const latencyMs = Date.now() - start;
		return {
			output: null,
			error:
				(e as Error).name === "AbortError"
					? "timeout"
					: `fetch: ${(e as Error).message}`,
			latencyMs,
			completionTokens: 0,
			thinkingTokens: 0,
		};
	} finally {
		clearTimeout(t);
	}
}

// Main
const articles = stratifiedSample(N);
console.log(
	`Sampled ${articles.length} articles. Running A/B (thinking on vs off)…`,
);

interface Pair {
	article: Article;
	thinking_on: Result;
	thinking_off: Result;
}
const rows: Pair[] = [];
let cursor = 0;
let done = 0;
const startedAt = Date.now();

const CONC = 5;
async function worker() {
	while (true) {
		const idx = cursor++;
		if (idx >= articles.length) return;
		const a = articles[idx];
		// Sequential per article so the same upstream queue handles both;
		// concurrency across articles uses CONC workers.
		const on = await callQwen(a, true);
		const off = await callQwen(a, false);
		rows[idx] = { article: a, thinking_on: on, thinking_off: off };
		done++;
		const elapsed = (Date.now() - startedAt) / 1000;
		process.stdout.write(
			`\r  ${done}/${articles.length} (${(done / elapsed).toFixed(2)}/s)   `,
		);
	}
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log();

// Aggregate
const summary = {
	total: rows.length,
	on: {
		errors: rows.filter((r) => r.thinking_on.error).length,
		avg_latency_ms: 0,
		avg_completion_tokens: 0,
		avg_thinking_tokens: 0,
		avg_summary_len: 0,
	},
	off: {
		errors: rows.filter((r) => r.thinking_off.error).length,
		avg_latency_ms: 0,
		avg_completion_tokens: 0,
		avg_thinking_tokens: 0,
		avg_summary_len: 0,
	},
};

let onN = 0;
let offN = 0;
for (const r of rows) {
	if (!r.thinking_on.error) {
		summary.on.avg_latency_ms += r.thinking_on.latencyMs;
		summary.on.avg_completion_tokens += r.thinking_on.completionTokens;
		summary.on.avg_thinking_tokens += r.thinking_on.thinkingTokens;
		summary.on.avg_summary_len +=
			r.thinking_on.output?.citizen_summary.length ?? 0;
		onN++;
	}
	if (!r.thinking_off.error) {
		summary.off.avg_latency_ms += r.thinking_off.latencyMs;
		summary.off.avg_completion_tokens += r.thinking_off.completionTokens;
		summary.off.avg_thinking_tokens += r.thinking_off.thinkingTokens;
		summary.off.avg_summary_len +=
			r.thinking_off.output?.citizen_summary.length ?? 0;
		offN++;
	}
}
if (onN) {
	summary.on.avg_latency_ms = Math.round(summary.on.avg_latency_ms / onN);
	summary.on.avg_completion_tokens = Math.round(
		summary.on.avg_completion_tokens / onN,
	);
	summary.on.avg_thinking_tokens = Math.round(
		summary.on.avg_thinking_tokens / onN,
	);
	summary.on.avg_summary_len = Math.round(summary.on.avg_summary_len / onN);
}
if (offN) {
	summary.off.avg_latency_ms = Math.round(summary.off.avg_latency_ms / offN);
	summary.off.avg_completion_tokens = Math.round(
		summary.off.avg_completion_tokens / offN,
	);
	summary.off.avg_thinking_tokens = Math.round(
		summary.off.avg_thinking_tokens / offN,
	);
	summary.off.avg_summary_len = Math.round(summary.off.avg_summary_len / offN);
}

writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
console.log("Summary:", JSON.stringify(summary, null, 2));
console.log("Wrote pairs to", OUT);
