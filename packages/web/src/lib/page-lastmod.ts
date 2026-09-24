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
 * Safety rails, because a reset or a false mass change cannot be undone once
 * published (the next build builds on it):
 * - Bootstrap (every entry = LASTMOD_BOOTSTRAP_DATE, the day the own content
 *   of every ficha really did change) ONLY when production answers 404 or an
 *   operator allows it. Any other download failure fails the build
 *   (classifyPrevResponse, packages/web/scripts/fetch-lastmod.ts).
 * - Mass-change brake: when too many keys change (or disappear) in one build,
 *   nothing is dated today — the new hashes are re-baselined with their
 *   previous dates, unless an operator allows the mass change.
 * - Keys missing from a build are kept (marked absent), so a manifest that
 *   comes back complete the next day does not count as "all new".
 *
 * Pure functions only (no fs, no env): the build-time loader is
 * page-lastmod-build.ts, and scripts/seo/indexnow.ts reuses changedKeys().
 */

import { createHash } from "node:crypto";

/** 2026-09-23: backfill of own content (#181/#183 + the article/reform imports). */
export const LASTMOD_BOOTSTRAP_DATE = "2026-09-23";

export const LASTMOD_STATE_VERSION = 1;

/**
 * Mass-change brake: more than this share of a kind's previously present keys
 * changed (or new) in one build …
 */
export const MASS_CHANGE_RATIO = 0.2;
/** … or more than this share of them disappeared … */
export const MASS_DROP_RATIO = 0.1;
/** … and at least this many keys (tiny states are too noisy to judge). */
export const MASS_CHANGE_MIN_KEYS = 50;

/**
 * `[contentHash, isoDate]`, or `[contentHash, isoDate, 1]` for a key that was
 * absent from the build that published it (kept so it does not count as new
 * when it comes back).
 */
export type LastmodEntry = [string, string] | [string, string, 1];

export interface LastmodState {
	version: number;
	/**
	 * False only when a bootstrap build could not see its own content (a
	 * manifest was missing): the state is empty and the next build may
	 * bootstrap over it.
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

const isAbsent = (e: LastmodEntry | undefined) => e?.[2] === 1;

export interface AdvanceResult {
	entries: Record<string, LastmodEntry>;
	/** Keys dated `today` in this build (what IndexNow may announce). */
	changed: number;
	/** Previously present keys that are missing now. */
	dropped: number;
	/** True when the mass-change brake re-baselined instead of dating. */
	braked: boolean;
}

/**
 * Carry dates forward for one kind of key (laws or reforms).
 *
 * - `prev` undefined (bootstrap): every entry gets `bootstrap`.
 * - Unchanged hash keeps its date; a new or changed one gets `today`…
 * - …unless the change is massive (see MASS_*): then the new hashes keep
 *   their previous date (new keys get `bootstrap`) and nothing is dated
 *   today, unless `allowMassChange`.
 * - Previously known keys missing from `current` are kept, marked absent.
 */
export function advanceEntries(
	prev: Record<string, LastmodEntry> | undefined,
	current: Record<string, string>,
	today: string,
	opts: { bootstrap?: string; allowMassChange?: boolean } = {},
): AdvanceResult {
	const bootstrap = opts.bootstrap ?? LASTMOD_BOOTSTRAP_DATE;
	const entries: Record<string, LastmodEntry> = {};
	if (!prev) {
		for (const key of Object.keys(current).sort()) {
			entries[key] = [current[key]!, bootstrap];
		}
		return { entries, changed: 0, dropped: 0, braked: false };
	}

	const present = Object.keys(prev).filter((k) => !isAbsent(prev[k]));
	const changedKeys = Object.keys(current).filter(
		(k) => prev[k]?.[0] !== current[k],
	);
	const dropped = present.filter((k) => !(k in current)).length;
	const base = present.length;
	const braked =
		!opts.allowMassChange &&
		base >= MASS_CHANGE_MIN_KEYS &&
		(changedKeys.length > base * MASS_CHANGE_RATIO ||
			dropped > base * MASS_DROP_RATIO);

	const keys = new Set([...Object.keys(prev), ...Object.keys(current)]);
	for (const key of [...keys].sort()) {
		const before = prev[key];
		const hash = current[key];
		if (hash === undefined) {
			// Missing from this build: keep it, marked absent.
			entries[key] = [before![0], before![1], 1];
		} else if (before && before[0] === hash) {
			entries[key] = [hash, before[1]];
		} else if (braked) {
			entries[key] = [hash, before?.[1] ?? bootstrap];
		} else {
			entries[key] = [hash, today];
		}
	}
	return {
		entries,
		changed: braked ? 0 : changedKeys.length,
		dropped,
		braked,
	};
}

export interface LastmodBuildResult {
	state: LastmodState;
	/** Human-readable warnings for the build log (mass-change brake). */
	warnings: string[];
}

/** The state this build publishes, from the previous state and its content. */
export function buildLastmodState(opts: {
	prev: LastmodState | null;
	content: LastmodManifestInput | null;
	today: string;
	bootstrap?: string;
	allowMassChange?: boolean;
}): LastmodBuildResult {
	const { prev, content, today } = opts;
	if (!content) {
		// We cannot see our own content (a manifest failed to load). Never
		// derive dates from that: carry the previous state as-is, or publish an
		// empty incomplete state that a later build may bootstrap over.
		return {
			state: prev
				? { ...prev, generated: today }
				: {
						version: LASTMOD_STATE_VERSION,
						complete: false,
						generated: today,
						laws: {},
						reforms: {},
					},
			warnings: ["own content unavailable (manifest missing): state carried"],
		};
	}
	const advOpts = {
		bootstrap: opts.bootstrap,
		allowMassChange: opts.allowMassChange,
	};
	const laws = advanceEntries(
		prev?.laws,
		lawContentHashes(content),
		today,
		advOpts,
	);
	const reforms = advanceEntries(
		prev?.reforms,
		reformContentHashes(content),
		today,
		advOpts,
	);
	const warnings: string[] = [];
	for (const [kind, r] of [
		["laws", laws],
		["reforms", reforms],
	] as const) {
		if (r.braked) {
			warnings.push(
				`mass change in ${kind} (${r.dropped} dropped, more than ${MASS_CHANGE_RATIO * 100}% changed or ${MASS_DROP_RATIO * 100}% dropped): re-baselined without dating today. Set LASTMOD_ALLOW_MASS_CHANGE=1 if the change is real.`,
			);
		}
	}
	return {
		state: {
			version: LASTMOD_STATE_VERSION,
			complete: true,
			generated: today,
			laws: laws.entries,
			reforms: reforms.entries,
		},
		warnings,
	};
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isEntryMap(v: unknown): v is Record<string, LastmodEntry> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	for (const e of Object.values(v)) {
		if (
			!Array.isArray(e) ||
			(e.length !== 2 && !(e.length === 3 && e[2] === 1)) ||
			typeof e[0] !== "string" ||
			typeof e[1] !== "string" ||
			!ISO_DATE.test(e[1])
		) {
			return false;
		}
	}
	return true;
}

/** A well-formed state (complete or not), or null. */
export function parseLastmodState(raw: unknown): LastmodState | null {
	if (!raw || typeof raw !== "object") return null;
	const s = raw as Partial<LastmodState>;
	if (s.version !== LASTMOD_STATE_VERSION) return null;
	if (typeof s.complete !== "boolean" || typeof s.generated !== "string") {
		return null;
	}
	if (!isEntryMap(s.laws) || !isEntryMap(s.reforms)) return null;
	return s as LastmodState;
}

/** An incomplete state carries no dates, so bootstrapping over it loses none. */
export function isEmptyIncompleteState(s: LastmodState): boolean {
	return (
		!s.complete &&
		Object.keys(s.laws).length === 0 &&
		Object.keys(s.reforms).length === 0
	);
}

export type PrevStateDecision =
	| { kind: "prev"; state: LastmodState }
	| { kind: "bootstrap"; reason: string }
	| { kind: "retry"; reason: string };

/**
 * What to do with the answer for the published /lastmod.json.
 *
 * Bootstrap only on a 404 (nothing was ever published), on an empty
 * incomplete state, or when the operator allows it. Everything else — 5xx,
 * network error (status 0), an HTML challenge page, invalid JSON, a state of
 * another shape — is "retry", and the caller fails the build when retries run
 * out: publishing a reset state over an existing one would wipe every date.
 */
export function classifyPrevResponse(
	status: number,
	body: string,
	allowBootstrap = false,
): PrevStateDecision {
	if (status === 404)
		return { kind: "bootstrap", reason: "404: never published" };
	let reason: string;
	if (status === 200) {
		let raw: unknown;
		try {
			raw = JSON.parse(body);
		} catch {
			raw = undefined;
		}
		const state = parseLastmodState(raw);
		if (state?.complete) return { kind: "prev", state };
		if (state && isEmptyIncompleteState(state)) {
			return { kind: "bootstrap", reason: "published state is empty" };
		}
		reason =
			raw === undefined
				? "body is not JSON"
				: state
					? "unexpected incomplete state with entries"
					: "JSON without the expected shape";
	} else {
		reason = status === 0 ? "network error" : `HTTP ${status}`;
	}
	return allowBootstrap
		? { kind: "bootstrap", reason: `${reason} (LASTMOD_ALLOW_BOOTSTRAP=1)` }
		: { kind: "retry", reason };
}

/**
 * Keys dated in `next`'s build (new or changed content) — what IndexNow should
 * be told about. Re-baselined keys (mass-change brake) and absent keys are
 * not included, and nothing is without a usable `prev`: a bootstrap is not a
 * change we can attribute to one build.
 */
export function changedKeys(
	prev: LastmodState | null,
	next: LastmodState | null,
): { laws: string[]; reforms: string[] } {
	if (!prev?.complete || !next?.complete) return { laws: [], reforms: [] };
	const diff = (
		a: Record<string, LastmodEntry>,
		b: Record<string, LastmodEntry>,
	) =>
		Object.keys(b)
			.filter((k) => {
				const e = b[k]!;
				return !isAbsent(e) && e[1] === next.generated && a[k]?.[0] !== e[0];
			})
			.sort();
	return {
		laws: diff(prev.laws, next.laws),
		reforms: diff(prev.reforms, next.reforms),
	};
}
