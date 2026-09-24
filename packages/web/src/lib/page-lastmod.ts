/**
 * When did a page's OWN content last change?
 *
 * `<lastmod>` used to be the law's last legal reform date only. That date does
 * not move when our own content changes (citizen summary, "Qué ha cambiado"
 * headlines, article summaries), so Google — which re-crawls a ficha every ~46
 * days — had no signal that 12k pages changed on 2026-09-23. And there is no
 * per-summary timestamp in the DB or the build manifests to read it from.
 *
 * So each build hashes the own content it renders, per law and per reform, and
 * publishes the result as /lastmod.json: `{ key: [hash, date] }`. The next
 * build downloads the published file and carries each date forward while the
 * hash is unchanged; when the hash changes, the date becomes the build date.
 * That keeps `<lastmod>` honest: it only moves when the page really changed,
 * never on every deploy (which would teach Google to ignore our lastmod).
 *
 * Without a usable previous file (first build, download error), no date is
 * invented: every entry gets LASTMOD_BOOTSTRAP_DATE, the day the own content
 * of every ficha really did change.
 *
 * Pure functions only (no fs, no env): the build-time loader is
 * page-lastmod-build.ts, and scripts/seo/indexnow.ts reuses changedKeys().
 */

import { createHash } from "node:crypto";

/** 2026-09-23: backfill of own content (#181/#183 + the article/reform imports). */
export const LASTMOD_BOOTSTRAP_DATE = "2026-09-23";

export const LASTMOD_STATE_VERSION = 1;

/** `[contentHash, isoDate]` */
export type LastmodEntry = [string, string];

export interface LastmodState {
	version: number;
	/**
	 * False when the build could not see its own content (a manifest was
	 * missing) and had no previous state to carry: the next build must then
	 * bootstrap instead of treating every entry as new.
	 */
	complete: boolean;
	generated: string;
	/** Law id → entry. Only laws with own content. */
	laws: Record<string, LastmodEntry>;
	/** `<lawId>|<reformDate>` → entry. Only reforms with a headline/summary. */
	reforms: Record<string, LastmodEntry>;
}

/** The slices of the build manifests this module hashes. */
export interface LastmodManifestInput {
	citizens: Record<string, { summary: string; tags: string[] }>;
	reforms: Record<
		string,
		{ date: string; source: string; headline: string; summary: string }[]
	>;
	/** `[heading, summary, blockId?]` per article, see manifest.ts. */
	articles: Record<string, [string, string, string?][]>;
}

/** Whitespace- and Unicode-normalised text, so reformatting is not a change. */
export function normalizeText(s: string | undefined | null): string {
	return (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Order-independent hash of a list of content parts. Parts are normalised and
 * sorted first: a manifest that lists the same summaries in another order is
 * the same page content for our purposes.
 */
export function contentHash(parts: readonly string[]): string {
	const canonical = parts.map(normalizeText).sort();
	return createHash("sha256")
		.update(JSON.stringify(canonical))
		.digest("hex")
		.slice(0, 16);
}

/** The reform key shared by the state, the sitemap and IndexNow. */
export function reformKey(lawId: string, date: string): string {
	return `${lawId}|${date}`;
}

/**
 * Hash of a law page's own content, or undefined when it has none (such a
 * page is `noindex`, see isIndexableLaw — the same three kinds of content).
 * Citizen tags only count alongside something else, as on the page.
 */
export function lawContentHash(
	id: string,
	m: LastmodManifestInput,
): string | undefined {
	const citizen = m.citizens[id];
	const summary = normalizeText(citizen?.summary);
	const reforms = (m.reforms[id] ?? []).filter(
		(r) => normalizeText(r.headline) || normalizeText(r.summary),
	);
	const articles = (m.articles[id] ?? []).filter(([, s]) => normalizeText(s));
	if (!summary && reforms.length === 0 && articles.length === 0) {
		return undefined;
	}
	const parts: string[] = [];
	if (summary) parts.push(`s\u0000${summary}`);
	for (const t of citizen?.tags ?? []) parts.push(`t\u0000${normalizeText(t)}`);
	for (const r of reforms) {
		parts.push(
			`r\u0000${r.date}\u0000${r.source}\u0000${normalizeText(r.headline)}\u0000${normalizeText(r.summary)}`,
		);
	}
	for (const [heading, s, blockId] of articles) {
		parts.push(
			`a\u0000${blockId ?? ""}\u0000${normalizeText(heading)}\u0000${normalizeText(s)}`,
		);
	}
	return contentHash(parts);
}

/** Hash per reform page (`<lawId>|<date>`); reforms without text are absent. */
export function reformContentHashes(
	m: LastmodManifestInput,
): Record<string, string> {
	const byKey = new Map<string, string[]>();
	for (const [lawId, list] of Object.entries(m.reforms)) {
		for (const r of list) {
			const headline = normalizeText(r.headline);
			const summary = normalizeText(r.summary);
			if (!headline && !summary) continue;
			const key = reformKey(lawId, r.date);
			const parts = byKey.get(key) ?? [];
			parts.push(`${r.source}\u0000${headline}\u0000${summary}`);
			byKey.set(key, parts);
		}
	}
	const out: Record<string, string> = {};
	for (const [key, parts] of byKey) out[key] = contentHash(parts);
	return out;
}

/** Hash per law page with own content. */
export function lawContentHashes(
	m: LastmodManifestInput,
): Record<string, string> {
	const ids = new Set([
		...Object.keys(m.citizens),
		...Object.keys(m.reforms),
		...Object.keys(m.articles),
	]);
	const out: Record<string, string> = {};
	for (const id of ids) {
		const h = lawContentHash(id, m);
		if (h) out[id] = h;
	}
	return out;
}

/**
 * Carry dates forward. `prev` undefined = no usable previous state: every
 * entry gets `bootstrap`. Otherwise an unchanged hash keeps its date and a new
 * or changed one gets `today`. Keys absent from `current` are dropped.
 */
export function advanceEntries(
	prev: Record<string, LastmodEntry> | undefined,
	current: Record<string, string>,
	today: string,
	bootstrap: string = LASTMOD_BOOTSTRAP_DATE,
): Record<string, LastmodEntry> {
	const out: Record<string, LastmodEntry> = {};
	for (const key of Object.keys(current).sort()) {
		const hash = current[key]!;
		if (!prev) {
			out[key] = [hash, bootstrap];
			continue;
		}
		const before = prev[key];
		out[key] = before && before[0] === hash ? [hash, before[1]] : [hash, today];
	}
	return out;
}

/** The state this build publishes, from the previous state and its content. */
export function buildLastmodState(opts: {
	prev: LastmodState | null;
	content: LastmodManifestInput | null;
	today: string;
	bootstrap?: string;
}): LastmodState {
	const { prev, content, today } = opts;
	if (!content) {
		// We cannot see our own content (a manifest failed to load). Never
		// derive dates from that: carry the previous state as-is, or mark the
		// output incomplete so the next build bootstraps instead of treating
		// every page as new.
		return prev
			? { ...prev, generated: today }
			: {
					version: LASTMOD_STATE_VERSION,
					complete: false,
					generated: today,
					laws: {},
					reforms: {},
				};
	}
	return {
		version: LASTMOD_STATE_VERSION,
		complete: true,
		generated: today,
		laws: advanceEntries(
			prev?.laws,
			lawContentHashes(content),
			today,
			opts.bootstrap,
		),
		reforms: advanceEntries(
			prev?.reforms,
			reformContentHashes(content),
			today,
			opts.bootstrap,
		),
	};
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isEntryMap(v: unknown): v is Record<string, LastmodEntry> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	for (const e of Object.values(v)) {
		if (
			!Array.isArray(e) ||
			e.length !== 2 ||
			typeof e[0] !== "string" ||
			typeof e[1] !== "string" ||
			!ISO_DATE.test(e[1])
		) {
			return false;
		}
	}
	return true;
}

/**
 * A previous state we can build on, or null. Incomplete, malformed or
 * other-version states are all "no previous state" (→ bootstrap dates).
 */
export function parseLastmodState(raw: unknown): LastmodState | null {
	if (!raw || typeof raw !== "object") return null;
	const s = raw as Partial<LastmodState>;
	if (s.version !== LASTMOD_STATE_VERSION || s.complete !== true) return null;
	if (typeof s.generated !== "string") return null;
	if (!isEntryMap(s.laws) || !isEntryMap(s.reforms)) return null;
	return s as LastmodState;
}

/**
 * Keys whose content is new or changed between two published states — what
 * IndexNow should be told about. Empty without a usable `prev`: a bootstrap
 * is not a change we can attribute to one build.
 */
export function changedKeys(
	prev: LastmodState | null,
	next: LastmodState | null,
): { laws: string[]; reforms: string[] } {
	if (!prev || !next?.complete) return { laws: [], reforms: [] };
	const diff = (
		a: Record<string, LastmodEntry>,
		b: Record<string, LastmodEntry>,
	) =>
		Object.keys(b)
			.filter((k) => a[k]?.[0] !== b[k]![0])
			.sort();
	return {
		laws: diff(prev.laws, next.laws),
		reforms: diff(prev.reforms, next.reforms),
	};
}
