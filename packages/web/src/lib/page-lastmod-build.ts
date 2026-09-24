/**
 * Build-time side of page-lastmod.ts: reads the previous /lastmod.json that
 * build-with-progress.sh downloaded from production (LASTMOD_PREV_PATH) and
 * the build manifests, and computes this build's state once (cached for the
 * whole build, like manifest.ts).
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

function readPrevState(): LastmodState | null {
	const path = process.env.LASTMOD_PREV_PATH;
	if (!path) return null;
	try {
		const state = parseLastmodState(JSON.parse(readFileSync(path, "utf-8")));
		if (!state) {
			console.warn(
				"[lastmod] Previous lastmod.json is incomplete or invalid — bootstrapping",
			);
		}
		return state;
	} catch (err) {
		console.warn(
			`[lastmod] Could not read ${path}: ${err instanceof Error ? err.message : "unknown error"} — bootstrapping`,
		);
		return null;
	}
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
	_state = buildLastmodState({ prev, content, today: todayIso() });
	const mode = !content
		? "content unavailable (carried previous state)"
		: prev
			? "incremental"
			: "bootstrap";
	console.log(
		`[lastmod] ${mode}: ${Object.keys(_state.laws).length} laws, ${Object.keys(_state.reforms).length} reforms`,
	);
	return _state;
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
