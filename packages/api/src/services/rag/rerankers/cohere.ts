/**
 * Cohere Rerank 4 Pro — pluggable reranker for A/B evaluation.
 *
 * This is the pre-Phase-6 production reranker, resurrected as an opt-in module
 * for A/B comparison against the Qwen NaN LLM reranker. It is NOT used in prod.
 *
 * Backend selection (in order of preference):
 *   1. Direct Cohere API (COHERE_API_KEY) — cheaper, lower latency.
 *   2. OpenRouter proxy (OPENROUTER_API_KEY) — via cohere/rerank-4-pro model.
 *
 * If neither key is set, construction throws a clear error rather than silently
 * falling back to passthrough — the caller must make an explicit choice.
 *
 * Interface mirrors the qwenLLMRerank return shape so it can be swapped into
 * the `rerankerOverrides` slot of `runRetrievalCore` without changes.
 *
 * Usage (in rag-gemini-legacy.ts):
 *   const reranker = new CohereReranker();
 *   const { results } = await reranker.rerank(query, candidates, topK);
 */

const COHERE_RERANK_URL = "https://api.cohere.com/v2/rerank";
const COHERE_RERANK_MODEL = "rerank-v3.5"; // latest as of Phase 6 cutoff
const OPENROUTER_RERANK_URL = "https://openrouter.ai/api/v1/rerank";
const OPENROUTER_RERANK_MODEL = "cohere/rerank-4-pro";

export interface CohereCandidate {
	key: string; // "normId:blockId"
	title: string;
	text: string;
}

export interface CohereRerankResult {
	key: string;
	relevanceScore: number;
	rank: number;
}

export type CohereBackend = "cohere-direct" | "cohere-openrouter";

export class CohereReranker {
	private readonly _apiKey: string;
	private readonly _backend: CohereBackend;

	/**
	 * @param cohereApiKey   - Direct Cohere API key (preferred). Falls back to openrouterApiKey.
	 * @param openrouterApiKey - OpenRouter API key (via cohere/rerank-4-pro). Used if cohereApiKey is absent.
	 *
	 * Throws at construction time if neither key is provided.
	 */
	constructor(
		opts: {
			cohereApiKey?: string;
			openrouterApiKey?: string;
		} = {},
	) {
		const cohereKey = opts.cohereApiKey ?? process.env.COHERE_API_KEY ?? "";
		const orKey = opts.openrouterApiKey ?? process.env.OPENROUTER_API_KEY ?? "";

		if (cohereKey) {
			this._apiKey = cohereKey;
			this._backend = "cohere-direct";
		} else if (orKey) {
			this._apiKey = orKey;
			this._backend = "cohere-openrouter";
		} else {
			throw new Error(
				"CohereReranker: neither COHERE_API_KEY nor OPENROUTER_API_KEY is set. " +
					"Set one of them to use the Gemini legacy retriever.",
			);
		}
	}

	get backend(): CohereBackend {
		return this._backend;
	}

	/**
	 * Rerank `candidates` by relevance to `query`, returning the top `topK`.
	 * Matches the return shape of qwenLLMRerank for easy substitution.
	 */
	async rerank(
		query: string,
		candidates: CohereCandidate[],
		topK: number,
	): Promise<{ results: CohereRerankResult[]; backend: string; cost: number }> {
		if (candidates.length === 0) {
			return { results: [], backend: this._backend, cost: 0 };
		}
		if (candidates.length <= topK) {
			return {
				results: candidates.map((c, i) => ({
					key: c.key,
					relevanceScore: 1 - i * 0.01,
					rank: i + 1,
				})),
				backend: `${this._backend}-passthrough`,
				cost: 0,
			};
		}

		if (this._backend === "cohere-direct") {
			return this._rerankDirect(query, candidates, topK);
		}
		return this._rerankViaOpenRouter(query, candidates, topK);
	}

	// ── Direct Cohere API ─────────────────────────────────────────────────────

	private async _rerankDirect(
		query: string,
		candidates: CohereCandidate[],
		topK: number,
	): Promise<{ results: CohereRerankResult[]; backend: string; cost: number }> {
		const documents = candidates.map((c) => ({
			text: `${c.title}\n\n${c.text.slice(0, 1500)}`,
		}));

		let response: Response;
		try {
			response = await fetch(COHERE_RERANK_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this._apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: COHERE_RERANK_MODEL,
					query,
					documents,
					top_n: topK,
				}),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[cohere-reranker] Network error: ${msg}; passthrough`);
			return this._passthrough(candidates, topK, "cohere-direct-network-error");
		}

		if (!response.ok) {
			const err = await response.text().catch(() => "");
			console.warn(
				`[cohere-reranker] Cohere API ${response.status}: ${err.slice(0, 200)}; passthrough`,
			);
			return this._passthrough(
				candidates,
				topK,
				`cohere-direct-${response.status}`,
			);
		}

		const data = (await response.json()) as {
			results: Array<{ index: number; relevance_score: number }>;
		};

		const results: CohereRerankResult[] = data.results
			.filter((r) => r.index >= 0 && r.index < candidates.length)
			.slice(0, topK)
			.map((r, rank) => ({
				key: candidates[r.index]!.key,
				relevanceScore: r.relevance_score,
				rank: rank + 1,
			}));

		return { results, backend: "cohere-direct", cost: 0 };
	}

	// ── OpenRouter proxy ──────────────────────────────────────────────────────

	private async _rerankViaOpenRouter(
		query: string,
		candidates: CohereCandidate[],
		topK: number,
	): Promise<{ results: CohereRerankResult[]; backend: string; cost: number }> {
		const documents = candidates.map(
			(c) => `${c.title}\n\n${c.text.slice(0, 1500)}`,
		);

		let response: Response;
		try {
			response = await fetch(OPENROUTER_RERANK_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this._apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://leyabierta.es",
					"X-Title": "Ley Abierta RAG (A/B eval)",
				},
				body: JSON.stringify({
					model: OPENROUTER_RERANK_MODEL,
					query,
					documents,
					top_n: topK,
				}),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`[cohere-reranker] OpenRouter network error: ${msg}; passthrough`,
			);
			return this._passthrough(
				candidates,
				topK,
				"cohere-openrouter-network-error",
			);
		}

		if (!response.ok) {
			const err = await response.text().catch(() => "");
			console.warn(
				`[cohere-reranker] OpenRouter ${response.status}: ${err.slice(0, 200)}; passthrough`,
			);
			return this._passthrough(
				candidates,
				topK,
				`cohere-openrouter-${response.status}`,
			);
		}

		const data = (await response.json()) as {
			results: Array<{ index: number; relevance_score: number }>;
			usage?: { cost?: number };
		};

		const cost = data.usage?.cost ?? 0;
		const results: CohereRerankResult[] = (data.results ?? [])
			.filter((r) => r.index >= 0 && r.index < candidates.length)
			.slice(0, topK)
			.map((r, rank) => ({
				key: candidates[r.index]!.key,
				relevanceScore: r.relevance_score,
				rank: rank + 1,
			}));

		return { results, backend: "cohere-openrouter", cost };
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private _passthrough(
		candidates: CohereCandidate[],
		topK: number,
		backend: string,
	): { results: CohereRerankResult[]; backend: string; cost: number } {
		return {
			results: candidates.slice(0, topK).map((c, i) => ({
				key: c.key,
				relevanceScore: 1 - i * 0.01,
				rank: i + 1,
			})),
			backend,
			cost: 0,
		};
	}
}
