/**
 * Build-time manifest loader.
 *
 * During CI builds, a JSON manifest is fetched once from the API before
 * `astro build` starts. This file reads and caches that manifest so each
 * law page can look up citizen_summary, citizen_tags, and omnibus topics
 * without making per-page API calls (12K calls → 0).
 *
 * This file is intentionally separate from api.ts to avoid introducing
 * a node:fs import into a module that could be bundled for client-side code.
 */

import { readFileSync } from "node:fs";
import type { OmnibusTopic } from "./api.ts";

export interface BuildManifest {
	citizens: Record<
		string,
		{ summary: string; tags: string[]; materias: string[] }
	>;
	omnibus: Record<string, OmnibusTopic[]>;
	/**
	 * AI headline + summary per reform, newest first. Optional: manifests from
	 * an API older than this field simply have no reform headlines.
	 */
	reforms?: Record<string, ReformSummary[]>;
}

export interface ReformSummary {
	/** ISO date of the reform (matches `reformas[].fecha` in the frontmatter). */
	date: string;
	/** BOE id of the reforming norm (matches `reformas[].fuente`). */
	source: string;
	headline: string;
	summary: string;
}

/**
 * One article in the article-summaries manifest: `[heading, summary, blockId]`.
 * `blockId` is the BOE block id (= anchor on the BOE page); it is optional
 * because manifests from an API older than that field only carry two entries.
 */
export type ArticleSummaryPair = [string, string, string?];

/**
 * Per-norm article summaries: `normId → ArticleSummaryPair[]`.
 * Loaded from a separate, larger file (see BUILD_ARTICLE_SUMMARIES_PATH) so the
 * main manifest stays lean.
 */
export type ArticleSummariesManifest = Record<string, ArticleSummaryPair[]>;

let _manifest: BuildManifest | null | undefined;
let _articleSummaries: ArticleSummariesManifest | null | undefined;

/**
 * Load the article-summaries manifest once (cached). Returns null when no
 * manifest path is configured (local dev) or the file is missing/invalid — in
 * which case article summaries are simply omitted from the built pages.
 */
export function loadArticleSummaries(): ArticleSummariesManifest | null {
	if (_articleSummaries !== undefined) return _articleSummaries;
	const path = process.env.BUILD_ARTICLE_SUMMARIES_PATH;
	if (!path) {
		_articleSummaries = null;
		return null;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			console.warn("[manifest] Invalid article-summaries shape");
			_articleSummaries = null;
			return null;
		}
		_articleSummaries = parsed as ArticleSummariesManifest;
		console.log(
			`[manifest] Loaded article summaries for ${Object.keys(_articleSummaries).length} norms`,
		);
		return _articleSummaries;
	} catch (err) {
		console.warn(
			`[manifest] Failed to load article summaries from ${path}: ${err instanceof Error ? err.message : "unknown error"}`,
		);
		_articleSummaries = null;
		return null;
	}
}

export function loadManifest(): BuildManifest | null {
	if (_manifest !== undefined) return _manifest;
	const path = process.env.BUILD_MANIFEST_PATH;
	if (!path) {
		_manifest = null;
		return null;
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);

		// Shape validation: ensure manifest has expected structure
		if (
			!parsed ||
			typeof parsed.citizens !== "object" ||
			typeof parsed.omnibus !== "object"
		) {
			console.warn(
				"[manifest] Invalid shape: missing 'citizens' or 'omnibus' key",
			);
			_manifest = null;
			return null;
		}

		_manifest = parsed as BuildManifest;
		const citizenCount = Object.keys(_manifest.citizens).length;
		const omnibusCount = Object.keys(_manifest.omnibus).length;
		console.log(
			`[manifest] Loaded ${citizenCount} citizens, ${omnibusCount} omnibus entries`,
		);
		return _manifest;
	} catch (err) {
		console.warn(
			`[manifest] Failed to load from ${path}: ${err instanceof Error ? err.message : "unknown error"}`,
		);
		_manifest = null;
		return null;
	}
}

/** What a law page has of its own (beyond the BOE text). */
export interface LawOwnContent {
	citizenSummary: boolean;
	reformHeadlines: boolean;
	articleSummaries: boolean;
}

export function lawOwnContent(id: string): LawOwnContent {
	const manifest = loadManifest();
	const articles = loadArticleSummaries();
	return {
		citizenSummary: !!manifest?.citizens[id]?.summary,
		reformHeadlines: (manifest?.reforms?.[id]?.length ?? 0) > 0,
		articleSummaries: !!articles?.[id]?.some(([, s]) => s.length > 0),
	};
}

/**
 * Whether `/leyes/[id]/` is worth indexing: it must carry at least one piece
 * of our own content (citizen summary, reform headlines or article
 * summaries); otherwise it is a thin page over the BOE text and gets
 * `noindex` + is left out of the sitemap.
 *
 * Fails open: when either manifest is missing (local dev, or a failed fetch
 * in CI) we cannot tell, so the page stays indexable rather than silently
 * dropping thousands of laws from Google.
 */
export function isIndexableLaw(id: string): boolean {
	if (!loadManifest() || !loadArticleSummaries()) return true;
	const c = lawOwnContent(id);
	return c.citizenSummary || c.reformHeadlines || c.articleSummaries;
}
