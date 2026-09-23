/**
 * Default Cache-Control policy for API responses cached at the Cloudflare edge.
 *
 * Successful responses are cached for an hour (s-maxage=3600): the corpus only
 * changes once a day, when the daily pipeline ingests.
 *
 * Error responses must NOT inherit that hour. Before this module, a 404 for a
 * law that the pipeline had not ingested yet stayed cached at the edge for up
 * to an hour after the ingest added it. On 2026-09-23 that made
 * /v1/laws/BOE-A-2026-17836 (Ley 8/2026 del amianto) keep answering "Law not
 * found" from the edge while the origin already served it, and the audit read
 * it as a pipeline discovery bug. A 429 is per-client: caching it would hand
 * one client's rate limit to everyone behind the same edge.
 */

import { StatusMap } from "elysia";

/** Short edge TTL for 404s: shields origin from ID-guessing, bounded staleness. */
export const NOT_FOUND_CACHE_CONTROL =
	"public, max-age=0, s-maxage=60, must-revalidate";
export const SUCCESS_CACHE_CONTROL =
	"public, max-age=0, s-maxage=3600, must-revalidate";
export const NO_STORE = "no-store";

/** Normalize Elysia's `set.status` (number, name, or unset) to a number. */
export function toStatusCode(status: number | string | undefined): number {
	if (status === undefined) return 200;
	if (typeof status === "number") return status;
	const mapped = (StatusMap as Record<string, number>)[status];
	return mapped ?? 200;
}

/**
 * Cache-Control for a response that did not set its own, or `undefined` when
 * the path must not get a default header (alerts, health).
 */
export function defaultCacheControl(
	path: string,
	status: number | string | undefined,
): string | undefined {
	if (path.startsWith("/v1/alerts") || path === "/health") return undefined;
	const code = toStatusCode(status);
	if (code >= 200 && code < 400) return SUCCESS_CACHE_CONTROL;
	if (code === 404) return NOT_FOUND_CACHE_CONTROL;
	return NO_STORE;
}
