#!/usr/bin/env bun
// Pull Google Search Console data into a snapshot the loop can reason about.
//
//   SEO_GSC_SA_JSON=/path/to/sa.json bun run scripts/seo/pull-gsc.ts
//
// Writes data/seo/gsc-<date>.json and refreshes data/seo/gsc-latest.json.
// GSC data lags ~2-3 days, so the window ends at today-3.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DATA_DIR,
	type GscSnapshot,
	gscQuery,
	isoDay,
	type QueryMetric,
	SEO_SITE,
	today,
} from "./lib.ts";

const WINDOW_DAYS = 28;
const LAG_DAYS = 3;

const end = isoDay(LAG_DAYS);
const start = isoDay(LAG_DAYS + WINDOW_DAYS);
const prevEnd = isoDay(LAG_DAYS + WINDOW_DAYS + 1);
const prevStart = isoDay(LAG_DAYS + 2 * WINDOW_DAYS + 1);

async function totalsFor(startDate: string, endDate: string, pages: number) {
	const rows = await gscQuery({ startDate, endDate, dimensions: [], rowLimit: 1 });
	const r = rows[0];
	return {
		clicks: r?.clicks ?? 0,
		impressions: r?.impressions ?? 0,
		ctr: r?.ctr ?? 0,
		position: r?.position ?? 0,
		pagesWithImpressions: pages,
	};
}

async function pageCount(startDate: string, endDate: string): Promise<number> {
	const rows = await gscQuery({ startDate, endDate, dimensions: ["page"], rowLimit: 5000 });
	return rows.length;
}

async function main() {
	console.log(`GSC ${SEO_SITE}  current ${start}..${end}  prev ${prevStart}..${prevEnd}`);

	// Current + previous query tables, joined by query key for movement.
	const [curQ, prevQ] = await Promise.all([
		gscQuery({ startDate: start, endDate: end, dimensions: ["query"], rowLimit: 500 }),
		gscQuery({ startDate: prevStart, endDate: prevEnd, dimensions: ["query"], rowLimit: 500 }),
	]);
	const prevByQuery = new Map(prevQ.map((r) => [r.keys[0]!, r]));
	const queries: QueryMetric[] = curQ.map((r) => {
		const prev = prevByQuery.get(r.keys[0]!);
		return {
			query: r.keys[0]!,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: r.ctr,
			position: r.position,
			prevImpressions: prev?.impressions,
			prevPosition: prev?.position,
		};
	});

	const [curPages, curPageCount, prevPageCount] = await Promise.all([
		gscQuery({ startDate: start, endDate: end, dimensions: ["page"], rowLimit: 500 }),
		pageCount(start, end),
		pageCount(prevStart, prevEnd),
	]);

	const [totals, prevTotals] = await Promise.all([
		totalsFor(start, end, curPageCount),
		totalsFor(prevStart, prevEnd, prevPageCount),
	]);

	// Derived signals (see .goals/seo/PLAYBOOK.md priority order).
	const byClicks = (a: QueryMetric, b: QueryMetric) => b.clicks - a.clicks || b.impressions - a.impressions;

	const strikingDistance = queries
		.filter((q) => q.position >= 8 && q.position <= 20 && q.impressions >= 10)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 30);

	const lowCtrQueries = queries
		.filter((q) => q.position <= 10 && q.impressions >= 20 && q.ctr < 0.02)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 30);

	const risingQueries = queries
		.filter((q) => q.impressions >= 10)
		.map((q) => ({ q, delta: q.impressions - (q.prevImpressions ?? 0) }))
		.filter((x) => x.delta > 0)
		.sort((a, b) => b.delta - a.delta)
		.slice(0, 30)
		.map((x) => x.q);

	const topPages = curPages
		.map((r) => ({
			page: r.keys[0]!,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: r.ctr,
			position: r.position,
		}))
		.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
		.slice(0, 50);

	const zeroClickPages = curPages
		.map((r) => ({
			page: r.keys[0]!,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: r.ctr,
			position: r.position,
		}))
		.filter((p) => p.clicks === 0 && p.impressions >= 20)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 30);

	const snapshot: GscSnapshot = {
		source: "gsc",
		snapshotDate: today(),
		site: SEO_SITE,
		window: { start, end },
		prevWindow: { start: prevStart, end: prevEnd },
		totals,
		prevTotals,
		topQueries: [...queries].sort(byClicks).slice(0, 50),
		risingQueries,
		strikingDistance,
		lowCtrQueries,
		topPages,
		zeroClickPages,
	};

	mkdirSync(DATA_DIR, { recursive: true });
	const dated = join(DATA_DIR, `gsc-${today()}.json`);
	writeFileSync(dated, JSON.stringify(snapshot, null, 2));
	writeFileSync(join(DATA_DIR, "gsc-latest.json"), JSON.stringify(snapshot, null, 2));

	const dClicks = totals.clicks - prevTotals.clicks;
	const dPages = totals.pagesWithImpressions - prevTotals.pagesWithImpressions;
	console.log(
		`✓ ${dated}\n  clicks ${totals.clicks} (${dClicks >= 0 ? "+" : ""}${dClicks})  ` +
			`impressions ${totals.impressions}  pages ${totals.pagesWithImpressions} (${dPages >= 0 ? "+" : ""}${dPages})\n` +
			`  striking-distance ${strikingDistance.length}  low-CTR ${lowCtrQueries.length}  rising ${risingQueries.length}`,
	);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
