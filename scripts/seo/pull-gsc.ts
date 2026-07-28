#!/usr/bin/env bun
// Pull Google Search Console data into a snapshot the loop can reason about.
//
//   SEO_GSC_SA_JSON=/path/to/sa.json bun run scripts/seo/pull-gsc.ts
//
// Writes data/seo/gsc-<date>.json and refreshes data/seo/gsc-latest.json.
// GSC data lags ~2-3 days, so the window ends at today-3.
//
// Beyond the query/page tables the loop started with, this also pulls the daily
// series, device/country/appearance splits, per-search-type totals, page×query
// pairs, sitemap health, and folds in the latest index-coverage rollup written
// by `inspect-urls.ts`. Every extra block degrades to `undefined` on API error
// rather than failing the run — a missing dimension must not cost us the pull.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DATA_DIR,
	type DimensionMetric,
	type GscSnapshot,
	type GscTotals,
	gscQuery,
	gscQueryAll,
	gscSitemaps,
	type IndexCoverageSummary,
	isoDay,
	type PageMetric,
	type PageQueryMetric,
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

/** Run a block that may 400 on unsupported dimensions; never fail the pull. */
async function soft<T>(
	label: string,
	fn: () => Promise<T>,
): Promise<T | undefined> {
	try {
		return await fn();
	} catch (e) {
		console.warn(`  ! ${label}: ${e instanceof Error ? e.message : e}`);
		return undefined;
	}
}

const toDimension = (r: { keys: string[] } & Omit<DimensionMetric, "key">) => ({
	key: r.keys[0] ?? "",
	clicks: r.clicks,
	impressions: r.impressions,
	ctr: r.ctr,
	position: r.position,
});

const toPage = (
	r: { keys: string[] } & Omit<PageMetric, "page">,
): PageMetric => ({
	page: r.keys[0] ?? "",
	clicks: r.clicks,
	impressions: r.impressions,
	ctr: r.ctr,
	position: r.position,
});

async function totalsFor(
	startDate: string,
	endDate: string,
	pages: number,
	type = "web",
): Promise<GscTotals> {
	const rows = await gscQuery({
		startDate,
		endDate,
		dimensions: [],
		type,
		rowLimit: 1,
	});
	const r = rows[0];
	return {
		clicks: r?.clicks ?? 0,
		impressions: r?.impressions ?? 0,
		ctr: r?.ctr ?? 0,
		position: r?.position ?? 0,
		pagesWithImpressions: pages,
	};
}

/** Full page table (paginated) — also the source of the page count. */
async function allPages(startDate: string, endDate: string) {
	return gscQueryAll({ startDate, endDate, dimensions: ["page"] }, 50000);
}

async function main() {
	console.log(
		`GSC ${SEO_SITE}  current ${start}..${end}  prev ${prevStart}..${prevEnd}`,
	);

	// ── Queries: current vs previous, joined for movement ────────────────────
	const [curQ, prevQ] = await Promise.all([
		gscQueryAll(
			{ startDate: start, endDate: end, dimensions: ["query"] },
			50000,
		),
		gscQueryAll(
			{ startDate: prevStart, endDate: prevEnd, dimensions: ["query"] },
			50000,
		),
	]);
	const prevByQuery = new Map(prevQ.map((r) => [r.keys[0] ?? "", r]));
	const queries: QueryMetric[] = curQ.map((r) => {
		const key = r.keys[0] ?? "";
		const prev = prevByQuery.get(key);
		return {
			query: key,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: r.ctr,
			position: r.position,
			prevImpressions: prev?.impressions,
			prevPosition: prev?.position,
		};
	});

	// ── Pages: current vs previous (previous also powers `lostPages`) ────────
	const [curPagesRaw, prevPagesRaw] = await Promise.all([
		allPages(start, end),
		allPages(prevStart, prevEnd),
	]);
	const curPages = curPagesRaw.map(toPage);
	const curPageKeys = new Set(curPages.map((p) => p.page));

	const [totals, prevTotals] = await Promise.all([
		totalsFor(start, end, curPages.length),
		totalsFor(prevStart, prevEnd, prevPagesRaw.length),
	]);

	// ── Extra dimensions (each independently degradable) ─────────────────────
	const [daily, devices, countries, searchAppearance, pageQueryRows, sitemaps] =
		await Promise.all([
			soft("daily", () =>
				gscQuery({
					startDate: start,
					endDate: end,
					dimensions: ["date"],
					rowLimit: 500,
				}),
			),
			soft("devices", () =>
				gscQuery({
					startDate: start,
					endDate: end,
					dimensions: ["device"],
					rowLimit: 10,
				}),
			),
			soft("countries", () =>
				gscQuery({
					startDate: start,
					endDate: end,
					dimensions: ["country"],
					rowLimit: 250,
				}),
			),
			// searchAppearance cannot be combined with other dimensions.
			soft("searchAppearance", () =>
				gscQuery({
					startDate: start,
					endDate: end,
					dimensions: ["searchAppearance"],
					rowLimit: 50,
				}),
			),
			soft("pageQueries", () =>
				gscQueryAll(
					{ startDate: start, endDate: end, dimensions: ["page", "query"] },
					25000,
				),
			),
			soft("sitemaps", () => gscSitemaps()),
		]);

	// ── Per-search-type totals: web / image / video / news / discover ────────
	const searchTypes: Record<string, GscTotals> = {};
	for (const type of [
		"web",
		"image",
		"video",
		"news",
		"googleNews",
		"discover",
	]) {
		const t = await soft(`type:${type}`, async () => {
			const pages = await gscQuery({
				startDate: start,
				endDate: end,
				dimensions: ["page"],
				type,
				rowLimit: 25000,
			});
			return totalsFor(start, end, pages.length, type);
		});
		// Only keep surfaces we actually appear on — zeros are noise in the plan.
		if (t && t.impressions > 0) searchTypes[type] = t;
	}

	// ── Derived signals (see .goals/seo/PLAYBOOK.md priority order) ──────────
	const byClicks = (a: QueryMetric, b: QueryMetric) =>
		b.clicks - a.clicks || b.impressions - a.impressions;

	const strikingDistance = queries
		.filter((q) => q.position >= 8 && q.position <= 20 && q.impressions >= 10)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 30);

	const lowCtrQueries = queries
		.filter((q) => q.position <= 10 && q.impressions >= 20 && q.ctr < 0.02)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 30);

	const withDelta = queries
		.filter((q) => q.impressions >= 10 || (q.prevImpressions ?? 0) >= 10)
		.map((q) => ({ q, delta: q.impressions - (q.prevImpressions ?? 0) }));

	const risingQueries = withDelta
		.filter((x) => x.delta > 0)
		.sort((a, b) => b.delta - a.delta)
		.slice(0, 30)
		.map((x) => x.q);

	const fallingQueries = withDelta
		.filter((x) => x.delta < 0)
		.sort((a, b) => a.delta - b.delta)
		.slice(0, 30)
		.map((x) => x.q);

	const topPages = [...curPages]
		.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
		.slice(0, 50);

	const zeroClickPages = curPages
		.filter((p) => p.clicks === 0 && p.impressions >= 20)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 30);

	// Pages that ranked last window and vanished from this one — the signal that
	// explains a pagesWithImpressions drop, which a totals diff alone can't.
	const lostPages = prevPagesRaw
		.map(toPage)
		.filter((p) => !curPageKeys.has(p.page) && p.impressions >= 5)
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 50);

	const pageQueries: PageQueryMetric[] | undefined = pageQueryRows
		?.map((r) => ({
			page: r.keys[0] ?? "",
			query: r.keys[1] ?? "",
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: r.ctr,
			position: r.position,
		}))
		.sort((a, b) => b.impressions - a.impressions)
		.slice(0, 500);

	// Fold in the coverage rollup from the last inspect-urls run, if present.
	const coveragePath = join(DATA_DIR, "index-coverage.json");
	let indexCoverage: IndexCoverageSummary | undefined;
	if (existsSync(coveragePath)) {
		try {
			indexCoverage = JSON.parse(
				readFileSync(coveragePath, "utf8"),
			) as IndexCoverageSummary;
		} catch {
			/* a corrupt rollup must not block the pull */
		}
	}

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
		fallingQueries,
		strikingDistance,
		lowCtrQueries,
		topPages,
		zeroClickPages,
		daily: daily?.map(toDimension),
		devices: devices?.map(toDimension),
		countries: countries?.map(toDimension),
		searchAppearance: searchAppearance?.map(toDimension),
		searchTypes: Object.keys(searchTypes).length ? searchTypes : undefined,
		pageQueries,
		lostPages,
		sitemaps,
		indexCoverage,
	};

	mkdirSync(DATA_DIR, { recursive: true });
	const dated = join(DATA_DIR, `gsc-${today()}.json`);
	writeFileSync(dated, JSON.stringify(snapshot, null, 2));
	writeFileSync(
		join(DATA_DIR, "gsc-latest.json"),
		JSON.stringify(snapshot, null, 2),
	);

	const dClicks = totals.clicks - prevTotals.clicks;
	const dPages = totals.pagesWithImpressions - prevTotals.pagesWithImpressions;
	const sitemapErrors = (sitemaps ?? []).reduce((n, s) => n + s.errors, 0);
	console.log(
		`✓ ${dated}\n  clicks ${totals.clicks} (${dClicks >= 0 ? "+" : ""}${dClicks})  ` +
			`impressions ${totals.impressions}  pages ${totals.pagesWithImpressions} (${dPages >= 0 ? "+" : ""}${dPages})\n` +
			`  queries ${queries.length}  page×query ${pageQueries?.length ?? 0}  lost-pages ${lostPages.length}\n` +
			`  striking-distance ${strikingDistance.length}  low-CTR ${lowCtrQueries.length}  ` +
			`rising ${risingQueries.length}  falling ${fallingQueries.length}\n` +
			`  surfaces ${Object.keys(searchTypes).join(", ") || "web only"}  ` +
			`sitemaps ${sitemaps?.length ?? 0} (${sitemapErrors} errors)`,
	);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
