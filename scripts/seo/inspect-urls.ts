#!/usr/bin/env bun
// URL Inspection sweep: which pages Google actually indexed, and why not.
//
//   SEO_GSC_SA_JSON=/path/to/sa.json bun run scripts/seo/inspect-urls.ts
//   SEO_INSPECT_BUDGET=800 bun run scripts/seo/inspect-urls.ts
//
// Search Analytics tells us what ranks. It says nothing about the ~12k law
// pages that never get an impression — those are invisible to it, so a corpus
// this size needs the Inspection API to tell "not indexed" apart from "indexed
// but never surfaced".
//
// Quota is 2000 inspections/day and 600/minute per property, so this cannot
// sweep the whole corpus in one run. Instead it inspects three cohorts and
// rotates through the corpus across runs using a persistent cache:
//
//   1. Key pages     — the hand-picked entry points, every run
//   2. Ranking pages — whatever GSC currently gives impressions to
//   3. Corpus sample — oldest-inspected law pages first, so runs rotate
//
// Writes:
//   data/seo/inspections.json    full per-URL cache (append/refresh)
//   data/seo/index-coverage.json rollup that pull-gsc.ts folds into snapshots

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cohortOf,
	DATA_DIR,
	GscQuotaError,
	type GscSnapshot,
	gscInspect,
	type IndexCoverageSummary,
	KEY_PAGES,
	SITE_ORIGIN,
	type UrlInspection,
} from "./lib.ts";

// Stay well under the 2000/day cap: the loop may run more than once a day and
// a burnt quota means no coverage data at all until the next reset.
const BUDGET = Number(process.env.SEO_INSPECT_BUDGET ?? 500);
// 600/min is the ceiling; 5 in flight with a 120ms pace lands near 300/min.
const CONCURRENCY = Number(process.env.SEO_INSPECT_CONCURRENCY ?? 5);
const PACE_MS = Number(process.env.SEO_INSPECT_PACE_MS ?? 120);
// Don't re-inspect a URL we already checked recently — spend on unseen ones.
const REFRESH_AFTER_DAYS = Number(process.env.SEO_INSPECT_REFRESH_DAYS ?? 14);
// Per-arm quota for the URL-shape experiment. Treatment is ~662 of ~35k reform
// URLs (1.9%), so a single strided sample over all reforms would draw ~11
// treatment URLs — far below the 200/arm the report needs to decide anything,
// and the same 11 every run since the stride is deterministic. Sampling each
// arm separately with its own quota is what makes the experiment decidable.
const REFORM_SAMPLE_PER_ARM = Number(
	process.env.SEO_INSPECT_REFORM_SAMPLE ?? 300,
);

const CACHE_PATH = join(DATA_DIR, "inspections.json");
const ROLLUP_PATH = join(DATA_DIR, "index-coverage.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadCache(): Map<string, UrlInspection> {
	if (!existsSync(CACHE_PATH)) return new Map();
	try {
		const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as UrlInspection[];
		return new Map(raw.map((i) => [i.url, i]));
	} catch {
		return new Map();
	}
}

/** URLs from a published sitemap — no DB dependency. */
async function sitemapUrls(name: string): Promise<string[]> {
	const res = await fetch(`${SITE_ORIGIN}/${name}`);
	if (!res.ok) {
		console.warn(`  ! ${name}: HTTP ${res.status}`);
		return [];
	}
	const xml = await res.text();
	return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
		.map((m) => m[1]?.trim().replaceAll("&amp;", "&"))
		.filter((u): u is string => Boolean(u));
}

/**
 * Evenly spaced sample. Reform URLs come out of the sitemap in law order, so
 * taking the first N would inspect a handful of laws' worth of reforms and
 * call it a corpus. Striding covers the whole range with the same budget.
 */
function stride<T>(items: T[], n: number): T[] {
	if (items.length <= n) return [...items];
	const step = items.length / n;
	return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]!);
}

function rankingUrls(): string[] {
	const p = join(DATA_DIR, "gsc-latest.json");
	if (!existsSync(p)) return [];
	try {
		const snap = JSON.parse(readFileSync(p, "utf8")) as GscSnapshot;
		return [
			...(snap.topPages ?? []).map((x) => x.page),
			...(snap.zeroClickPages ?? []).map((x) => x.page),
		];
	} catch {
		return [];
	}
}

const daysSince = (iso?: string): number | null =>
	iso ? (Date.now() - new Date(iso).getTime()) / 864e5 : null;

/**
 * Which cohort a URL belongs to — drives the per-cohort coverage breakdown.
 *
 * Reforms split by URL form because that split IS the experiment: `reforma-path`
 * is the treatment group (2026 reforms on `/cambios/reforma/<id>/<date>/`) and
 * `reforma-query` the control (everything else, still on `?id=&date=`). If the
 * treatment group starts getting crawled and the control doesn't, the URL shape
 * was the blocker.
 */

function buildQueue(
	cache: Map<string, UrlInspection>,
	laws: string[],
	reforms: string[],
): string[] {
	const seen = new Set<string>();
	const queue: string[] = [];
	const push = (u: string) => {
		if (!seen.has(u)) {
			seen.add(u);
			queue.push(u);
		}
	};

	// Rotate within a cohort: never-inspected first, then stalest.
	const staleFirst = (urls: string[]) =>
		[...urls].sort((a, b) =>
			(cache.get(a)?.inspectedAt ?? "").localeCompare(
				cache.get(b)?.inspectedAt ?? "",
			),
		);

	// 1. Key pages — always, they define the site's shape for Google.
	for (const p of KEY_PAGES) push(`${SITE_ORIGIN}${p}`);
	// 2. Anything currently earning impressions.
	for (const u of rankingUrls()) push(u);
	// 3+4. Stratify reforms by arm, each with its own quota, then interleave with
	// laws so a budget cut mid-run still leaves a usable sample of every cohort.
	const byArm = new Map<string, string[]>();
	for (const u of reforms) {
		const arm = cohortOf(u);
		const list = byArm.get(arm);
		if (list) list.push(u);
		else byArm.set(arm, [u]);
	}
	const reformQ: string[] = [];
	for (const [, urls] of [...byArm].sort()) {
		reformQ.push(...staleFirst(stride(urls, REFORM_SAMPLE_PER_ARM)));
	}
	const lawQ = staleFirst(laws);
	for (let i = 0; i < Math.max(lawQ.length, reformQ.length); i++) {
		const l = lawQ[i];
		const r = reformQ[i];
		if (l) push(l);
		if (r) push(r);
	}

	// Drop URLs checked recently enough that a re-check buys nothing.
	return queue.filter((u) => {
		const age = daysSince(cache.get(u)?.inspectedAt);
		return age === null || age >= REFRESH_AFTER_DAYS;
	});
}

function rollup(all: UrlInspection[]): IndexCoverageSummary {
	const tally = (pick: (i: UrlInspection) => string | undefined) => {
		const out: Record<string, number> = {};
		for (const i of all) {
			const k = pick(i) ?? "UNKNOWN";
			out[k] = (out[k] ?? 0) + 1;
		}
		return out;
	};

	const ages = all
		.map((i) => daysSince(i.lastCrawlTime))
		.filter((d): d is number => d !== null)
		.sort((a, b) => a - b);
	const median = ages.length
		? Math.round((ages[Math.floor(ages.length / 2)] ?? 0) * 10) / 10
		: null;

	const passes = all.filter((i) => i.verdict === "PASS").length;

	// Per-cohort rates are the actionable cut: a global 14% hides whether laws
	// or reform pages are the ones dragging, and they need different fixes.
	const byCohort: Record<
		string,
		{
			sampled: number;
			crawled: number;
			indexed: number;
			crawlRate: number;
			rate: number;
		}
	> = {};
	for (const i of all) {
		const c = cohortOf(i.url);
		const b = (byCohort[c] ??= {
			sampled: 0,
			crawled: 0,
			indexed: 0,
			crawlRate: 0,
			rate: 0,
		});
		b.sampled++;
		// `crawled` leads `indexed`: Google must fetch a page before it can
		// judge it, and the reform cohort is stuck at the fetch step. For the
		// URL-shape experiment this is the metric that moves first.
		if (i.lastCrawlTime) b.crawled++;
		if (i.verdict === "PASS") b.indexed++;
	}
	for (const b of Object.values(byCohort)) {
		b.crawlRate = b.sampled ? b.crawled / b.sampled : 0;
		b.rate = b.sampled ? b.indexed / b.sampled : 0;
	}

	return {
		inspectedAt: new Date().toISOString(),
		sampled: all.length,
		byVerdict: tally((i) => i.verdict),
		byCoverageState: tally((i) => i.coverageState),
		byFetchState: tally((i) => i.pageFetchState),
		byCohort,
		indexedRate: all.length ? passes / all.length : 0,
		medianCrawlAgeDays: median,
		neverCrawled: all.filter((i) => !i.lastCrawlTime).length,
		canonicalMismatches: all
			.filter(
				(i) =>
					i.googleCanonical &&
					i.userCanonical &&
					i.googleCanonical !== i.userCanonical,
			)
			.slice(0, 50)
			.map((i) => ({ url: i.url, googleCanonical: i.googleCanonical ?? "" })),
		worstOffenders: all
			.filter((i) => i.verdict !== "PASS")
			// Never-crawled first, then stalest: cache order would just surface
			// whatever happened to be inspected first, which diagnoses nothing.
			.sort(
				(a, b) =>
					(daysSince(b.lastCrawlTime) ?? Number.POSITIVE_INFINITY) -
					(daysSince(a.lastCrawlTime) ?? Number.POSITIVE_INFINITY),
			)
			.slice(0, 100)
			.map((i) => ({
				url: i.url,
				coverageState: i.coverageState ?? "unknown",
				lastCrawl: i.lastCrawlTime,
			})),
	};
}

async function main() {
	const cache = loadCache();
	const [laws, reforms] = await Promise.all([
		sitemapUrls("sitemap-leyes.xml"),
		sitemapUrls("sitemap-reformas.xml"),
	]);
	const queue = buildQueue(cache, laws, reforms).slice(0, BUDGET);

	console.log(
		`URL Inspection — leyes ${laws.length}, reformas ${reforms.length} ` +
			`(${[...new Set(reforms.map(cohortOf))].sort().join(", ")}), ` +
			`cached ${cache.size}, queued ${queue.length} (budget ${BUDGET})`,
	);
	if (queue.length === 0) {
		console.log("Nothing stale enough to inspect. Done.");
		return;
	}

	let done = 0;
	let quotaHit = false;

	// Fixed-size worker pool: each worker pulls the next index off the queue.
	let cursor = 0;
	async function worker() {
		while (!quotaHit) {
			const idx = cursor++;
			const url = queue[idx];
			if (!url) return;
			try {
				const result = await gscInspect(url);
				cache.set(url, result);
			} catch (e) {
				if (e instanceof GscQuotaError) {
					quotaHit = true;
					console.warn(`  ! quota exhausted after ${done} inspections`);
					return;
				}
				cache.set(url, {
					url,
					inspectedAt: new Date().toISOString(),
					error: e instanceof Error ? e.message : String(e),
				});
			}
			done++;
			if (done % 50 === 0) console.log(`  ${done}/${queue.length}`);
			await sleep(PACE_MS);
		}
	}

	await Promise.all(Array.from({ length: CONCURRENCY }, worker));

	mkdirSync(DATA_DIR, { recursive: true });
	const all = [...cache.values()];
	writeFileSync(CACHE_PATH, JSON.stringify(all, null, 2));

	// Roll up only over law pages + key pages that were actually inspected —
	// the cache is the accumulated picture, which is what we want to report.
	const summary = rollup(all.filter((i) => !i.error));
	writeFileSync(ROLLUP_PATH, JSON.stringify(summary, null, 2));

	console.log(
		`✓ inspected ${done}  cache ${all.length}\n` +
			`  indexed ${(summary.indexedRate * 100).toFixed(1)}%  ` +
			`median crawl age ${summary.medianCrawlAgeDays ?? "n/a"}d  ` +
			`never crawled ${summary.neverCrawled}\n` +
			`  por cohorte: ${Object.entries(summary.byCohort)
				.map(
					([k, v]) =>
						`${k} ${(v.rate * 100).toFixed(1)}% (${v.indexed}/${v.sampled})`,
				)
				.join("  ")}\n` +
			`  coverage: ${Object.entries(summary.byCoverageState)
				.sort((a, b) => b[1] - a[1])
				.map(([k, v]) => `${k}=${v}`)
				.join("  ")}`,
	);
}

// Guarded: `experiment-report.ts` imports from this file's siblings, and an
// unguarded main() would fire a full 500-URL sweep on any import.
if (import.meta.main) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	});
}
