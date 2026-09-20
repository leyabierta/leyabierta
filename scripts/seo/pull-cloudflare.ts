#!/usr/bin/env bun
// Pull request/cache/Worker signals from Cloudflare's GraphQL Analytics API.
// Complements GSC (what Google sees) and Umami (what humans do): this is what
// actually happens at the edge — total traffic, cache-hit ratio, and whether
// the Worker is trending back toward its daily invocation cap.
//
//   SEO_CF_API_TOKEN=… SEO_CF_ZONE_ID=… SEO_CF_ACCOUNT_ID=… \
//     bun run scripts/seo/pull-cloudflare.ts
//
// The token needs "Zone → Analytics → Read" (for zoneId) and
// "Account → Workers Scripts → Read" (for accountId) scoped to this zone —
// create a scoped API token in the Cloudflare dashboard, do NOT reuse
// CLOUDFLARE_API_TOKEN from deploy.yml (that one is Pages-deploy scoped, not
// Analytics-read). Zone ID is on the zone's Overview page; Account ID is in
// the Workers & Pages sidebar.
//
// Known gap: the per-bot breakdown (GPTBot vs ClaudeBot vs Googlebot) shown in
// the AI Crawl Control dashboard tab is not backed by a public GraphQL
// dataset — this script cannot pull it. Read it by hand in the dashboard when
// investigating a traffic spike; see .goals/seo/STATUS.md 2026-09-19/20 for an
// example of that reading.
//
// Writes data/seo/cloudflare-<date>.json and refreshes cloudflare-latest.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CloudflareSnapshot, DATA_DIR, today } from "./lib.ts";

const WINDOW_DAYS = Number(process.env.SEO_CF_WINDOW_DAYS ?? 7);
const WORKER_SCRIPT_NAME =
	process.env.SEO_CF_WORKER_SCRIPT_NAME ?? "leyabierta-web";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

interface GraphQLResponse<T> {
	data?: T;
	errors?: { message: string }[];
}

async function graphql<T>(
	token: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<T> {
	const res = await fetch(GRAPHQL_URL, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});
	const json = (await res.json()) as GraphQLResponse<T>;
	if (json.errors?.length) {
		throw new Error(
			`Cloudflare GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
		);
	}
	if (!json.data) throw new Error("Cloudflare GraphQL: empty response");
	return json.data;
}

interface ZoneGroups {
	viewer: {
		zones: {
			httpRequests1dGroups: {
				date: string;
				sum: {
					requests: number;
					cachedRequests: number;
					threats: number;
					bytes: number;
				};
			}[];
		}[];
	};
}

interface WorkerGroups {
	viewer: {
		accounts: {
			workersInvocationsAdaptive: {
				dimensions: { datetime: string };
				sum: { requests: number; errors: number; subrequests: number };
			}[];
		}[];
	};
}

async function pullZone(
	token: string,
	zoneId: string,
	since: string,
	until: string,
) {
	const data = await graphql<ZoneGroups>(
		token,
		`query ZoneRequests($zoneId: String!, $since: Time!, $until: Time!) {
			viewer {
				zones(filter: { zoneTag: $zoneId }) {
					httpRequests1dGroups(
						limit: 31
						filter: { date_geq: $since, date_leq: $until }
						orderBy: [date_ASC]
					) {
						date
						sum { requests cachedRequests threats bytes }
					}
				}
			}
		}`,
		{ zoneId, since, until },
	);
	return data.viewer.zones[0]?.httpRequests1dGroups ?? [];
}

// Cloudflare's Workers Analytics dataset returns one row per adaptively-sized
// time bucket (not pre-grouped by day like the zone dataset), so the daily
// series is built here by truncating `dimensions.datetime` to its date part
// and summing buckets that land on the same day.
async function pullWorker(
	token: string,
	accountId: string,
	scriptName: string,
	since: string,
	until: string,
) {
	const data = await graphql<WorkerGroups>(
		token,
		`query WorkerRequests($accountId: String!, $scriptName: String!, $since: Time!, $until: Time!) {
			viewer {
				accounts(filter: { accountTag: $accountId }) {
					workersInvocationsAdaptive(
						limit: 10000
						filter: { scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until }
						orderBy: [datetime_ASC]
					) {
						dimensions { datetime }
						sum { requests errors subrequests }
					}
				}
			}
		}`,
		{ accountId, scriptName, since, until },
	);
	return data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
}

function sum(nums: number[]): number {
	return nums.reduce((a, b) => a + b, 0);
}

export function groupWorkerByDay(
	rows: WorkerGroups["viewer"]["accounts"][number]["workersInvocationsAdaptive"],
): { date: string; requests: number; errors: number }[] {
	const byDay = new Map<string, { requests: number; errors: number }>();
	for (const row of rows) {
		const date = row.dimensions.datetime.slice(0, 10);
		const acc = byDay.get(date) ?? { requests: 0, errors: 0 };
		acc.requests += row.sum.requests;
		acc.errors += row.sum.errors;
		byDay.set(date, acc);
	}
	return [...byDay.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, v]) => ({ date, ...v }));
}

async function main() {
	const token = process.env.SEO_CF_API_TOKEN;
	const zoneId = process.env.SEO_CF_ZONE_ID;
	const accountId = process.env.SEO_CF_ACCOUNT_ID;
	if (!token) throw new Error("SEO_CF_API_TOKEN is not set.");
	if (!zoneId) throw new Error("SEO_CF_ZONE_ID is not set.");
	if (!accountId) throw new Error("SEO_CF_ACCOUNT_ID is not set.");

	const until = today();
	const since = new Date(Date.now() - WINDOW_DAYS * 864e5)
		.toISOString()
		.slice(0, 10);

	const [zoneGroups, workerGroups] = await Promise.all([
		pullZone(token, zoneId, since, until),
		pullWorker(token, accountId, WORKER_SCRIPT_NAME, since, until),
	]);

	const zoneRequests = sum(zoneGroups.map((g) => g.sum.requests));
	const zoneCached = sum(zoneGroups.map((g) => g.sum.cachedRequests));

	const snapshot: CloudflareSnapshot = {
		source: "cloudflare",
		snapshotDate: today(),
		zoneId,
		windowDays: WINDOW_DAYS,
		zone: {
			requests: zoneRequests,
			cachedRequests: zoneCached,
			cacheHitRatio: zoneRequests > 0 ? zoneCached / zoneRequests : 0,
			bytes: sum(zoneGroups.map((g) => g.sum.bytes)),
			threats: sum(zoneGroups.map((g) => g.sum.threats)),
		},
		zoneDaily: zoneGroups.map((g) => ({
			date: g.date,
			requests: g.sum.requests,
			cachedRequests: g.sum.cachedRequests,
			threats: g.sum.threats,
		})),
		worker: {
			scriptName: WORKER_SCRIPT_NAME,
			requests: sum(workerGroups.map((g) => g.sum.requests)),
			errors: sum(workerGroups.map((g) => g.sum.errors)),
			subrequests: sum(workerGroups.map((g) => g.sum.subrequests)),
		},
		workerDaily: groupWorkerByDay(workerGroups),
	};

	mkdirSync(DATA_DIR, { recursive: true });
	const dated = join(DATA_DIR, `cloudflare-${today()}.json`);
	writeFileSync(dated, JSON.stringify(snapshot, null, 2));
	writeFileSync(
		join(DATA_DIR, "cloudflare-latest.json"),
		JSON.stringify(snapshot, null, 2),
	);

	console.log(
		`✓ ${dated}\n  zone requests ${snapshot.zone.requests} (${(snapshot.zone.cacheHitRatio * 100).toFixed(1)}% cached)  ` +
			`worker(${WORKER_SCRIPT_NAME}) requests ${snapshot.worker.requests}, errors ${snapshot.worker.errors}`,
	);
}

if (import.meta.main) {
	try {
		await main();
	} catch (e) {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	}
}
