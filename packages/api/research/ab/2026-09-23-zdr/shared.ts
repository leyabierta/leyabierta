/**
 * Shared helpers for the 2026-09-23 ZDR model/reranker A/B.
 *
 * - Loads the OpenRouter key from `ZDR_EVAL_OPENROUTER_KEY` or the repo `.env`
 *   WITHOUT putting it in `process.env.OPENROUTER_API_KEY` (the harness relies
 *   on that var being unset so the prod reranker degrades to passthrough and
 *   every rerank variant can be applied offline on the same fused pool).
 * - Keeps a spend ledger (`<OUT>/ledger.jsonl`) fed from the `usage.cost`
 *   field OpenRouter returns, and refuses to make a call once the cap
 *   (`ZDR_EVAL_BUDGET_USD`, default 0.38) would be exceeded.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "../../../../..");
export const OUT_DIR =
	process.env.ZDR_EVAL_OUT ?? join(REPO_ROOT, "data/ab-results/2026-09-23-zdr");
mkdirSync(OUT_DIR, { recursive: true });

function loadKey(): string {
	if (process.env.ZDR_EVAL_OPENROUTER_KEY)
		return process.env.ZDR_EVAL_OPENROUTER_KEY;
	const candidates = [
		join(REPO_ROOT, ".env"),
		process.env.ZDR_EVAL_ENV_FILE ?? "",
	].filter(Boolean);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		const m = readFileSync(p, "utf8").match(/^OPENROUTER_API_KEY=(.*)$/m);
		if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, "");
	}
	const fromEnv = process.env.OPENROUTER_API_KEY;
	if (fromEnv) return fromEnv;
	throw new Error("No OpenRouter key (set ZDR_EVAL_OPENROUTER_KEY)");
}

export const OR_KEY = loadKey();
// Make sure prod modules never see the key through the env: the reranker
// would otherwise call the default rerank backend inside runRetrievalCore.
Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");

const LEDGER = join(OUT_DIR, "ledger.jsonl");
export const BUDGET = Number(process.env.ZDR_EVAL_BUDGET_USD ?? "0.38");

export function spent(): number {
	if (!existsSync(LEDGER)) return 0;
	return readFileSync(LEDGER, "utf8")
		.split("\n")
		.filter(Boolean)
		.reduce((s, l) => s + (JSON.parse(l).cost ?? 0), 0);
}

export function record(
	tag: string,
	model: string,
	cost: number,
	extra: Record<string, unknown> = {},
): void {
	appendFileSync(
		LEDGER,
		`${JSON.stringify({ t: new Date().toISOString(), tag, model, cost, ...extra })}\n`,
	);
}

export function guard(expectedNext = 0.01): number {
	const s = spent();
	if (s + expectedNext > BUDGET) {
		throw new Error(
			`BUDGET STOP: spent=$${s.toFixed(4)} + next≈$${expectedNext} > cap $${BUDGET}`,
		);
	}
	return s;
}

const HEADERS = () => ({
	Authorization: `Bearer ${OR_KEY}`,
	"Content-Type": "application/json",
	"HTTP-Referer": "https://leyabierta.es",
	"X-Title": "Ley Abierta eval",
});

// biome-ignore lint/suspicious/noExplicitAny: raw API payloads
export type Json = any;

export async function chat(
	tag: string,
	body: Record<string, unknown>,
	timeoutMs = 120_000,
): Promise<{ status: number; json: Json; ms: number; cost: number }> {
	guard();
	const t0 = performance.now();
	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: HEADERS(),
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const ms = performance.now() - t0;
	const text = await res.text();
	let json: Json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { raw: text.slice(0, 500) };
	}
	const cost = json?.usage?.cost ?? 0;
	record(tag, String(body.model), cost, {
		status: res.status,
		in: json?.usage?.prompt_tokens,
		out: json?.usage?.completion_tokens,
		reasoning: json?.usage?.completion_tokens_details?.reasoning_tokens,
		provider: json?.provider,
		ms: Math.round(ms),
	});
	return { status: res.status, json, ms, cost };
}

export async function rerankApi(
	tag: string,
	body: Record<string, unknown>,
): Promise<{ status: number; json: Json; ms: number; cost: number }> {
	guard();
	const t0 = performance.now();
	const res = await fetch("https://openrouter.ai/api/v1/rerank", {
		method: "POST",
		headers: HEADERS(),
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	const ms = performance.now() - t0;
	const text = await res.text();
	let json: Json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { raw: text.slice(0, 500) };
	}
	const cost = json?.usage?.cost ?? 0;
	record(tag, String(body.model), cost, {
		status: res.status,
		tokens: json?.usage?.total_tokens,
		ms: Math.round(ms),
	});
	return { status: res.status, json, ms, cost };
}

/** Norm-level gold match helpers. */
export function firstGoldRank(
	normIds: string[],
	gold: string[],
): number | null {
	const g = new Set(gold);
	const i = normIds.findIndex((n) => g.has(n));
	return i < 0 ? null : i + 1;
}
