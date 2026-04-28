/**
 * Hybrid search for /v1/laws — Issue #40.
 *
 * Combines BM25 (norm-level FTS) with vector search (article-level embeddings)
 * via Reciprocal Rank Fusion. Citizen-language queries like "morir dignamente"
 * or "horas extras que no me pagan" map to the right norm even when the legal
 * text never uses those phrases.
 *
 * Cost mitigations:
 *   - Query embedding LRU cache (`Map<string, Float32Array>`, capped) so the
 *     same query never pays twice.
 *   - Vector index loads lazily on first hybrid call.
 *
 * Aggregation: TWO ranked lists are produced from the article-level KNN and
 * fused alongside BM25 — max-pool (best single article wins) and sum-pool
 * (mass-of-evidence wins). Diagnostic in #40 showed that for "punctual"
 * citizen queries (e.g. "morir dignamente") max-pool surfaces the right
 * specialized norm, while for "thematic" queries (jubilación, viudedad, paro)
 * the answer is a large code (LGSS) whose best single article is no more
 * relevant than a regulation's, but which has many moderately-relevant
 * articles — sum-pool catches that. Neither pool dominates; RRF over both
 * gets best of both worlds.
 *
 * Rank boost: vector scores are multiplied by a per-norm factor based on
 * legal rank + jurisdiction so that state-level laws and codes (where
 * citizens expect answers) are not buried by their own development
 * regulations or by autonomous-community norms with locally-strong wording.
 */

import type { Database } from "bun:sqlite";
import {
	EMBEDDING_MODELS,
	type EmbeddingModel,
	embedQuery,
	ensureVectorIndex,
	type InMemoryVectorIndex,
	type VectorSearchResult,
} from "./rag/embeddings.ts";
import { type RankedItem, reciprocalRankFusion } from "./rag/rrf.ts";
import { startHybridTrace } from "./rag/tracing.ts";
import { vectorSearchPooled } from "./rag/vector-pool.ts";

export const HYBRID_EMBEDDING_MODEL_KEY = "gemini-embedding-2";

/**
 * Bounded LRU for query embeddings. Keys are the raw user query; values are
 * Float32Array of length `dimensions`. Cap of 1000 entries ≈ 12 MB at 3072
 * dims, negligible heap.
 */
class QueryEmbeddingCache {
	private map = new Map<string, Float32Array>();

	constructor(private maxSize: number = 1000) {}

	get(key: string): Float32Array | undefined {
		const v = this.map.get(key);
		if (v === undefined) return undefined;
		// Bump recency: re-insert at the end.
		this.map.delete(key);
		this.map.set(key, v);
		return v;
	}

	set(key: string, value: Float32Array): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		} else if (this.map.size >= this.maxSize) {
			const first = this.map.keys().next().value;
			if (first !== undefined) this.map.delete(first);
		}
		this.map.set(key, value);
	}

	get size(): number {
		return this.map.size;
	}
}

export interface HybridSearchOptions {
	/** Top-K articles to retrieve from KNN before aggregating to norm-level. */
	articleTopK?: number;
	/** Top-N norms to return from the fused list. */
	normTopK?: number;
	/** RRF constant. Default 60 per the original paper. */
	rrfK?: number;
	/**
	 * Pooling strategy. Default `"max+sum"` fuses both lists in RRF and is the
	 * recommended setting; `"max"` and `"mean"` are kept for ablation.
	 */
	pool?: "max" | "mean" | "max+sum";
	/** Apply per-norm rank boost to vector scores. Default true. */
	boostByRank?: boolean;
}

/**
 * Per-rank boost applied to vector scores before pool aggregation. Values
 * tuned from the #40 miss diagnostic — state-level laws and codes ×1.0,
 * regulations and autonomous laws penalized. Conservative floor of 0.4 so
 * specialized regulations can still surface when the citizen genuinely wants
 * the implementing rule.
 */
function rankFactor(rank: string, jurisdiction: string): number {
	const isState = jurisdiction === "es";
	switch (rank) {
		case "constitucion":
			return 1.0;
		case "real_decreto_legislativo":
			// Textos refundidos (LGSS, ET, LIRPF, LCSP, TRLGDCU…) — la
			// referencia canónica por materia. Suben +20% para no ser
			// enterrados por sus propios reglamentos de desarrollo.
			return 1.2;
		case "ley_organica":
			return 1.0;
		case "ley":
			return isState ? 1.0 : 0.6;
		case "real_decreto_ley":
			return 0.85;
		case "real_decreto":
			return 0.7;
		case "decreto":
			return 0.6;
		case "orden":
		case "instruccion":
		case "resolucion":
		case "circular":
			return 0.4;
		default:
			return 0.7;
	}
}

/**
 * Articles below this cosine threshold contribute zero to sum-pool. Stops
 * the long tail of weak matches from drowning the genuine signal in big
 * codes — sum-pool is "mass of evidence above noise", not raw sum.
 */
const SUM_POOL_THRESHOLD = 0.5;

export interface HybridSearcher {
	/**
	 * Run hybrid retrieval. Returns the fused, ranked list of norm IDs (best
	 * first). Filtering is the caller's responsibility — DbService applies
	 * status/jurisdiction/rank/materia/citizen_tag against the fused IDs.
	 */
	rankNorms(
		query: string,
		bm25NormIds: string[],
		options?: HybridSearchOptions,
	): Promise<{
		fused: string[];
		bm25Count: number;
		vectorCount: number;
		embeddingCacheHit: boolean;
		embedMs: number;
		searchMs: number;
	}>;
}

/**
 * Default implementation backed by OpenRouter (query embedding) + the
 * in-memory `vectors.bin` index used by the RAG pipeline.
 */
export class HybridSearcherImpl implements HybridSearcher {
	private vectorIndex: {
		meta: Array<{ normId: string; blockId: string }>;
		vectors: InMemoryVectorIndex;
		dims: number;
	} | null = null;
	private vectorIndexPromise: Promise<void> | null = null;
	private cache = new QueryEmbeddingCache(1000);

	constructor(
		private db: Database,
		private apiKey: string,
		private dataDir: string = "./data",
		private modelKey: string = HYBRID_EMBEDDING_MODEL_KEY,
	) {
		if (!apiKey) {
			throw new Error(
				"HybridSearcher requires OPENROUTER_API_KEY. Hybrid mode cannot fall back silently to BM25 — surface the configuration error.",
			);
		}
		const model: EmbeddingModel | undefined = EMBEDDING_MODELS[modelKey];
		if (!model) {
			throw new Error(`Unknown embedding model: ${modelKey}`);
		}
	}

	private async getVectorIndex() {
		if (this.vectorIndex) return this.vectorIndex;
		if (!this.vectorIndexPromise) {
			this.vectorIndexPromise = ensureVectorIndex(
				this.db,
				this.modelKey,
				this.dataDir,
			)
				.then((idx) => {
					if (!idx) {
						throw new Error(
							`No vector index available for model ${this.modelKey}. Run sync-embeddings.ts first.`,
						);
					}
					this.vectorIndex = idx;
				})
				.catch((err) => {
					this.vectorIndexPromise = null;
					throw err;
				});
		}
		await this.vectorIndexPromise;
		if (!this.vectorIndex) throw new Error("Vector index failed to load");
		return this.vectorIndex;
	}

	async rankNorms(
		query: string,
		bm25NormIds: string[],
		options: HybridSearchOptions = {},
	) {
		const articleTopK = options.articleTopK ?? 200;
		const normTopK = options.normTopK ?? 200;
		const rrfK = options.rrfK ?? 60;
		const pool = options.pool ?? "max+sum";
		const boostByRank = options.boostByRank ?? true;

		const trimmed = query.trim();

		const trace = startHybridTrace(trimmed, {
			pool,
			boostByRank,
			articleTopK,
			normTopK,
			rrfK,
			bm25Candidates: bm25NormIds.length,
		});

		try {
			// 1. Get query embedding (cache or API).
			let cacheHit = false;
			const embedStart = performance.now();
			const embedSpan = trace.span("embed_query", "general", {
				model: this.modelKey,
				query: trimmed,
				cacheSize: this.cache.size,
			});
			let embedding = this.cache.get(trimmed);
			let embedTokens = 0;
			if (embedding) {
				cacheHit = true;
			} else {
				try {
					const result = await embedQuery(this.apiKey, this.modelKey, trimmed);
					embedding = result.embedding;
					embedTokens = result.tokens;
					this.cache.set(trimmed, embedding);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					embedSpan.end({ error: msg, cache_hit: false });
					trace.end({ error: msg, latency_ms: performance.now() - embedStart });
					throw err;
				}
			}
			const embedMs = performance.now() - embedStart;
			embedSpan.end({
				cache_hit: cacheHit,
				tokens: embedTokens,
				latency_ms: Math.round(embedMs),
			});

			// 2. BM25 ranked list (input is already in BM25 relevance order).
			const bm25Start = performance.now();
			const bm25Span = trace.span("bm25", "general", {
				n_candidates: bm25NormIds.length,
			});
			const bm25Ranked: RankedItem[] = bm25NormIds.map((id, i) => ({
				key: id,
				// Inverse rank as a stand-in score; RRF only uses rank position.
				score: 1 / (i + 1),
			}));
			const bm25Ms = performance.now() - bm25Start;
			bm25Span.end({
				n_candidates: bm25Ranked.length,
				latency_ms: Math.round(bm25Ms),
			});

			// 3. KNN over article embeddings → top-K articles, then aggregate to norm.
			// Dispatched to the shared Bun Worker pool (`vector-pool.ts`) so the
			// SIMD KNN runs off the main thread and the ~5.6 GB index lives once
			// in SharedArrayBuffer across the process. Same pool used by /v1/ask.
			const searchStart = performance.now();
			const idx = await this.getVectorIndex();
			const vectorsCount = idx.meta.length;
			const knnSpan = trace.span("vector_knn", "general", {
				top_k: articleTopK,
				vectors_count: vectorsCount,
				model: this.modelKey,
			});
			const articles: VectorSearchResult[] = await vectorSearchPooled(
				embedding,
				idx.meta,
				idx.vectors,
				idx.dims,
				articleTopK,
			);
			const searchMs = performance.now() - searchStart;
			knnSpan.end({
				top_k: articleTopK,
				results: articles.length,
				vectors_count: vectorsCount,
				latency_ms: Math.round(searchMs),
			});

			// 4. Aggregate article scores → norm scores. `sum` only counts articles
			// above SUM_POOL_THRESHOLD so weak tail doesn't dilute the signal.
			const poolStart = performance.now();
			const normScores = new Map<
				string,
				{ sum: number; max: number; n: number }
			>();
			for (const a of articles) {
				const sumContrib = a.score >= SUM_POOL_THRESHOLD ? a.score : 0;
				const cur = normScores.get(a.normId);
				if (cur) {
					cur.sum += sumContrib;
					cur.n += 1;
					if (a.score > cur.max) cur.max = a.score;
				} else {
					normScores.set(a.normId, {
						sum: sumContrib,
						max: a.score,
						n: 1,
					});
				}
			}

			const nNormsUnique = normScores.size;
			const allMaxScores = [...normScores.values()].map((s) => s.max);
			const maxScore = allMaxScores.length > 0 ? Math.max(...allMaxScores) : 0;
			const aboveThreshold = [...normScores.values()].filter(
				(s) => s.sum > 0,
			).length;

			const poolSpan = trace.span("aggregate_pool", "general", {
				strategy: pool,
				sum_pool_threshold: SUM_POOL_THRESHOLD,
				n_articles: articles.length,
			});

			// Optional per-norm rank boost. Single batched query — candidate set is
			// at most articleTopK distinct norms (typically <100).
			let boosts: Map<string, number> | null = null;
			if (boostByRank && normScores.size > 0) {
				const ids = [...normScores.keys()];
				const ph = ids.map(() => "?").join(",");
				const rows = this.db
					.query<{ id: string; rank: string; jurisdiction: string }, string[]>(
						`SELECT id, rank, jurisdiction FROM norms WHERE id IN (${ph})`,
					)
					.all(...ids);
				boosts = new Map();
				for (const r of rows) {
					boosts.set(r.id, rankFactor(r.rank ?? "", r.jurisdiction ?? ""));
				}
			}
			const boostFor = (id: string): number => boosts?.get(id) ?? 1;

			const vectorMaxRanked: RankedItem[] = [...normScores.entries()]
				.map(([normId, s]) => ({
					key: normId,
					score: (pool === "mean" ? s.sum / s.n : s.max) * boostFor(normId),
				}))
				.sort((a, b) => b.score - a.score);

			const vectorSumRanked: RankedItem[] | null =
				pool === "max+sum"
					? [...normScores.entries()]
							.map(([normId, s]) => ({
								key: normId,
								score: s.sum * boostFor(normId),
							}))
							.sort((a, b) => b.score - a.score)
					: null;

			const poolMs = performance.now() - poolStart;
			poolSpan.end({
				n_norms_unique: nNormsUnique,
				max_score: maxScore,
				sum_above_threshold: aboveThreshold,
				latency_ms: Math.round(poolMs),
			});

			// 5. Fuse.
			const fusionStart = performance.now();
			const nLists = vectorSumRanked ? 3 : 2;
			const fusionSpan = trace.span("rrf_fusion", "general", {
				n_lists: nLists,
				rrf_k: rrfK,
				top_k_out: normTopK,
			});
			const lists = new Map<string, RankedItem[]>();
			lists.set("bm25", bm25Ranked);
			lists.set("vector_max", vectorMaxRanked);
			if (vectorSumRanked) lists.set("vector_sum", vectorSumRanked);
			const fused = reciprocalRankFusion(lists, rrfK, normTopK);
			const fusionMs = performance.now() - fusionStart;
			fusionSpan.end({
				n_lists: nLists,
				top_k_out: fused.length,
				latency_ms: Math.round(fusionMs),
			});

			trace.end({
				fused_count: fused.length,
				bm25_count: bm25Ranked.length,
				vector_count: vectorMaxRanked.length,
				cache_hit: cacheHit,
				latency_ms: Math.round(embedMs + searchMs),
			});

			return {
				fused: fused.map((r) => r.key),
				bm25Count: bm25Ranked.length,
				vectorCount: vectorMaxRanked.length,
				embeddingCacheHit: cacheHit,
				embedMs,
				searchMs,
			};
		} catch (err) {
			trace.end({
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	}
}
