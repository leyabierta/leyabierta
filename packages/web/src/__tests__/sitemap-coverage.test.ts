// Guards the failure that hid /datos/ and /pregunta/ from Google: a page
// exists, works, and is indexable, but nobody ever tells a crawler about it —
// and nothing errors. A URL Inspection sweep on 2026-07-28 found both at
// "Google no reconoce esta URL".
//
// Asserts against SECONDARY_PAGES / SITEMAP_EXCLUDED directly, not against the
// text of sitemap-leyes.xml.ts. Matching source text would pass on a route that
// only survives inside a comment while the emitted sitemap has no such entry —
// the very bug this is here to catch.
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SECONDARY_PAGES, SITEMAP_EXCLUDED } from "../lib/site-pages.ts";

const PAGES_DIR = new URL("../pages", import.meta.url).pathname;

/** Page files Astro turns into routes. */
const PAGE_EXTENSIONS = [".astro", ".md", ".mdx", ".html"];

/**
 * Static routes under src/pages, as site paths.
 *
 * Dynamic routes ([id].astro) are skipped — they have their own sitemaps. So is
 * anything under a dynamic directory (leyes/[id]/algo.astro): it expands to one
 * route per id, which can't live in a hand-maintained list either. Known limit
 * of this guard — if such a page is ever added, it needs its own sitemap and a
 * check of its own.
 */
function staticRoutes(dir = PAGES_DIR, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...staticRoutes(full, `${prefix}${entry}/`));
			continue;
		}
		const ext = PAGE_EXTENSIONS.find((e) => entry.endsWith(e));
		if (!ext) continue;
		const name = entry.slice(0, -ext.length);
		// A dynamic *file* ([id].astro) is a route template, not a page.
		if (name.startsWith("[")) continue;
		// ...but a static file under a dynamic directory still is one.
		if (prefix.includes("[")) continue;
		out.push(name === "index" ? `/${prefix}` : `/${prefix}${name}/`);
	}
	return out;
}

const sitemapPaths = new Set(SECONDARY_PAGES.map((p) => p.path));

describe("sitemap covers every static page", () => {
	test("no page is silently missing from the sitemap", () => {
		const missing = staticRoutes()
			// "/" is emitted separately from the SECONDARY_PAGES list.
			.filter((r) => r !== "/")
			.filter((r) => !sitemapPaths.has(r) && !SITEMAP_EXCLUDED.has(r));

		expect(missing).toEqual([]);
	});

	// The other direction: an excluded route must actually be absent. Without
	// this, adding /cambios/reforma/ to the sitemap while leaving it on the
	// exclusion list passes both checks and offers Google a noindex shell.
	test("excluded routes are not in the sitemap", () => {
		const contradictory = [...SITEMAP_EXCLUDED.keys()].filter((r) =>
			sitemapPaths.has(r),
		);
		expect(contradictory).toEqual([]);
	});

	// Keeps the exclusion list honest: a route deleted from src/pages should be
	// dropped from here too, or the list slowly becomes fiction.
	test("every exclusion refers to a page that still exists", () => {
		const routes = new Set(staticRoutes());
		const stale = [...SITEMAP_EXCLUDED.keys()].filter((r) => !routes.has(r));
		expect(stale).toEqual([]);
	});

	// A sitemap entry pointing at a page that no longer exists is a 404 handed
	// to Google on purpose.
	test("every sitemap entry refers to a page that exists", () => {
		const routes = new Set(staticRoutes());
		const dangling = [...sitemapPaths].filter((r) => !routes.has(r));
		expect(dangling).toEqual([]);
	});

	// A bare "excluded" with no reason is how a list like this rots: nobody
	// dares remove an entry they can't justify.
	test("every exclusion states a reason", () => {
		for (const [route, reason] of SITEMAP_EXCLUDED) {
			expect(reason.trim().length, `${route} needs a reason`).toBeGreaterThan(
				5,
			);
		}
	});
});
