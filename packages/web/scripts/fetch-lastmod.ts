/**
 * Download the published /lastmod.json for build-with-progress.sh and decide
 * how the build may use it (src/lib/page-lastmod.ts, classifyPrevResponse):
 *
 * - valid state   → writes <out>, prints "prev", exit 0
 * - 404 / empty   → prints "bootstrap", exit 0 (nothing to lose)
 * - anything else → retries with backoff, then exit 1: the build must fail
 *                   rather than publish a reset state over the existing one.
 *                   LASTMOD_ALLOW_BOOTSTRAP=1 turns that into "bootstrap".
 *
 * A cache-busting query (`?v=<run id>`) skips the edge cache, so the build
 * always reads the state the previous deploy actually published.
 *
 * Usage: bun scripts/fetch-lastmod.ts <out-file> [base-url]
 */

import { writeFileSync } from "node:fs";
import {
	classifyPrevResponse,
	type PrevStateDecision,
} from "../src/lib/page-lastmod.ts";

export interface FetchLastmodDeps {
	fetch: (url: string) => Promise<{ status: number; body: string }>;
	sleep: (ms: number) => Promise<void>;
}

export const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

/** Fetch with retries; returns the final decision ("retry" = give up, fail). */
export async function fetchPrevState(
	url: string,
	deps: FetchLastmodDeps,
	allowBootstrap: boolean,
	log: (msg: string) => void = () => {},
): Promise<PrevStateDecision> {
	let decision: PrevStateDecision = { kind: "retry", reason: "not attempted" };
	for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
		let status = 0;
		let body = "";
		try {
			({ status, body } = await deps.fetch(url));
		} catch {
			status = 0;
		}
		// Overrides only apply once retries are exhausted.
		const last = attempt === RETRY_DELAYS_MS.length;
		decision = classifyPrevResponse(status, body, last && allowBootstrap);
		if (decision.kind !== "retry") return decision;
		if (!last) {
			log(`attempt ${attempt + 1} failed (${decision.reason}), retrying`);
			await deps.sleep(RETRY_DELAYS_MS[attempt]!);
		}
	}
	return decision;
}

if (import.meta.main) {
	const [out, base = "https://leyabierta.es"] = process.argv.slice(2);
	if (!out) {
		console.error("usage: fetch-lastmod.ts <out-file> [base-url]");
		process.exit(2);
	}
	const bust = process.env.GITHUB_RUN_ID ?? String(Date.now());
	const url = `${base}/lastmod.json?v=${encodeURIComponent(bust)}`;
	const decision = await fetchPrevState(
		url,
		{
			fetch: async (u) => {
				const res = await fetch(u, {
					headers: { "Cache-Control": "no-cache" },
					signal: AbortSignal.timeout(60_000),
				});
				return { status: res.status, body: await res.text() };
			},
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		},
		process.env.LASTMOD_ALLOW_BOOTSTRAP === "1",
		(m) => console.error(`[lastmod] ${m}`),
	);
	if (decision.kind === "prev") {
		writeFileSync(out, JSON.stringify(decision.state));
		console.error(
			`[lastmod] previous state: ${Object.keys(decision.state.laws).length} laws, ${Object.keys(decision.state.reforms).length} reforms (generated ${decision.state.generated})`,
		);
		console.log("prev");
	} else if (decision.kind === "bootstrap") {
		console.error(`[lastmod] bootstrap: ${decision.reason}`);
		console.log("bootstrap");
	} else {
		console.error(
			`[lastmod] ERROR: cannot read the published lastmod.json (${decision.reason}). Refusing to build: a reset state would overwrite every page date. Retry the deploy, or set LASTMOD_ALLOW_BOOTSTRAP=1 to reset on purpose.`,
		);
		process.exit(1);
	}
}
