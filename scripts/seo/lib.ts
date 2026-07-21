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
export const SITE_ORIGIN = process.env.SEO_SITE_ORIGIN ?? "https://leyabierta.es";
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
		throw new Error("SEO_GSC_SA_JSON is not set (path to the GSC service-account key JSON).");
	}
	const key = JSON.parse(readFileSync(GSC_SA_JSON, "utf8")) as {
		client_email: string;
		private_key: string;
	};
	const b64u = (o: unknown) =>
		Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
	const claims = {
		iss: key.client_email,
		scope: "https://www.googleapis.com/auth/webmasters.readonly",
		aud: "https://oauth2.googleapis.com/token",
		iat: nowSec,
		exp: nowSec + 3600,
	};
	const unsigned = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(claims)}`;
	const sig = createSign("RSA-SHA256").update(unsigned).end().sign(key.private_key).toString("base64url");
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: `${unsigned}.${sig}`,
		}),
	});
	const json = (await res.json()) as { access_token?: string; error_description?: string };
	if (!json.access_token) {
		throw new Error(`GSC token error: ${json.error_description ?? JSON.stringify(json)}`);
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

export async function gscQuery(body: Record<string, unknown>): Promise<GscRow[]> {
	const token = await gscToken();
	const site = encodeURIComponent(SEO_SITE);
	const res = await fetch(
		`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	const json = (await res.json()) as { rows?: GscRow[]; error?: { message: string } };
	if (json.error) throw new Error(`GSC query error: ${json.error.message}`);
	return json.rows ?? [];
}

// ── Umami: read-only query against the co-located Postgres container ────────
// Runs on KonarServer where the umami-db container lives. For off-server runs,
// override the argv (e.g. wrap in ssh) via SEO_UMAMI_ARGV as a JSON array.
const UMAMI_CONTAINER = process.env.SEO_UMAMI_CONTAINER ?? "code-umami-db-1";
const UMAMI_ARGV: string[] = process.env.SEO_UMAMI_ARGV
	? (JSON.parse(process.env.SEO_UMAMI_ARGV) as string[])
	: ["docker", "exec", "-i", UMAMI_CONTAINER, "psql", "-U", "umami", "-d", "umami"];

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
