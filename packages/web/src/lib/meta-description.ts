/**
 * Meta description length policy, shared by every page.
 *
 * Bing Webmaster Tools (and Google, informally) want a `<meta name="description">`
 * between 25 and 160 characters. Below 25 it reads as too thin to be useful;
 * above 160 it gets truncated in the search result snippet, usually mid-word.
 *
 * `ensureMetaDescription` is the safety net every page goes through (wired in
 * `layouts/Base.astro`): too short → fallback, too long → truncated at a word
 * boundary with "…". `composeLawDescription` is the law ficha page's smarter
 * builder — it leads with the citizen summary and drops the optional parts
 * (department, then status, then the rank abbreviation) before it ever has to
 * truncate the summary itself.
 *
 * Lengths are measured in Unicode code points (`Array.from`, not `.length`,
 * so accented letters — already single code points in Spanish — and any
 * astral character count once), after unescaping HTML entities: a title or
 * summary assembled from HTML source can carry entities like `&amp;`, and an
 * unescaped `&amp;` would make the string look one character shorter than
 * what a reader (or Bing) actually sees.
 */

export const MIN_DESCRIPTION_LENGTH = 25;
export const MAX_DESCRIPTION_LENGTH = 160;

/** Same copy as `Base.astro`'s own default — kept here so callers that build
 * a description outside Base (e.g. `composeLawDescription`) can fall back to
 * the identical text instead of duplicating it. */
export const FALLBACK_DESCRIPTION =
	"Legislación española consolidada, accesible para todos.";

const ELLIPSIS = "…";

/** Named + numeric HTML entities that can realistically show up in titles or
 * AI summaries sourced from HTML. Not a full HTML-entity table on purpose. */
function unescapeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, " ")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&#39;/g, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, dec: string) =>
			String.fromCodePoint(Number.parseInt(dec, 10)),
		)
		.replace(/&amp;/gi, "&");
}

/** Collapse runs of whitespace (incl. newlines) to a single space and trim. */
export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Unicode code-point length (not UTF-16 `.length`, not grapheme clusters). */
export function codePointLength(text: string): number {
	return Array.from(text).length;
}

/** Clean up text for length measurement and display: unescape entities, then
 * normalize whitespace. Exported so callers can measure/compare consistently
 * with what `ensureMetaDescription` does internally. */
export function cleanText(text: string | undefined | null): string {
	return normalizeWhitespace(unescapeHtmlEntities(text ?? ""));
}

// Trailing punctuation/connectors that look wrong right before an ellipsis.
const TRAILING_JUNK = /[\s,.;:·—–-]+$/u;

/**
 * Truncate `text` to at most `max` Unicode characters, cutting at the last
 * word boundary within budget and appending "…". Does not assume `text` is
 * already normalized/unescaped — call `cleanText` first if that matters.
 */
export function truncateAtWordBoundary(text: string, max: number): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	if (max <= ELLIPSIS.length) return chars.slice(0, Math.max(max, 0)).join("");

	const budget = max - ELLIPSIS.length;
	const slice = chars.slice(0, budget).join("");
	const lastSpace = slice.lastIndexOf(" ");
	// Only break on the last space if it doesn't throw away most of the
	// budget (e.g. one very long first word) — otherwise a hard cut reads
	// better than losing 60%+ of the available length.
	const cut = lastSpace >= budget * 0.4 ? slice.slice(0, lastSpace) : slice;
	return cut.replace(TRAILING_JUNK, "") + ELLIPSIS;
}

/**
 * Enforce the 25–160 character rule on a single description string. This is
 * the safety net wired into `Base.astro`, applied to every page — it never
 * throws, and it degrades gracefully: empty/too-short input gets `fallback`
 * (which must itself be 25–160 characters — every real fallback in this
 * codebase is), too-long input gets truncated at a word boundary.
 */
export function ensureMetaDescription(
	text: string | undefined | null,
	fallback: string = FALLBACK_DESCRIPTION,
): string {
	const clean = cleanText(text);
	const base =
		codePointLength(clean) >= MIN_DESCRIPTION_LENGTH
			? clean
			: cleanText(fallback);
	if (codePointLength(base) > MAX_DESCRIPTION_LENGTH) {
		return truncateAtWordBoundary(base, MAX_DESCRIPTION_LENGTH);
	}
	return base;
}

/** Inputs for the law ficha page's SEO-optimized description. */
export interface LawDescriptionParts {
	/** Short rank/number prefix, e.g. "RDLeg 2/2015". Optional, dropped first
	 * of the "prefix" parts if the description would otherwise be too long —
	 * but only after status and department are dropped, since it's cheap
	 * (short) and useful (instantly recognizable). */
	abbreviation?: string | null;
	/** The most useful content: the citizen summary, or a rank-label fallback
	 * when there is no summary yet. Always kept, truncated only as a last
	 * resort. */
	summary: string;
	/** e.g. "En vigor". First thing dropped when over budget. */
	status?: string | null;
	/** e.g. a ministry name. Dropped right after status (department carries
	 * less search value than the summary itself for most queries). */
	department?: string | null;
}

/**
 * Build the law ficha page's meta description: lead with the citizen
 * summary, keep the abbreviation prefix if it fits, and drop status/
 * department first (in that order) when the joined string would exceed
 * `max`. Only truncates the summary itself as a last resort, at a word
 * boundary.
 */
export function composeLawDescription(
	parts: LawDescriptionParts,
	max: number = MAX_DESCRIPTION_LENGTH,
	min: number = MIN_DESCRIPTION_LENGTH,
): string {
	const abbreviation = cleanText(parts.abbreviation);
	const summary = cleanText(parts.summary);
	const status = cleanText(parts.status);
	const department = cleanText(parts.department);

	const join = (segments: (string | undefined)[]) =>
		segments.filter((s): s is string => !!s).join(" · ");

	// Most-complete first; each step drops the next-lowest-priority part.
	const candidates = [
		join([abbreviation, summary, status, department]),
		join([abbreviation, summary, status]),
		join([abbreviation, summary]),
		join([summary]),
	];

	for (const candidate of candidates) {
		if (!candidate) continue;
		if (codePointLength(candidate) <= max) {
			return codePointLength(candidate) >= min
				? candidate
				: ensureMetaDescription(candidate);
		}
	}

	// Even the summary alone (with the abbreviation) overflows `max`: truncate
	// it. Keep the abbreviation prefix only if it leaves a useful amount of
	// room for the summary.
	const prefix = abbreviation ? `${abbreviation} · ` : "";
	const prefixLen = codePointLength(prefix);
	if (prefix && prefixLen < max * 0.5) {
		return `${prefix}${truncateAtWordBoundary(summary, max - prefixLen)}`;
	}
	return ensureMetaDescription(truncateAtWordBoundary(summary, max));
}
