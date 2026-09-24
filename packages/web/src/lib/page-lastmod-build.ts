/**
 * Build-time side of page-lastmod.ts: reads the previous /lastmod.json that
 * scripts/fetch-lastmod.ts downloaded from production and the build manifests,
 * and computes this build's state once (cached for the whole build, like
 * manifest.ts).
 *
 * Environment (set by build-with-progress.sh via scripts/fetch-lastmod.ts):
 * - LASTMOD_PREV_PATH          validated previous state → incremental build
 * - LASTMOD_BOOTSTRAP=1        production answered 404 → bootstrap
 * - LASTMOD_ALLOW_BOOTSTRAP=1  operator override: bootstrap whatever happened
 * - LASTMOD_ALLOW_MASS_CHANGE=1 operator override for the mass-change brake
 * With none of the first three, a CI build fails (it would otherwise publish a
 * reset state over the existing one); a local build bootstraps with a warning.
 *
 * Consumers: sitemap-leyes.xml, sitemap-reformas.xml, the sitemap index, the
 * law page's WebPage `dateModified`, and /lastmod.json itself.
 */

import { readFileSync } from "node:fs";
import { todayIso } from "./law-dates.ts";
import { loadArticleSummaries, loadManifest } from "./manifest.ts";
import {
	buildLastmodState,
	type LastmodState,
	parseLastmodState,
	reformKey,
} from "./page-lastmod.ts";

let _state: LastmodState | undefined;

const flag = (name: string) => process.env[name] === "1";

function readPrevState(): LastmodState | null {
	const path = process.env.LASTMOD_PREV_PATH;
	if (path) {
		let state: LastmodState | null = null;
		try {
			state = parseLastmodState(JSON.parse(readFileSync(path, "utf-8")));
		} catch {
			state = null;
		}
		if (state?.complete) return state;
		if (flag("LASTMOD_ALLOW_BOOTSTRAP")) {
			console.warn(`[lastmod] ${path} unusable — bootstrapping (allowed)`);
			return null;
		}
		throw new Error(
			`[lastmod] ${path} is not a usable lastmod state; refusing to publish a reset state (set LASTMOD_ALLOW_BOOTSTRAP=1 to override)`,
		);
	}
	if (flag("LASTMOD_BOOTSTRAP") || flag("LASTMOD_ALLOW_BOOTSTRAP")) return null;
	if (process.env.CI) {
		throw new Error(
			"[lastmod] no previous lastmod state and no bootstrap decision (run through build-with-progress.sh, or set LASTMOD_ALLOW_BOOTSTRAP=1)",
		);
	}
	console.warn(
		"[lastmod] local build without a previous state — bootstrapping",
	);
	return null;
}

/** This build's lastmod state (computed once). */
export function getLastmodState(): LastmodState {
	if (_state) return _state;
	const manifest = loadManifest();
	const articles = loadArticleSummaries();
	// `reforms` is optional in the manifest type (older APIs): treat its
	// absence like a missing manifest, or every law would look changed.
	const content =
		manifest && articles && manifest.reforms
			? { citizens: manifest.citizens, reforms: manifest.reforms, articles }
			: null;
	const prev = readPrevState();
	const { state, warnings } = buildLastmodState({
		prev,
		content,
		today: todayIso(),
		allowMassChange: flag("LASTMOD_ALLOW_MASS_CHANGE"),
	});
	_state = state;
	for (const w of warnings) {
		console.warn(`[lastmod] WARNING: ${w}`);
		// Surfaces as an annotation on the GitHub Actions run.
		if (process.env.GITHUB_ACTIONS) console.log(`::warning::lastmod: ${w}`);
	}
	const mode = !content
		? "content unavailable"
		: prev
			? "incremental"
			: "bootstrap";
	console.log(
		`[lastmod] ${mode}: ${Object.keys(state.laws).length} laws, ${Object.keys(state.reforms).length} reforms`,
	);
	return state;
}

/** Date the law page's own content last changed, if it has any. */
export function lawContentDate(id: string): string | undefined {
	return getLastmodState().laws[id]?.[1];
}

/** Date the reform page's own content (headline/summary) last changed. */
export function reformContentDate(
	lawId: string,
	date: string,
): string | undefined {
	return getLastmodState().reforms[reformKey(lawId, date)]?.[1];
}
