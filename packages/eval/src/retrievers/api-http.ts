/**
 * HTTP retriever — calls the production `POST /v1/ask` endpoint.
 *
 * Slower than rag-direct (full synthesis round-trip) but useful for
 * end-to-end testing against a deployed API instance.
 *
 * Citation extraction: the prod endpoint returns `citations[]` in the
 * `done` SSE event (streaming) or in the JSON body (non-streaming).
 * We parse the `normId` field from each citation and dedupe to norm level.
 *
 * NOTE: This retriever only sees norms that were cited in the answer,
 * NOT the full retrieval pool. It measures citation-level recall, not
 * retrieval-level recall. For retrieval metrics use rag-direct.
 */

import type { EvalCandidate } from "../harness.ts";

export interface ApiHttpOpts {
	/** Base URL of the API (e.g. "http://localhost:3000" or "https://api.leyabierta.es") */
	baseUrl: string;
	/** Optional bearer token */
	apiKey?: string;
	/** Request timeout in ms (default: 60_000) */
	timeoutMs?: number;
}

interface CitationRaw {
	normId: string;
	articleTitle: string;
	verified?: boolean;
}

interface AskResponseRaw {
	answer?: string;
	citations?: CitationRaw[];
	declined?: boolean;
}

/**
 * Returns a `retrieve` function compatible with `runEval`.
 *
 * Sends the question to `POST /v1/ask` and extracts cited norm IDs.
 * Results are ranked by order of first appearance in the citations array.
 */
export function makeApiHttpRetriever(
	opts: ApiHttpOpts,
): (q: string) => Promise<EvalCandidate[]> {
	const { baseUrl, apiKey, timeoutMs = 60_000 } = opts;

	return async (question: string): Promise<EvalCandidate[]> => {
		const url = `${baseUrl.replace(/\/$/, "")}/v1/ask`;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
		};
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({ question }),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}

		if (!response.ok) {
			throw new Error(
				`POST /v1/ask returned ${response.status}: ${await response.text()}`,
			);
		}

		const body = (await response.json()) as AskResponseRaw;

		if (body.declined || !body.citations || body.citations.length === 0) {
			return [];
		}

		// Dedupe by norm_id, preserving first-appearance order (= citation rank)
		const seen = new Map<string, number>(); // norm_id → 1-based rank
		for (const c of body.citations) {
			if (c.normId && !seen.has(c.normId)) {
				seen.set(c.normId, seen.size + 1);
			}
		}

		return [...seen.entries()].map(([norm_id, rank]) => ({
			norm_id,
			rank,
			score: 1 / rank,
		}));
	};
}
