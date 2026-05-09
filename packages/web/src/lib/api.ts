/**
 * API client for fetching data from Elysia API.
 *
 * Provides type-safe functions for fetching legislative data from the Ley Abierta API.
 */

import { config } from "../config/env";
import { ApiError, isRetryableError, NetworkError } from "./errors";
import {
	LawDetailSchema,
	OmnibusTopicSchema,
	type LawDetail,
	type OmnibusTopic,
} from "./schemas";

/**
 * Internal fetch function with retry logic.
 *
 * @param path - API endpoint path
 * @param retries - Number of retry attempts (default: 3)
 * @returns Parsed JSON response
 * @throws ApiError on API errors
 * @throws NetworkError on network failures
 */
async function fetchApi<T>(
	path: string,
	retries = 3,
	attempt = 1,
): Promise<T> {
	const headers: Record<string, string> = {};
	if (config.api.bypassKey) headers["x-api-key"] = config.api.bypassKey;

	try {
		const res = await fetch(`${config.api.baseUrl}${path}`, { headers });
		if (!res.ok) {
			// Don't retry client errors (4xx) — they won't succeed on retry
			if (res.status >= 400 && res.status < 500) {
				throw new ApiError(res.status, `Request failed`, path);
			}
			throw new Error(`API ${res.status}: ${path} (retryable)`);
		}
		return res.json();
	} catch (err) {
		// Check if error is retryable
		if (!isRetryableError(err)) throw err;
		if (attempt >= retries) throw err;
		const delay = attempt * 2000;
		console.warn(
			`[api] ${path} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms...`,
		);
		await new Promise((r) => setTimeout(r, delay));
		return fetchApi<T>(path, retries, attempt + 1);
	}
}

/**
 * Fetch a law by ID with full details.
 *
 * @param id - Law identifier (e.g., "BOE-A-1978-31229")
 * @returns Law details with metadata, blocks, and reforms
 * @throws ApiError if the law is not found or API error occurs
 */
export function getLaw(id: string): Promise<LawDetail> {
	return fetchApi(`/v1/laws/${id}`).then((data) =>
		LawDetailSchema.parse(data),
	);
}

// ── Omnibus endpoints ──

/** Omnibus topic type */
export { type OmnibusTopic };
