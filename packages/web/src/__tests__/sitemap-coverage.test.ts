// Guards against the failure that hid /datos/ and /pregunta/ from Google for
// months: a page exists under src/pages/ but nobody remembers to add it to the
// sitemap, and there is no error anywhere — the page is simply never offered
// to a crawler. A URL Inspection sweep on 2026-07-28 found both at "Google no
// reconoce esta URL".
//
// So: every static page must be either listed in the sitemap or explicitly
// excluded here with a reason. Adding a page and forgetting both fails this.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PAGES_DIR = new URL("../pages", import.meta.url).pathname;
const SITEMAP_SRC = join(PAGES_DIR, "sitemap-leyes.xml.ts");

/** Routes that must NOT be in the sitemap, and why. */
const INTENTIONALLY_EXCLUDED = new Map([
	["/404/", "error page"],
	[
		"/cambios/para-mi/",
		"personalised client-side; empty without the visitor's filters",
	],
	[
		"/cambios/reforma/",
		"bare shell carries noindex; real URLs in sitemap-reformas.xml",
	],
	["/alertas/gestionar/", "transactional, reached with a one-time token"],
	["/alertas/confirmar/", "transactional, reached with a one-time token"],
	["/alertas/cancelar/", "transactional, reached with a one-time token"],
	[
		"/alertas/seguir/confirmar/",
		"transactional, reached with a one-time token",
	],
]);

/** Static .astro routes under src/pages, as site paths. Skips dynamic ones. */
function staticRoutes(dir = PAGES_DIR, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			// [id] / [fecha] segments are dynamic — they get their own sitemaps.
			if (!entry.startsWith("["))
				out.push(...staticRoutes(full, `${prefix}${entry}/`));
			continue;
		}
		if (!entry.endsWith(".astro") || entry.startsWith("[")) continue;
		const name = entry.replace(/\.astro$/, "");
		out.push(name === "index" ? `/${prefix}` : `/${prefix}${name}/`);
	}
	return out;
}

describe("sitemap covers every static page", () => {
	test("no page is silently missing from the sitemap", () => {
		const sitemap = readFileSync(SITEMAP_SRC, "utf8");
		const missing = staticRoutes()
			.filter((r) => !INTENTIONALLY_EXCLUDED.has(r))
			// "/" is emitted separately from the secondaryPages list.
			.filter((r) => r !== "/")
			.filter((r) => !sitemap.includes(`"${r}"`));

		expect(missing).toEqual([]);
	});

	// Keeps the exclusion list honest: a route deleted from src/pages should be
	// dropped from here too, or the list slowly becomes fiction.
	test("every exclusion refers to a page that still exists", () => {
		const routes = new Set(staticRoutes());
		const stale = [...INTENTIONALLY_EXCLUDED.keys()].filter(
			(r) => !routes.has(r),
		);
		expect(stale).toEqual([]);
	});
});
