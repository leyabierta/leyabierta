#!/usr/bin/env bun
// Shared helpers for the SEO loop: config, GSC auth/query, Umami query, and the
// snapshot/plan types every stage of the loop agrees on.
//
// No external deps on purpose: GSC auth is a hand-rolled JWT (node:crypto) so we
// don't drag in google-auth-library (its dependency chain is flaky under Bun).
// Umami is read straight from its co-located Postgres over `docker exec psql`.

import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Config (env with production defaults) ───────────────────────────────────
export const SEO_SITE = process.env.SEO_GSC_SITE ?? "sc-domain:leyabierta.es";
export const SITE_ORIGIN =
	process.env.SEO_SITE_ORIGIN ?? "https://leyabierta.es";
export const UMAMI_WEBSITE_ID =
	process.env.SEO_UMAMI_WEBSITE_ID ?? "58e766e3-e3bb-42bb-b4c8-993cd4f1c47c";

export const DATA_DIR = process.env.SEO_DATA_DIR
	? resolve(process.env.SEO_DATA_DIR)
	: resolve(import.meta.dir, "..", "..", "data", "seo");
export const GOALS_DIR = resolve(import.meta.dir, "..", "..", ".goals", "seo");

// Path to the GSC service-account key JSON. Required for pull-gsc.
const GSC_SA_JSON = process.env.SEO_GSC_SA_JSON;

// ── Date helpers ────────────────────────────────────────────────────────────
export const isoDay = (offsetDays = 0): string =>
	new Date(Date.now() - offsetDays * 864e5).toISOString().slice(0, 10);
export const today = (): string => isoDay(0);

// ── GSC auth: signed JWT → access token (no google-auth-library) ────────────
let cachedToken: { token: string; exp: number } | null = null;

export async function gscToken(): Promise<string> {
	const nowSec = Math.floor(Date.now() / 1000);
	if (cachedToken && cachedToken.exp > nowSec + 60) return cachedToken.token;
	if (!GSC_SA_JSON) {
		throw new Error(
			"SEO_GSC_SA_JSON is not set (path to the GSC service-account key JSON).",
		);
	}
	const key = JSON.parse(readFileSync(GSC_SA_JSON, "utf8")) as {
		client_email: string;
		private_key: string;
	};
	const b64u = (o: unknown) =>
		Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString(
			"base64url",
		);
	const claims = {
		iss: key.client_email,
		scope: "https://www.googleapis.com/auth/webmasters.readonly",
		aud: "https://oauth2.googleapis.com/token",
		iat: nowSec,
		exp: nowSec + 3600,
	};
	const unsigned = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(claims)}`;
	const sig = createSign("RSA-SHA256")
		.update(unsigned)
		.end()
		.sign(key.private_key)
		.toString("base64url");
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: `${unsigned}.${sig}`,
		}),
	});
	const json = (await res.json()) as {
		access_token?: string;
		error_description?: string;
	};
	if (!json.access_token) {
		throw new Error(
			`GSC token error: ${json.error_description ?? JSON.stringify(json)}`,
		);
	}
	cachedToken = { token: json.access_token, exp: nowSec + 3600 };
	return json.access_token;
}

export interface GscRow {
	keys: string[];
	clicks: number;
	impressions: number;
	ctr: number;
	position: number;
}

export async function gscQuery(
	body: Record<string, unknown>,
): Promise<GscRow[]> {
	const token = await gscToken();
	const site = encodeURIComponent(SEO_SITE);
	const res = await fetch(
		`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
	const json = (await res.json()) as {
		rows?: GscRow[];
		error?: { message: string };
	};
	if (json.error) throw new Error(`GSC query error: ${json.error.message}`);
	return json.rows ?? [];
}

// ── Umami: read-only query against the co-located Postgres container ────────
// Runs on KonarServer where the umami-db container lives. For off-server runs,
// override the argv (e.g. wrap in ssh) via SEO_UMAMI_ARGV as a JSON array.
const UMAMI_CONTAINER = process.env.SEO_UMAMI_CONTAINER ?? "code-umami-db-1";
const UMAMI_ARGV: string[] = process.env.SEO_UMAMI_ARGV
	? (JSON.parse(process.env.SEO_UMAMI_ARGV) as string[])
	: [
			"docker",
			"exec",
			"-i",
			UMAMI_CONTAINER,
			"psql",
			"-U",
			"umami",
			"-d",
			"umami",
		];

// Returns rows as arrays of string columns (tuples-only, tab-separated).
export function umamiQuery(sql: string): string[][] {
	const [cmd, ...base] = UMAMI_ARGV;
	if (!cmd) throw new Error("SEO_UMAMI_ARGV is empty");
	const out = execFileSync(cmd, [...base, "-t", "-A", "-F", "\t", "-c", sql], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return out
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => l.split("\t"));
}

// ── Snapshot + plan contracts (shared across pull/plan/benchmark) ───────────
export interface QueryMetric {
	query: string;
	clicks: number;
	impressions: number;
	ctr: number;
	position: number;
	prevImpressions?: number;
	prevPosition?: number;
}

export interface PageMetric {
	page: string;
	clicks: number;
	impressions: number;
	ctr: number;
	position: number;
}

export interface GscSnapshot {
	source: "gsc";
	snapshotDate: string;
	site: string;
	window: { start: string; end: string };
	prevWindow: { start: string; end: string };
	totals: {
		clicks: number;
		impressions: number;
		ctr: number;
		position: number;
		pagesWithImpressions: number;
	};
	prevTotals: GscSnapshot["totals"];
	topQueries: QueryMetric[];
	risingQueries: QueryMetric[];
	strikingDistance: QueryMetric[]; // position 8–20 with real impressions
	lowCtrQueries: QueryMetric[]; // good position, weak CTR
	topPages: PageMetric[];
	zeroClickPages: PageMetric[]; // impressions but no clicks
}

export interface UmamiSnapshot {
	source: "umami";
	snapshotDate: string;
	websiteId: string;
	windowDays: number;
	totals: { pageviews: number; sessions: number };
	topPages: { path: string; views: number }[];
	entryPages: { path: string; entries: number }[];
	referrers: { domain: string; visits: number }[];
	countries: { country: string; sessions: number }[];
	utmSources: { source: string; visits: number }[];
	weekly: { week: string; pageviews: number }[];
}

// ── Model chat client — two backends, no pay-per-use third party ────────────
// MODEL is "provider:model":
//   claude:<alias>  → local `claude -p` CLI (subscription; e.g. claude:sonnet,
//                     claude:opus). Needs `claude` on PATH + an authenticated
//                     session (CLAUDE_CODE_OAUTH_TOKEN or a prior login).
//   nan:<model>     → api.nan.builders, OpenAI-compatible (e.g. nan:deepseek-v4).
// OpenRouter is intentionally NOT supported — no metered spend.
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
export interface ChatResult {
	content: string;
	promptTokens: number;
	completionTokens: number;
	latencyMs: number;
}

export async function chat(
	model: string,
	messages: ChatMessage[],
	opts: { temperature?: number; maxTokens?: number; jsonObject?: boolean } = {},
): Promise<ChatResult> {
	const [providerName, ...rest] = model.split(":");
	const modelId = rest.join(":");
	if (!providerName || !modelId)
		throw new Error(`MODEL must be "provider:model", got "${model}"`);
	if (providerName === "claude") return chatClaude(modelId, messages);
	if (providerName === "nan") return chatNan(modelId, messages, opts);
	throw new Error(
		`Unknown provider "${providerName}". Use claude:<alias> or nan:<model> (OpenRouter is not allowed).`,
	);
}

// Local Claude Code CLI. Concatenates non-system messages as the prompt and
// passes the system content via --append-system-prompt.
function chatClaude(modelId: string, messages: ChatMessage[]): ChatResult {
	const system = messages
		.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n\n");
	const user = messages
		.filter((m) => m.role !== "system")
		.map((m) => m.content)
		.join("\n\n");
	const args = [
		"-p",
		"--output-format",
		"json",
		"--model",
		modelId || "sonnet",
	];
	if (system) args.push("--append-system-prompt", system);
	const t0 = Date.now();
	const out = execFileSync("claude", args, {
		input: user,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	const latencyMs = Date.now() - t0;
	const d = JSON.parse(out) as {
		result?: string;
		is_error?: boolean;
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	if (d.is_error || typeof d.result !== "string") {
		throw new Error(`claude:${modelId} error: ${out.slice(0, 200)}`);
	}
	return {
		content: d.result,
		promptTokens: d.usage?.input_tokens ?? 0,
		completionTokens: d.usage?.output_tokens ?? 0,
		latencyMs,
	};
}

async function chatNan(
	modelId: string,
	messages: ChatMessage[],
	opts: { temperature?: number; maxTokens?: number; jsonObject?: boolean },
): Promise<ChatResult> {
	const key = process.env.NAN_API_KEY ?? process.env.HERMES_API_KEY;
	if (!key) throw new Error("NAN_API_KEY / HERMES_API_KEY not set");
	const base = process.env.NAN_BASE_URL ?? "https://api.nan.builders/v1";
	const t0 = Date.now();
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: modelId,
			messages,
			temperature: opts.temperature ?? 0.4,
			max_tokens: opts.maxTokens ?? 4000,
			...(opts.jsonObject ? { response_format: { type: "json_object" } } : {}),
		}),
	});
	const latencyMs = Date.now() - t0;
	const json = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
		usage?: { prompt_tokens?: number; completion_tokens?: number };
		error?: { message?: string };
	};
	if (json.error)
		throw new Error(
			`nan:${modelId} error: ${json.error.message ?? JSON.stringify(json.error)}`,
		);
	const content = json.choices?.[0]?.message?.content;
	if (!content) throw new Error(`nan:${modelId}: empty response`);
	return {
		content,
		promptTokens: json.usage?.prompt_tokens ?? 0,
		completionTokens: json.usage?.completion_tokens ?? 0,
		latencyMs,
	};
}

// Best-effort extraction of a JSON object from a (possibly fenced) model reply.
export function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced?.[1] ?? text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end === -1)
		throw new Error("no JSON object in model response");
	return JSON.parse(candidate.slice(start, end + 1));
}

// ── Playbook path guard (whitelist/blacklist from PLAYBOOK.md) ──────────────
const WHITELIST_PREFIXES = [
	"packages/web/src/pages/",
	"packages/web/src/components/",
	"packages/web/src/layouts/",
];
const BLACKLIST_PATTERNS = [
	/^packages\/api\//,
	/^packages\/pipeline\//,
	/^packages\/eval\//,
	/^packages\/search-lab\//,
	/^packages\/shared\//,
	/^data\//,
	/^scripts\//,
	/(^|\/)\.env/,
	/(^|\/)docker-compose\.ya?ml$/,
	/^\.github\//,
	/(^|\/)robots\.txt$/,
];
export function pathViolations(files: string[]): string[] {
	const bad: string[] = [];
	for (const f of files) {
		const p = f.replace(/^\.?\//, "");
		if (BLACKLIST_PATTERNS.some((re) => re.test(p)))
			bad.push(`${f} (blacklisted)`);
		else if (!WHITELIST_PREFIXES.some((pre) => p.startsWith(pre)))
			bad.push(`${f} (outside whitelist)`);
	}
	return bad;
}

export type ActionType =
	| "meta"
	| "jsonld"
	| "internal-link"
	| "hub-page"
	| "copy"
	| "sitemap-hint";

export interface PlanAction {
	id: string;
	type: ActionType;
	hypothesis: string;
	signal: Record<string, unknown>;
	files: string[];
	change: string;
	expectedImpact: string;
	effort: "S" | "M" | "L";
	requiresHumanReview: boolean;
}

export interface Plan {
	iteration: number;
	snapshotDate: string;
	model: string;
	summary: string;
	actions: PlanAction[];
	estimatedCostEur: number;
	notes: string;
}
