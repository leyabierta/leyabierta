#!/usr/bin/env bun
// Smoke test: verifies that every critical citizen-facing route exists in the
// Astro build output. Catches the class of regression where a page is renamed,
// deleted, or moved without a redirect (the /sobre/ 404 incident, 2026-04).
//
// Usage:  bun run scripts/smoke-pages.ts
// Assumes the build has already produced packages/web/dist/.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const DIST = resolve(import.meta.dir, "..", "packages", "web", "dist");

// Routes that must exist after every build. When intentionally removing one,
// delete it here in the same PR — that's the explicit signal.
// A representative law is included so a broken /leyes/[id] template fails CI.
const ROUTES: string[] = [
	"/",
	"/cambios/",
	"/cambios/recientes/",
	"/cambios/para-mi/",
	"/datos/",
	"/pregunta/",
	"/mi-situacion/",
	"/alertas/",
	"/alertas/gestionar/",
	"/alertas/confirmar/",
	"/alertas/cancelar/",
	"/sobre/",
	"/sobre/contribuir/",
	"/sobre/api/",
	"/sobre/apoyar/",
	"/aviso-legal/",
	"/privacidad/",
	"/cookies/",
	"/leyes/BOE-A-1978-31229/", // Constitución — stable, always present
];

const STATIC_FILES: string[] = ["/404.html", "/sitemap.xml", "/feed.xml"];

if (!existsSync(DIST)) {
	console.error(`✗ dist not found at ${DIST}`);
	console.error(
		"  Run the web build first: cd packages/web && bunx astro build",
	);
	process.exit(1);
}

const missing: string[] = [];
const empty: string[] = [];

for (const route of ROUTES) {
	const path = join(DIST, route, "index.html");
	if (!existsSync(path)) {
		missing.push(`${route} → ${path}`);
		continue;
	}
	if (statSync(path).size === 0) {
		empty.push(route);
	}
}

for (const file of STATIC_FILES) {
	const path = join(DIST, file);
	if (!existsSync(path)) {
		missing.push(`${file} → ${path}`);
	}
}

if (missing.length > 0 || empty.length > 0) {
	if (missing.length > 0) {
		console.error(`✗ ${missing.length} route(s) missing from build:`);
		for (const m of missing) console.error(`  - ${m}`);
	}
	if (empty.length > 0) {
		console.error(`✗ ${empty.length} route(s) built as empty files:`);
		for (const e of empty) console.error(`  - ${e}`);
	}
	process.exit(1);
}

console.log(
	`✓ smoke ok — ${ROUTES.length} routes + ${STATIC_FILES.length} static files`,
);
