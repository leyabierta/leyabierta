/**
 * The site's static pages and their sitemap status, as data.
 *
 * This lives apart from `sitemap-leyes.xml.ts` because that file imports
 * `astro:content`, which only resolves during a build — so a test can't import
 * it and has to fall back to reading the source as text. Text matching is not
 * good enough here: a route mentioned in a comment would satisfy it while the
 * sitemap goes out without the entry, which is exactly the failure this is
 * meant to catch.
 *
 * Both the sitemap route and the coverage test import these arrays, so the test
 * checks the same values the sitemap actually emits.
 */

export interface SitemapEntry {
	path: string;
	changefreq: string;
	priority: string;
}

/**
 * Every indexable page that isn't a law or a reform. Keep in sync with
 * src/pages/ — a page missing here is a page Google may never discover. On
 * 2026-07-28 a URL Inspection sweep found /datos/ and /pregunta/ at "Google no
 * reconoce esta URL": not rejected, simply never offered.
 */
export const SECONDARY_PAGES: SitemapEntry[] = [
	{ path: "/cambios/", changefreq: "daily", priority: "0.6" },
	{ path: "/cambios/recientes/", changefreq: "daily", priority: "0.7" },
	// Topic hubs: new indexable pages that link into the corpus and target
	// rising queries (fiscalidad/IVA, empleo). Register here or they repeat the
	// /datos/ + /pregunta/ invisibility this list exists to prevent.
	{ path: "/temas/fiscalidad/", changefreq: "weekly", priority: "0.7" },
	{ path: "/temas/empleo/", changefreq: "weekly", priority: "0.7" },
	// The clearest thing this site does that boe.es does not: answer a question
	// in plain language. It was invisible to Google until 2026-07-28.
	{ path: "/pregunta/", changefreq: "weekly", priority: "0.8" },
	{ path: "/datos/", changefreq: "weekly", priority: "0.6" },
	{ path: "/sobre/", changefreq: "monthly", priority: "0.5" },
	{ path: "/sobre/contribuir/", changefreq: "monthly", priority: "0.4" },
	{ path: "/sobre/apoyar/", changefreq: "monthly", priority: "0.4" },
	{ path: "/sobre/api/", changefreq: "monthly", priority: "0.4" },
	{ path: "/alertas/", changefreq: "monthly", priority: "0.5" },
	{ path: "/mi-situacion/", changefreq: "monthly", priority: "0.5" },
	{ path: "/privacidad/", changefreq: "yearly", priority: "0.2" },
	{ path: "/cookies/", changefreq: "yearly", priority: "0.2" },
	{ path: "/aviso-legal/", changefreq: "yearly", priority: "0.2" },
];

/**
 * Static routes that must NOT appear in the sitemap, with the reason. The
 * coverage test enforces this in both directions: these can't be missing from
 * here, and they can't show up in SECONDARY_PAGES either.
 */
export const SITEMAP_EXCLUDED = new Map<string, string>([
	["/404/", "error page; carries noindex and has nothing to rank for"],
	[
		"/cambios/para-mi/",
		"personalised client-side; renders empty without the visitor's own filters",
	],
	[
		"/cambios/reforma/",
		"bare shell carries noindex; real reform URLs live in sitemap-reformas.xml",
	],
	["/alertas/gestionar/", "transactional, reached with a one-time token"],
	["/alertas/confirmar/", "transactional, reached with a one-time token"],
	["/alertas/cancelar/", "transactional, reached with a one-time token"],
	[
		"/alertas/seguir/confirmar/",
		"transactional, reached with a one-time token",
	],
]);
