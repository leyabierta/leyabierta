/**
 * Tell IndexNow (Bing, Yandex, Seznam, Naver…) which pages changed.
 *
 * Bing brings far more visits than Google today, and Bing re-crawls on an
 * IndexNow ping instead of waiting for its own schedule. Google does not use
 * IndexNow; for Google the sitemap `<lastmod>` (page-lastmod.ts) is the signal.
 *
 * What changed comes from the two lastmod states of a deploy: the one the
 * build downloaded from production (packages/web/.lastmod-prev.json) and the
 * one it just published (packages/web/dist/lastmod.json). Only URLs dated in
 * this build (new or changed own content) are sent — never the whole site on
 * every deploy, never keys re-baselined by the mass-change brake. With no
 * previous state (bootstrap) nothing is sent. Every URL is also checked
 * against the sitemaps: only pages we advertise as indexable are pinged.
 *
 * Usage:
 *   # after each deploy (deploy.yml, non-fatal):
 *   bun run scripts/seo/indexnow.ts --prev packages/web/.lastmod-prev.json --next packages/web/dist/lastmod.json
 *   # one-off initial submission of every law page with own content (reads prod):
 *   bun run scripts/seo/indexnow.ts --all [--include-reforms]
 *   # add --dry-run to print what would be sent; --sitemaps <dir|origin> to
 *   # choose where the sitemaps are read from (default: next to --next, or prod).
 *
 * The key is public by design (IndexNow proves site ownership with the file
 * at the key location); it lives in packages/web/public/<key>.txt.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	changedKeys,
	type LastmodState,
	parseLastmodState,
} from "../../packages/web/src/lib/page-lastmod.ts";
import { reformCanonicalPath } from "../../packages/web/src/lib/reform-experiment.ts";

export const INDEXNOW_KEY = "28413de9c7a3bfc62964c36a93a05527";
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
/** Protocol limit per request. */
export const INDEXNOW_MAX_URLS = 10_000;
const SITE_HOST = "leyabierta.es";
const SITE_ORIGIN = `https://${SITE_HOST}`;
const SITEMAPS = ["sitemap-leyes.xml", "sitemap-reformas.xml"];

/** Absolute URLs for law ids and `<lawId>|<date>` reform keys. */
export function keysToUrls(
	keys: { laws: readonly string[]; reforms: readonly string[] },
	origin: string = SITE_ORIGIN,
): string[] {
	const urls = keys.laws.map((id) => `${origin}/leyes/${id}/`);
	for (const key of keys.reforms) {
		const sep = key.lastIndexOf("|");
		if (sep <= 0) continue;
		urls.push(
			`${origin}${reformCanonicalPath(key.slice(0, sep), key.slice(sep + 1))}`,
		);
	}
	return urls;
}

/** `<loc>` values of a sitemap, XML entities decoded. */
export function sitemapLocs(xml: string): string[] {
	return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
		m[1]!
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&amp;/g, "&"),
	);
}

/** Keep only URLs the sitemaps advertise (indexable, canonical form). */
export function filterToSitemap(
	urls: readonly string[],
	advertised: ReadonlySet<string>,
): string[] {
	return urls.filter((u) => advertised.has(u));
}

/** Every key a state knows about, absent keys excluded (initial submission). */
export function allKeys(
	state: LastmodState,
	includeReforms = false,
): { laws: string[]; reforms: string[] } {
	const present = (m: LastmodState["laws"]) =>
		Object.keys(m)
			.filter((k) => m[k]!.length === 2)
			.sort();
	return {
		laws: present(state.laws),
		reforms: includeReforms ? present(state.reforms) : [],
	};
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
}

async function readText(source: string): Promise<string | null> {
	try {
		if (source.startsWith("http")) {
			const res = await fetch(source);
			return res.ok ? await res.text() : null;
		}
		return existsSync(source) ? readFileSync(source, "utf-8") : null;
	} catch {
		return null;
	}
}

async function readState(source: string): Promise<LastmodState | null> {
	const text = await readText(source);
	if (text === null) return null;
	try {
		return parseLastmodState(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Union of the sitemap URLs, or null if any sitemap cannot be read. */
async function readSitemaps(base: string): Promise<Set<string> | null> {
	const all = new Set<string>();
	for (const name of SITEMAPS) {
		const src = base.startsWith("http") ? `${base}/${name}` : join(base, name);
		const xml = await readText(src);
		if (xml === null) return null;
		for (const loc of sitemapLocs(xml)) all.add(loc);
	}
	return all;
}

async function submit(urlList: string[]): Promise<void> {
	const res = await fetch(INDEXNOW_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({
			host: SITE_HOST,
			key: INDEXNOW_KEY,
			keyLocation: `${SITE_ORIGIN}/${INDEXNOW_KEY}.txt`,
			urlList,
		}),
	});
	// 200 = received, 202 = received, key validation pending.
	if (res.status !== 200 && res.status !== 202) {
		throw new Error(
			`IndexNow ${res.status}: ${(await res.text()).slice(0, 300)}`,
		);
	}
	console.log(`  ✓ ${urlList.length} URLs (HTTP ${res.status})`);
}

function argValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const nextArg = argValue(args, "--next");
	let keys: { laws: string[]; reforms: string[] };

	if (args.includes("--all")) {
		const next = await readState(nextArg ?? `${SITE_ORIGIN}/lastmod.json`);
		if (!next?.complete) {
			console.error("[indexnow] no usable lastmod state — nothing to send");
			process.exit(1);
		}
		keys = allKeys(next, args.includes("--include-reforms"));
	} else {
		const prevPath = argValue(args, "--prev");
		if (!prevPath || !nextArg) {
			console.error(
				"usage: indexnow.ts --prev <file> --next <file> | --all [--include-reforms] [--next <file|url>] [--sitemaps <dir|url>] [--dry-run]",
			);
			process.exit(2);
		}
		const prev = await readState(prevPath);
		const next = await readState(nextArg);
		if (!prev || !next) {
			console.log(
				`[indexnow] previous state: ${prev ? "ok" : "missing"}, new state: ${next ? "ok" : "missing"} — nothing to send`,
			);
			process.exit(0);
		}
		keys = changedKeys(prev, next);
	}

	const candidates = keysToUrls(keys);
	if (candidates.length === 0) {
		console.log("[indexnow] no changed pages — nothing to send");
		process.exit(0);
	}
	const sitemapBase =
		argValue(args, "--sitemaps") ??
		(nextArg && !nextArg.startsWith("http") ? dirname(nextArg) : SITE_ORIGIN);
	const advertised = await readSitemaps(sitemapBase);
	if (!advertised) {
		console.error(
			`[indexnow] cannot read the sitemaps at ${sitemapBase} — not sending`,
		);
		process.exit(1);
	}
	const urls = filterToSitemap(candidates, advertised);
	console.log(
		`[indexnow] ${keys.laws.length} laws + ${keys.reforms.length} reforms → ${urls.length} URLs in the sitemaps`,
	);
	if (urls.length === 0) process.exit(0);
	if (dryRun) {
		for (const u of urls.slice(0, 20)) console.log(`  ${u}`);
		if (urls.length > 20) console.log(`  … and ${urls.length - 20} more`);
		process.exit(0);
	}
	for (const batch of chunk(urls, INDEXNOW_MAX_URLS)) await submit(batch);
}
