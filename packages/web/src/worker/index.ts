/// <reference types="@cloudflare/workers-types" />
// Standalone Cloudflare Worker in front of the pure-static Astro build.
//
// Astro builds `output: "static"` with NO adapter — every page (the ~12k law
// pages included) is a prebuilt file served via the `ASSETS` binding. This
// Worker's only job is to intercept /cambios/reforma/* requests that carry
// `?id&date`, fetch the reform data from the API, render the diff content
// server-side (src/lib/reform-render.ts — pure TS, safe to run in workerd),
// and splice it into the static shell page (src/pages/cambios/reforma/index.astro)
// before returning it. Everything else falls straight through to `ASSETS`.
//
// This exists because the @astrojs/cloudflare adapter's workerd prerenderer
// cannot do `fs` reads at render time, so it could only build 81/12k law
// pages when tried — this decoupled design keeps the static build 100% file
// based (fast, complete) while still giving crawlers real SSR content on the
// one route that needs it for SEO.

import type {
	AffectedBlock,
	OmnibusResponse,
	ReformDetailResponse,
} from "../lib/reform-render.ts";
import {
	esc,
	renderReformContent,
	renderUnifiedDiffHtml,
} from "../lib/reform-render.ts";

export interface Env {
	ASSETS: Fetcher;
	API_BYPASS_KEY?: string;
	PUBLIC_API_URL?: string;
}

const DEFAULT_API_BASE = "https://api.leyabierta.es";
const REFORM_PATH_PREFIX = "/cambios/reforma/";
const SHELL_PATH = "/cambios/reforma/";

/** Finds the index of the `</div>` that matches the opening `<div>` whose
 *  content starts at `contentStart` (depth-aware, so nested divs inside the
 *  shell's loading skeleton don't confuse the boundary). Returns -1 if
 *  unbalanced/not found. */
function findMatchingDivClose(html: string, contentStart: number): number {
	let pos = contentStart;
	let depth = 1;
	while (depth > 0) {
		const nextOpen = html.indexOf("<div", pos);
		const nextClose = html.indexOf("</div>", pos);
		if (nextClose === -1) return -1;
		if (nextOpen !== -1 && nextOpen < nextClose) {
			depth++;
			pos = nextOpen + 4;
		} else {
			depth--;
			if (depth === 0) return nextClose;
			pos = nextClose + 6;
		}
	}
	return -1;
}

/** Replaces the inner HTML of `<div id="reforma-content">…</div>` (the
 *  client-rendered shell's loading skeleton) with server-rendered content. */
function injectContent(shellHtml: string, contentHtml: string): string {
	const marker = '<div id="reforma-content">';
	const startIdx = shellHtml.indexOf(marker);
	if (startIdx === -1) return shellHtml;
	const contentStart = startIdx + marker.length;
	const closeIdx = findMatchingDivClose(shellHtml, contentStart);
	if (closeIdx === -1) return shellHtml;
	return (
		shellHtml.slice(0, contentStart) + contentHtml + shellHtml.slice(closeIdx)
	);
}

/** Rewrites `<title>`, the description meta, adds a self canonical link, and
 *  removes the shell's `noindex` robots meta — turning the generic shell
 *  into a page crawlers can actually index for this specific reform. */
function injectMeta(
	shellHtml: string,
	opts: { title: string; description: string; canonicalPath: string },
): string {
	let html = shellHtml;

	const fullTitle = `${opts.title} — Ley Abierta`;
	html = html.replace(
		/<title>[^<]*<\/title>/,
		`<title>${esc(fullTitle)}</title>`,
	);

	html = html.replace(
		/<meta name="description" content="[^"]*"\s*\/?>/,
		`<meta name="description" content="${esc(opts.description)}" />`,
	);

	// Remove the shell's noindex — this response is real content, index it.
	html = html.replace(
		/<meta name="robots" content="noindex, follow"\s*\/?>\s*/,
		"",
	);

	const canonicalHref = `https://leyabierta.es${opts.canonicalPath}`;
	const canonicalLink = `<link rel="canonical" href="${esc(canonicalHref)}" />`;
	if (html.includes('<link rel="canonical"')) {
		html = html.replace(
			/<link rel="canonical" href="[^"]*"\s*\/?>/,
			canonicalLink,
		);
	} else {
		html = html.replace(
			'<link rel="icon"',
			`${canonicalLink}\n\t<link rel="icon"`,
		);
	}

	return html;
}

async function fetchJson<T>(
	url: string,
	headers: HeadersInit,
): Promise<
	{ ok: true; status: number; data: T } | { ok: false; status: number }
> {
	try {
		const res = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return { ok: false, status: res.status };
		return { ok: true, status: res.status, data: (await res.json()) as T };
	} catch {
		return { ok: false, status: 500 };
	}
}

type RenderFailure = { ok: false; status: number };

async function renderReformResponse(
	env: Env,
	url: URL,
): Promise<Response | RenderFailure> {
	const normId = url.searchParams.get("id");
	const date = url.searchParams.get("date");
	if (!normId || !date) return { ok: false, status: 404 };

	const apiBase = env.PUBLIC_API_URL || DEFAULT_API_BASE;
	const headers: HeadersInit = env.API_BYPASS_KEY
		? { "x-bypass-key": env.API_BYPASS_KEY }
		: {};

	const reformResult = await fetchJson<ReformDetailResponse>(
		`${apiBase}/v1/reforms/${encodeURIComponent(normId)}/${encodeURIComponent(date)}`,
		headers,
	);
	if (!reformResult.ok) {
		// Mirror the upstream status (404/403/429/503…) so crawlers get an
		// honest signal; fall back to 500 for anything outside 4xx/5xx.
		const status =
			reformResult.status >= 400 && reformResult.status < 600
				? reformResult.status
				: 500;
		return { ok: false, status };
	}

	const data = reformResult.data;

	const topicParam = url.searchParams.get("topic");
	const fromOmnibus = url.searchParams.get("from") === "omnibus";
	const topicIndex =
		topicParam !== null ? Number.parseInt(topicParam, 10) : Number.NaN;

	let topicInfo: OmnibusResponse["topics"][number] | null = null;
	let topicBlockIds: string[] | null = null;
	if (fromOmnibus && !Number.isNaN(topicIndex)) {
		const omnibusResult = await fetchJson<OmnibusResponse>(
			`${apiBase}/v1/omnibus/${encodeURIComponent(normId)}`,
			headers,
		);
		if (omnibusResult.ok) {
			topicInfo = omnibusResult.data.topics?.[topicIndex] ?? null;
			if (
				topicInfo &&
				Array.isArray(topicInfo.block_ids) &&
				topicInfo.block_ids.length > 0
			) {
				topicBlockIds = topicInfo.block_ids;
			}
		}
		// Omnibus enrichment is best-effort — the reform itself still renders.
	}

	const allBlocks = data.affected_blocks || [];
	const blocks: AffectedBlock[] = topicBlockIds
		? allBlocks.filter((b) => topicBlockIds?.includes(b.block_id))
		: allBlocks;

	let unifiedDiffHtml: string | null = null;
	if (blocks.length === 0 && data.prev_reform_date && !topicBlockIds) {
		const diffResult = await fetchJson<{ diff?: string }>(
			`${apiBase}/v1/laws/${encodeURIComponent(normId)}/diff?from=${encodeURIComponent(data.prev_reform_date)}&to=${encodeURIComponent(date)}`,
			headers,
		);
		if (diffResult.ok && diffResult.data.diff) {
			unifiedDiffHtml = renderUnifiedDiffHtml(diffResult.data.diff);
		}
	}

	const { contentHtml, title, description } = renderReformContent(data, {
		topicInfo,
		topicBlockIds,
		blocks,
		unifiedDiffHtml,
	});

	const shellRes = await env.ASSETS.fetch(new URL(SHELL_PATH, url).toString());
	if (!shellRes.ok) return { ok: false, status: shellRes.status };
	const shellHtml = await shellRes.text();

	// Canonical intentionally omits `from`/`topic` — those are navigation
	// context, not a distinct piece of content, and would otherwise create
	// duplicate-content variants of the same reform for search engines.
	const canonicalPath = `/cambios/reforma/?id=${encodeURIComponent(normId)}&date=${encodeURIComponent(date)}`;

	let html = injectContent(shellHtml, contentHtml);
	html = injectMeta(html, { title, description, canonicalPath });

	return new Response(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			// A reform is immutable once published — cache aggressively. The
			// deploy pipeline purges the CF zone on every deploy, so a
			// reprocessed reform (rare) still refreshes promptly.
			"cache-control": "public, s-maxage=7776000, stale-while-revalidate=86400",
		},
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith(REFORM_PATH_PREFIX)) {
			const result = await renderReformResponse(env, url);
			if (result instanceof Response) return result;

			// Missing params or API failure (404/upstream error) → serve the
			// static shell as-is (keeps its `noindex`, lets the existing
			// client-side fetch script take over), mirroring the resolved
			// status onto the response.
			const shellRes = await env.ASSETS.fetch(request);
			if (result.status === shellRes.status) return shellRes;
			return new Response(shellRes.body, {
				status: result.status,
				statusText: shellRes.statusText,
				headers: shellRes.headers,
			});
		}

		return env.ASSETS.fetch(request);
	},
};
