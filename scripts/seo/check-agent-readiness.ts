#!/usr/bin/env bun
/**
 * Agent-readiness regression check for leyabierta.es.
 *
 * The site is already well set up for AI agents (open robots.txt with explicit
 * AI-bot rules + Content-Signals, llms.txt / llms-full.txt, Markdown content
 * negotiation on law pages). The risk is not that this is undone — it's that it
 * silently breaks: Cloudflare's "Managed robots.txt" can auto-inject AI blocks,
 * a build can drop llms.txt, content negotiation can regress. Nothing else
 * catches that today.
 *
 * This asserts the agent-facing surface still works and exits non-zero if any
 * CRITICAL check regresses. It reads over HTTP, so run it against production.
 * The seo-loop calls it (non-fatal) so a regression shows up in the weekly review.
 *
 *   bun run scripts/seo/check-agent-readiness.ts
 *   SEO_SITE_ORIGIN=https://staging... bun run scripts/seo/check-agent-readiness.ts
 */

import { SITE_ORIGIN } from "./lib.ts";

/** A stable, always-present norm (Constitución Española) for page-level checks. */
const SAMPLE_LAW = "BOE-A-1978-31229";
const TIMEOUT_MS = 20_000;

interface Check {
	name: string;
	ok: boolean;
	detail: string;
	critical: boolean;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

const checks: Check[] = [];
function record(
	name: string,
	ok: boolean,
	detail: string,
	critical = true,
): void {
	checks.push({ name, ok, detail, critical });
}

/** One robots.txt group: the user-agents it names + its path rules, in order. */
interface RobotsGroup {
	agents: string[];
	rules: { dir: "allow" | "disallow"; path: string }[];
}

/**
 * Parse robots.txt into groups. Consecutive `User-agent:` lines share the
 * rules that follow (per the robots.txt spec). Inline `#` comments are stripped.
 * We parse groups instead of a substring match because the regression we care
 * about — Cloudflare's Managed robots.txt — keeps naming the AI bots but adds
 * `Disallow: /` to their group, so `body.includes("ClaudeBot")` stays true
 * while the bot is in fact blocked.
 */
function parseRobots(body: string): RobotsGroup[] {
	const groups: RobotsGroup[] = [];
	let current: RobotsGroup | null = null;
	let lastWasAgent = false;
	for (const raw of body.split("\n")) {
		const line = raw.replace(/#.*$/, "").trim();
		if (!line) continue;
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const field = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		if (field === "user-agent") {
			// A UA line right after another UA line extends the same group.
			if (!current || !lastWasAgent) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
			lastWasAgent = true;
		} else if (field === "allow" || field === "disallow") {
			if (current) current.rules.push({ dir: field, path: value });
			lastWasAgent = false;
		} else {
			// Other directives (Content-Signal, Sitemap, …) don't break the group
			// but do end the run of user-agent lines.
			lastWasAgent = false;
		}
	}
	return groups;
}

/** The group governing `bot`: its own named group if present, else the `*` group. */
function groupFor(groups: RobotsGroup[], bot: string): RobotsGroup | null {
	const name = bot.toLowerCase();
	return (
		groups.find((g) => g.agents.includes(name)) ??
		groups.find((g) => g.agents.includes("*")) ??
		null
	);
}

/** A bot is blocked if its group disallows `/` and no later rule re-allows `/`. */
function isBlocked(group: RobotsGroup): boolean {
	const rootRule = [...group.rules]
		.reverse()
		.find((r) => r.path === "/" || r.path === "");
	// The most specific root-level rule wins; a bare `Disallow:` (empty path)
	// means "allow all", so only `Disallow: /` counts as a block.
	return !!rootRule && rootRule.dir === "disallow" && rootRule.path === "/";
}

/** Markers of a Cloudflare interstitial served with a 200 status. */
function looksChallenged(res: Response, body: string): boolean {
	if (res.headers.get("cf-mitigated")) return true;
	return /Just a moment|challenge-platform|__cf_chl|cf-browser-verification/i.test(
		body,
	);
}

async function run(): Promise<void> {
	// 1. robots.txt still opens the door to AI crawlers, with the ai-input signal.
	try {
		const res = await fetchWithTimeout(`${SITE_ORIGIN}/robots.txt`);
		const body = await res.text();
		const groups = parseRobots(body);
		const bots = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"];
		// A bot regresses if its effective group blocks `/` (Cloudflare Managed
		// robots.txt names the bot AND adds Disallow: / — a substring match misses this).
		const blocked = bots.filter((b) => {
			const g = groupFor(groups, b);
			return !g || isBlocked(g);
		});
		// Require a real Content-Signal directive line that actually says
		// ai-input=yes (not merely the word "Content-Signal", which CF's AI Audit
		// block keeps while flipping the value to no).
		const hasSignal = body
			.split("\n")
			.some(
				(l) =>
					/^\s*Content-Signal\s*:/i.test(l) && /ai-input\s*=\s*yes/i.test(l),
			);
		const ok = res.status === 200 && blocked.length === 0 && hasSignal;
		record(
			"robots.txt · AI bots + Content-Signals",
			ok,
			res.status !== 200
				? `HTTP ${res.status}`
				: blocked.length
					? `AI bots blocked (Disallow: /): ${blocked.join(", ")} — Cloudflare Managed robots.txt?`
					: !hasSignal
						? "no Content-Signal line with ai-input=yes"
						: "all AI bots allowed, ai-input=yes present",
		);
	} catch (e) {
		record("robots.txt · AI bots + Content-Signals", false, `error: ${e}`);
	}

	// 2. llms.txt is served, is markdown, and advertises the RAG /v1/ask endpoint.
	try {
		const res = await fetchWithTimeout(`${SITE_ORIGIN}/llms.txt`);
		const ct = res.headers.get("content-type") ?? "";
		const body = await res.text();
		const isMd = ct.includes("markdown");
		const hasAsk = body.includes("/v1/ask");
		record(
			"llms.txt · served, markdown, advertises /v1/ask",
			res.status === 200 && isMd && body.length > 200 && hasAsk,
			res.status !== 200
				? `HTTP ${res.status}`
				: !isMd
					? `content-type ${ct}`
					: !hasAsk
						? "does not mention /v1/ask (our RAG differentiator)"
						: `${body.length}b markdown`,
		);
	} catch (e) {
		record(
			"llms.txt · served, markdown, advertises /v1/ask",
			false,
			`error: ${e}`,
		);
	}

	// 3. llms-full.txt is served.
	try {
		const res = await fetchWithTimeout(`${SITE_ORIGIN}/llms-full.txt`);
		record(
			"llms-full.txt · served",
			res.status === 200,
			`HTTP ${res.status}`,
			false,
		);
	} catch (e) {
		record("llms-full.txt · served", false, `error: ${e}`, false);
	}

	// 4. Markdown content negotiation on a law page — clean text for citation.
	try {
		const res = await fetchWithTimeout(`${SITE_ORIGIN}/leyes/${SAMPLE_LAW}/`, {
			headers: { Accept: "text/markdown" },
		});
		const ct = res.headers.get("content-type") ?? "";
		const body = await res.text();
		// Guard against an HTML body mislabelled as markdown: the point of the
		// negotiation is that agents get text, not a page to scrape.
		const looksHtml = /^\s*<(!doctype|html)/i.test(body);
		const ok = res.status === 200 && ct.includes("markdown") && !looksHtml;
		record(
			"Markdown negotiation · Accept: text/markdown on a law",
			ok,
			looksHtml
				? `HTTP ${res.status} · ${ct} but body is HTML`
				: `HTTP ${res.status} · ${ct}`,
		);
	} catch (e) {
		record(
			"Markdown negotiation · Accept: text/markdown on a law",
			false,
			`error: ${e}`,
		);
	}

	// 5. An AI-bot user agent is not challenged/blocked at the edge. Cloudflare
	// can soft-challenge with a 200 that carries a JS interstitial, so we inspect
	// the body/headers too — a bare status check would miss it.
	try {
		const res = await fetchWithTimeout(`${SITE_ORIGIN}/leyes/${SAMPLE_LAW}/`, {
			headers: { "User-Agent": "ClaudeBot/1.0 (+https://leyabierta.es)" },
		});
		const body = await res.text();
		const challenged = looksChallenged(res, body);
		record(
			"Edge · AI-bot UA not challenged",
			res.status === 200 && !challenged,
			res.status !== 200
				? `ClaudeBot UA → HTTP ${res.status} (Cloudflare bot challenge?)`
				: challenged
					? "ClaudeBot UA → 200 but body is a Cloudflare challenge"
					: "ClaudeBot UA → 200",
		);
	} catch (e) {
		record("Edge · AI-bot UA not challenged", false, `error: ${e}`);
	}

	// 6. sitemap is served (discovery).
	try {
		const res = await fetchWithTimeout(`${SITE_ORIGIN}/sitemap.xml`);
		record(
			"sitemap.xml · served",
			res.status === 200,
			`HTTP ${res.status}`,
			false,
		);
	} catch (e) {
		record("sitemap.xml · served", false, `error: ${e}`, false);
	}
}

await run();

// ── Report (Markdown so the loop can drop it straight into the weekly review) ──
const failedCritical = checks.filter((c) => !c.ok && c.critical);
const failedWarn = checks.filter((c) => !c.ok && !c.critical);

console.log(`# Agent-readiness — ${SITE_ORIGIN}\n`);
for (const c of checks) {
	const mark = c.ok ? "✅" : c.critical ? "❌" : "⚠️";
	console.log(`- ${mark} ${c.name} — ${c.detail}`);
}
console.log(
	`\n${failedCritical.length === 0 ? "**PASS**" : "**FAIL**"}: ` +
		`${checks.filter((c) => c.ok).length}/${checks.length} ok` +
		(failedCritical.length
			? `, ${failedCritical.length} critical regression(s)`
			: "") +
		(failedWarn.length ? `, ${failedWarn.length} warning(s)` : ""),
);

process.exit(failedCritical.length === 0 ? 0 : 1);
