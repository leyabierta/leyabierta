/**
 * Tell IndexNow (Bing, Yandex, Seznam, Naver…) which pages changed.
 *
 * Bing brings far more visits than Google today, and Bing re-crawls on an
 * IndexNow ping instead of waiting for its own schedule. Google does not use
 * IndexNow; for Google the sitemap `<lastmod>` (page-lastmod.ts) is the signal.
 *
 * What changed comes from the two lastmod states of a deploy: the one the
 * build downloaded from production (packages/web/.lastmod-prev.json) and the
 * one it just published (packages/web/dist/lastmod.json). Only URLs whose own
 * content hash changed (or is new) are sent — never the whole site on every
 * deploy. With no previous state (first build, download error) nothing is sent.
 *
 * Usage:
 *   # after each deploy (deploy.yml, non-fatal):
 *   bun run scripts/seo/indexnow.ts --prev packages/web/.lastmod-prev.json --next packages/web/dist/lastmod.json
 *   # one-off initial submission of every page with own content (reads prod):
 *   bun run scripts/seo/indexnow.ts --all
 *   # add --dry-run to print what would be sent.
 *
 * The key is public by design (IndexNow proves site ownership with the file
 * at the key location); it lives in packages/web/public/<key>.txt.
 */

import { existsSync, readFileSync } from "node:fs";
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

/** Every URL a state knows about (for the initial submission). */
export function allKeys(state: LastmodState): {
	laws: string[];
	reforms: string[];
} {
	return {
		laws: Object.keys(state.laws).sort(),
		reforms: Object.keys(state.reforms).sort(),
	};
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
}

async function readState(source: string): Promise<LastmodState | null> {
	try {
		if (source.startsWith("http")) {
			const res = await fetch(source);
			if (!res.ok) return null;
			return parseLastmodState(await res.json());
		}
		if (!existsSync(source)) return null;
		return parseLastmodState(JSON.parse(readFileSync(source, "utf-8")));
	} catch {
		return null;
	}
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
	let keys: { laws: string[]; reforms: string[] };

	if (args.includes("--all")) {
		const next = await readState(
			argValue(args, "--next") ?? `${SITE_ORIGIN}/lastmod.json`,
		);
		if (!next) {
			console.error("[indexnow] no usable lastmod state — nothing to send");
			process.exit(1);
		}
		keys = allKeys(next);
	} else {
		const prevPath = argValue(args, "--prev");
		const nextPath = argValue(args, "--next");
		if (!prevPath || !nextPath) {
			console.error(
				"usage: indexnow.ts --prev <file> --next <file> | --all [--next <file|url>] [--dry-run]",
			);
			process.exit(2);
		}
		const prev = await readState(prevPath);
		const next = await readState(nextPath);
		if (!prev || !next) {
			console.log(
				`[indexnow] previous state: ${prev ? "ok" : "missing"}, new state: ${next ? "ok" : "missing"} — nothing to send`,
			);
			process.exit(0);
		}
		keys = changedKeys(prev, next);
	}

	const urls = keysToUrls(keys);
	console.log(
		`[indexnow] ${keys.laws.length} laws + ${keys.reforms.length} reforms changed → ${urls.length} URLs`,
	);
	if (urls.length === 0) process.exit(0);
	if (dryRun) {
		for (const u of urls.slice(0, 20)) console.log(`  ${u}`);
		if (urls.length > 20) console.log(`  … and ${urls.length - 20} more`);
		process.exit(0);
	}
	for (const batch of chunk(urls, INDEXNOW_MAX_URLS)) await submit(batch);
}
