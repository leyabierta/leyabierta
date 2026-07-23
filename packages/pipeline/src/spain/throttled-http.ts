/**
 * Shared throttle + fetch-with-retry base for BOE HTTP clients.
 *
 * Both `BoeClient` (consolidated legislation API) and `BoeDiarioClient`
 * (daily bulletin) need the same self-imposed courtesy delay between
 * requests and the same retry-with-backoff wrapper around `fetch`.
 */

import { withRetry } from "../utils/retry.ts";

const DEFAULT_DELAY_MS = 200; // ~5 req/s courtesy limit

class NotFoundError extends Error {
	constructor(url: string) {
		super(`404 ${url}`);
		this.name = "NotFoundError";
	}
}

export class ThrottledHttp {
	private lastRequestAt = 0;

	constructor(private readonly delayMs = DEFAULT_DELAY_MS) {}

	/** Fetch a URL as raw bytes, throttled and retried on failure. */
	async fetch(url: string, accept?: string): Promise<Uint8Array> {
		return withRetry(() => this.doFetch(url, accept), {
			maxRetries: 3,
			baseDelayMs: 1000,
			onRetry: (attempt, error) => {
				const msg = error instanceof Error ? error.message : String(error);
				console.warn(`  ⟳ Retry ${attempt}/3 for ${url}: ${msg}`);
			},
		});
	}

	/**
	 * Like `fetch`, but returns `undefined` on a 404 instead of throwing —
	 * used for endpoints where "not found" is an expected, meaningful
	 * response (e.g. no BOE publication on a given day).
	 */
	async fetchOptional(
		url: string,
		accept?: string,
	): Promise<Uint8Array | undefined> {
		try {
			return await withRetry(() => this.doFetch(url, accept, true), {
				maxRetries: 3,
				baseDelayMs: 1000,
				onRetry: (attempt, error) => {
					const msg = error instanceof Error ? error.message : String(error);
					console.warn(`  ⟳ Retry ${attempt}/3 for ${url}: ${msg}`);
				},
				retryIf: (error) => !(error instanceof NotFoundError),
			});
		} catch (error) {
			if (error instanceof NotFoundError) return undefined;
			throw error;
		}
	}

	private async doFetch(
		url: string,
		accept: string | undefined,
		treat404AsError = false,
	): Promise<Uint8Array> {
		await this.throttle();

		const response = await globalThis.fetch(url, {
			headers: accept ? { Accept: accept } : undefined,
		});

		if (treat404AsError && response.status === 404) {
			throw new NotFoundError(url);
		}

		if (!response.ok) {
			throw new Error(`BOE request failed: ${response.status} ${url}`);
		}

		return new Uint8Array(await response.arrayBuffer());
	}

	async throttle(): Promise<void> {
		const now = Date.now();
		const elapsed = now - this.lastRequestAt;
		if (elapsed < this.delayMs) {
			await new Promise((resolve) =>
				setTimeout(resolve, this.delayMs - elapsed),
			);
		}
		this.lastRequestAt = Date.now();
	}
}
