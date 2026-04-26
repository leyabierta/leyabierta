/**
 * Retrieval core — shared between `ask()` (non-streaming) and `askStream()`.
 *
 * Sprint 3 collapses the two near-identical retrieval blocks that previously
 * lived inline in pipeline.ts into a single `runRetrievalCore`. It also
 * implements Plan C: vector + BM25 dispatched concurrently with `Promise.all`.
 * The historical "BM25 first" cache-locality argument no longer applies —
 * the worker pool owns its own SQLite handles and does not share a page
 * cache with the main thread.
 *
 * This module owns:
 *   - `runRetrievalCore` — analyze → embed → vector || bm25 → fuse → rerank
 *   - `computeBoosts` — per-norm rank/jurisdiction/age/omnibus/family signals
 *   - `applyLegalHierarchyBoost` — post-rerank protection of fundamental laws
 *   - `articleTypePenalty` — disposiciones transitorias / derogatorias / etc.
 *   - `getArticleData` — DB hydration of fused candidates (incl. sub-chunk)
 */

import type { Database } from "bun:sqlite";
import type { AnalyzedQuery } from "./analyzer.ts";
import {
	analyzeQuery,
	describeNormScope,
	isFundamentalRank,
	isModifierNorm,
	isSectoralNorm,
	normalizePeriodicTitle,
} from "./analyzer.ts";
import {
	bm25HitsToRanked,
	dispatchBm25Stages,
	RERANK_POOL_SIZE,
} from "./bm25-dispatch.ts";
import type { InMemoryVectorIndex } from "./embeddings.ts";
import { embedQuery } from "./embeddings.ts";
import { resolveJurisdiction } from "./jurisdiction.ts";
import { type RerankerCandidate, rerank } from "./reranker.ts";
import { type RankedItem, reciprocalRankFusion } from "./rrf.ts";
import {
	parseSubchunkId,
	type SubChunk,
	splitByApartados,
} from "./subchunk.ts";
import type { RagTrace } from "./tracing.ts";
import { vectorSearchPooled } from "./vector-pool.ts";

// ── Tunables ──

export const TOP_K = 15;
export const RRF_K = 60;
export const MIN_SIMILARITY = 0.35;
export const LOW_CONFIDENCE_THRESHOLD = 0.38;
export const EMBEDDING_MODEL_KEY = "gemini-embedding-2";

// ── Types ──

export type RetrievedArticle = {
	normId: string;
	blockId: string;
	normTitle: string;
	rank: string;
	sourceUrl: string;
	publishedAt: string;
	updatedAt: string;
	status: string;
	blockTitle: string;
	text: string;
	citizenSummary?: string;
};

export type RetrievalCost = {
	analyze: number;
	embedding: number;
};

export type RetrievalTokens = {
	analyzeIn: number;
	analyzeOut: number;
	embedding: number;
};

export type RetrievalEarly = {
	type: "early";
	reason: "non_legal" | "no_articles" | "low_confidence";
	bestScore: number;
	cost: RetrievalCost;
	tokens: RetrievalTokens;
	analyzed: AnalyzedQuery;
};

export type RetrievalReady = {
	type: "ready";
	articles: RetrievedArticle[];
	allFusedArticles: RetrievedArticle[];
	bestScore: number;
	useTemporal: boolean;
	rerankerBackend: string;
	analyzed: AnalyzedQuery;
	cost: RetrievalCost;
	tokens: RetrievalTokens;
};

export type RetrievalResult = RetrievalEarly | RetrievalReady;

// ── Article-type penalty ──

/** Penalty for article type based on block_id prefix.
 *  Disposiciones transitorias are time-limited by definition — they describe
 *  transitional rollout periods that expire. Disposiciones derogatorias only
 *  repeal other provisions. Regular artículos (a*) get no penalty. */
export function articleTypePenalty(blockId: string): number {
	const id = blockId.toLowerCase();
	if (id.startsWith("dt") || id.startsWith("disptrans")) return 0.3;
	if (
		id.startsWith("dd") ||
		id.startsWith("dder") ||
		id.startsWith("dispderog")
	)
		return 0.1;
	if (id.startsWith("df") || id.startsWith("dispfinal")) return 0.5;
	if (id.startsWith("da") || id.startsWith("dispad")) return 0.7;
	return 1.0;
}

// ── Boosts ──

export function computeBoosts(
	db: Database,
	allNormIds: string[],
	allRetrievedKeys: Set<string>,
	queryJurisdiction: string | null,
	isTemporal = false,
): {
	recencyRanked: RankedItem[];
	normBoostMap: Map<string, number>;
} {
	if (allNormIds.length === 0) {
		return { recencyRanked: [], normBoostMap: new Map() };
	}

	const placeholders = allNormIds.map(() => "?").join(",");
	const normRows = db
		.query<
			{
				norm_id: string;
				published_at: string;
				updated_at: string;
				rank: string;
				source_url: string;
				title: string;
			},
			string[]
		>(
			`SELECT id as norm_id, published_at, updated_at, rank, source_url, title FROM norms WHERE id IN (${placeholders}) ORDER BY updated_at DESC`,
		)
		.all(...allNormIds);

	const normRecencyRank = new Map(normRows.map((r, i) => [r.norm_id, i + 1]));
	const recencyRanked = [...allRetrievedKeys]
		.map((key) => {
			const normId = key.split(":")[0]!;
			const rank = normRecencyRank.get(normId) ?? allNormIds.length;
			return { key, score: 1 / rank };
		})
		.sort((a, b) => b.score - a.score);

	const RANK_WEIGHTS: Record<string, number> = {
		constitucion: 1.0,
		ley_organica: 0.9,
		ley: 0.8,
		real_decreto_ley: 0.8,
		real_decreto_legislativo: 0.8,
		real_decreto: 0.5,
		decreto: 0.5,
		orden: 0.3,
		circular: 0.2,
		instruccion: 0.2,
		resolucion: 0.2,
		reglamento: 0.2,
		acuerdo_internacional: 0.4,
	};

	const normBoostMap = new Map<string, number>();
	for (const row of normRows) {
		const rankWeight = RANK_WEIGHTS[row.rank] ?? 0.1;
		const jurisdiction = resolveJurisdiction(row.source_url, row.norm_id);

		let jurisdictionWeight: number;
		if (queryJurisdiction) {
			if (jurisdiction === queryJurisdiction) {
				jurisdictionWeight = 2.0;
			} else if (jurisdiction === "es") {
				jurisdictionWeight = 0.6;
			} else {
				jurisdictionWeight = 0.2;
			}
		} else {
			jurisdictionWeight = jurisdiction === "es" ? 1.0 : 0.5;
		}

		const isOmnibus = isModifierNorm(row.title);
		let omnibusWeight = 1.0;
		if (isOmnibus && !isTemporal) {
			const updatedAt = new Date(row.updated_at);
			const ageMs = Date.now() - updatedAt.getTime();
			const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
			if (ageYears > 2) {
				omnibusWeight = 0.02;
			} else if (ageYears > 1) {
				omnibusWeight = 0.08;
			} else {
				omnibusWeight = 0.15;
			}
		}

		let ageDecay = 1.0;
		if (!isFundamentalRank(row.rank) && !isTemporal) {
			const pubDate = new Date(row.published_at);
			const ageMs = Date.now() - pubDate.getTime();
			const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
			if (ageYears > 1) {
				ageDecay = 1 / (1 + ageYears / 5);
			}
		}

		normBoostMap.set(
			row.norm_id,
			rankWeight * jurisdictionWeight * omnibusWeight * ageDecay,
		);
	}

	if (allNormIds.length > 0 && !isTemporal) {
		const absorbedNorms = new Set(
			db
				.query<{ norm_id: string }, string[]>(
					`SELECT DISTINCT r.norm_id
				 FROM referencias r
				 JOIN norms n_target ON r.target_id = n_target.id
				 JOIN norms n_mod ON r.norm_id = n_mod.id
				 WHERE r.norm_id IN (${placeholders})
				   AND r.direction = 'anterior'
				   AND r.relation = 'MODIFICA'
				   AND n_target.updated_at > n_mod.published_at`,
				)
				.all(...allNormIds)
				.map((r) => r.norm_id),
		);

		for (const normId of absorbedNorms) {
			const current = normBoostMap.get(normId) ?? 1;
			normBoostMap.set(normId, current * 0.05);
		}
	}

	if (normRows.length > 1 && !isTemporal) {
		const normsByFamily = new Map<string, typeof normRows>();
		for (const row of normRows) {
			const familyKey = normalizePeriodicTitle(row.title);
			if (!familyKey) continue;
			const group = normsByFamily.get(familyKey) ?? [];
			group.push(row);
			normsByFamily.set(familyKey, group);
		}

		for (const [, family] of normsByFamily) {
			if (family.length < 2) continue;
			family.sort(
				(a, b) =>
					new Date(b.published_at).getTime() -
					new Date(a.published_at).getTime(),
			);
			for (let i = 1; i < family.length; i++) {
				const current = normBoostMap.get(family[i]!.norm_id) ?? 1;
				normBoostMap.set(family[i]!.norm_id, current * 0.02);
			}
		}
	}

	return { recencyRanked, normBoostMap };
}

// ── Hierarchy boost ──

export function applyLegalHierarchyBoost<
	T extends {
		normId: string;
		blockId: string;
		rank: string;
		sourceUrl: string;
		publishedAt?: string;
	},
>(reranked: T[], fullPool: T[], db?: Database): T[] {
	const rerankedKeys = new Set(reranked.map((a) => `${a.normId}:${a.blockId}`));

	const droppedFundamental = fullPool.filter((a) => {
		if (rerankedKeys.has(`${a.normId}:${a.blockId}`)) return false;
		const juris = resolveJurisdiction(a.sourceUrl, a.normId);
		if (articleTypePenalty(a.blockId) < 1.0) return false;
		return isFundamentalRank(a.rank) && juris === "es";
	});

	if (droppedFundamental.length === 0) return reranked;

	const result = [...reranked];
	let swapCount = 0;

	const recentNormIds = new Set<string>();
	if (db) {
		const RECENT_YEARS = 3;
		const cutoff = new Date();
		cutoff.setFullYear(cutoff.getFullYear() - RECENT_YEARS);
		const cutoffStr = cutoff.toISOString().slice(0, 10);
		for (const a of reranked) {
			const norm = db
				.query<{ published_at: string }, [string]>(
					"SELECT published_at FROM norms WHERE id = ?",
				)
				.get(a.normId);
			if (norm && norm.published_at >= cutoffStr) {
				recentNormIds.add(a.normId);
			}
		}
	}

	for (const fundamental of droppedFundamental) {
		let swapIdx = -1;
		for (let i = result.length - 1; i >= 0; i--) {
			const a = result[i]!;
			if (recentNormIds.has(a.normId)) continue;
			const juris = resolveJurisdiction(a.sourceUrl, a.normId);
			if (isSectoralNorm(a.rank) || juris !== "es") {
				swapIdx = i;
				break;
			}
		}

		if (swapIdx === -1) break;

		const swapped = result[swapIdx]!;
		console.log(
			`[hierarchy-boost] Swapping out ${swapped.normId}:${swapped.blockId} (${swapped.rank}) for ${fundamental.normId}:${fundamental.blockId} (${fundamental.rank})`,
		);
		result[swapIdx] = fundamental;
		swapCount++;

		if (swapCount >= 3) break;
	}

	return result;
}

// ── Article DB hydration ──

export function getArticleData(
	db: Database,
	results: Array<{ normId: string; blockId: string; score: number }>,
): RetrievedArticle[] {
	if (results.length === 0) return [];

	const subchunkMap = new Map<
		string,
		{ parentBlockId: string; apartado: number }
	>();

	for (const r of results) {
		const parsed = parseSubchunkId(r.blockId);
		if (parsed) {
			subchunkMap.set(`${r.normId}:${r.blockId}`, parsed);
		}
	}

	const normIds = [...new Set(results.map((r) => r.normId))];
	const placeholders = normIds.map(() => "?").join(",");
	const blockKeys = new Set(
		results.map((r) => {
			const parsed = parseSubchunkId(r.blockId);
			return parsed
				? `${r.normId}:${parsed.parentBlockId}`
				: `${r.normId}:${r.blockId}`;
		}),
	);

	const dbArticles = db
		.query<
			{
				norm_id: string;
				title: string;
				rank: string;
				source_url: string;
				published_at: string;
				updated_at: string;
				status: string;
				block_id: string;
				block_title: string;
				current_text: string;
				citizen_summary: string | null;
			},
			string[]
		>(
			`SELECT b.norm_id, n.title, n.rank, n.source_url, n.published_at, n.updated_at, n.status,
                b.block_id, b.title as block_title,
                b.current_text, cas.summary as citizen_summary
         FROM blocks b
         JOIN norms n ON n.id = b.norm_id
         LEFT JOIN citizen_article_summaries cas
           ON cas.norm_id = b.norm_id AND cas.block_id = b.block_id
         WHERE b.norm_id IN (${placeholders})
           AND b.block_type = 'precepto'
           AND b.current_text != ''
           AND n.status != 'derogada'`,
		)
		.all(...normIds)
		.filter((a) => blockKeys.has(`${a.norm_id}:${a.block_id}`));

	const parentLookup = new Map(
		dbArticles.map((a) => [`${a.norm_id}:${a.block_id}`, a]),
	);

	const articles: RetrievedArticle[] = [];
	const seen = new Set<string>();
	const splitCache = new Map<string, SubChunk[] | null>();

	const sorted = [...results].sort((a, b) => b.score - a.score);

	for (const r of sorted) {
		const key = `${r.normId}:${r.blockId}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const sub = subchunkMap.get(key);
		if (sub) {
			const parent = parentLookup.get(`${r.normId}:${sub.parentBlockId}`);
			if (!parent) continue;

			const cacheKey = `${r.normId}:${sub.parentBlockId}`;
			let chunks = splitCache.get(cacheKey);
			if (chunks === undefined) {
				chunks = splitByApartados(
					sub.parentBlockId,
					parent.block_title,
					parent.current_text,
				);
				splitCache.set(cacheKey, chunks);
			}
			const chunk = chunks?.find((c) => c.apartado === sub.apartado);
			if (chunk) {
				articles.push({
					normId: r.normId,
					blockId: r.blockId,
					normTitle: parent.title,
					rank: parent.rank,
					sourceUrl: parent.source_url,
					publishedAt: parent.published_at,
					updatedAt: parent.updated_at,
					status: parent.status,
					blockTitle: chunk.title,
					text: chunk.text,
					citizenSummary: parent.citizen_summary ?? undefined,
				});
			}
		} else {
			const a = parentLookup.get(key);
			if (a) {
				articles.push({
					normId: a.norm_id,
					blockId: a.block_id,
					normTitle: a.title,
					rank: a.rank,
					sourceUrl: a.source_url,
					publishedAt: a.published_at,
					updatedAt: a.updated_at,
					status: a.status,
					blockTitle: a.block_title,
					text: a.current_text,
					citizenSummary: a.citizen_summary ?? undefined,
				});
			}
		}
	}

	return articles;
}

// ── Core retrieval ──

const ANCHOR_RANKS = new Set([
	"ley",
	"ley_organica",
	"real_decreto_legislativo",
	"codigo",
	"constitucion",
]);

export type RunRetrievalCoreOpts = {
	db: Database;
	apiKey: string;
	cohereApiKey: string | null;
	question: string;
	requestJurisdiction?: string;
	embeddedNormIds: string[];
	vectorIndex: {
		meta: Array<{ normId: string; blockId: string }>;
		vectors: InMemoryVectorIndex;
		dims: number;
	} | null;
	trace?: RagTrace;
};

/**
 * Shared retrieval pipeline: query analysis → vector || BM25 (concurrent)
 * → density / recency / hierarchy boosts → RRF fusion → reranker
 * → hierarchy-boost post-rerank.
 *
 * Plan C (Sprint 3): vector and BM25 dispatch run inside a single
 * `Promise.all` — workers no longer share a page cache with the main
 * thread, so the historical "BM25 first" ordering is obsolete.
 */
export async function runRetrievalCore(
	opts: RunRetrievalCoreOpts,
): Promise<RetrievalResult> {
	const {
		db,
		apiKey,
		cohereApiKey,
		question,
		requestJurisdiction,
		embeddedNormIds,
		vectorIndex,
		trace,
	} = opts;

	// 1. Analyze + embed query in parallel.
	const analysisSpan = trace?.span("query-analysis", "llm", { question });
	const [analysisResult, queryResult] = await Promise.all([
		analyzeQuery(apiKey, question),
		embedQuery(apiKey, EMBEDDING_MODEL_KEY, question),
	]);
	const analyzed = analysisResult.query;
	if (requestJurisdiction && !analyzed.jurisdiction) {
		analyzed.jurisdiction = requestJurisdiction;
	}
	analysisSpan?.end(
		{
			keywords: analyzed.keywords,
			materias: analyzed.materias,
			temporal: analyzed.temporal,
			nonLegal: analyzed.nonLegal,
			jurisdiction: analyzed.jurisdiction,
		},
		{
			analyzerCost: `$${analysisResult.cost.toFixed(8)}`,
			analyzerTokensIn: analysisResult.tokensIn,
			analyzerTokensOut: analysisResult.tokensOut,
			embeddingCost: `$${queryResult.cost.toFixed(8)}`,
			embeddingTokens: queryResult.tokens,
		},
	);

	if (analyzed.legalSynonyms.length > 0) {
		console.log(
			`[rag] keywords=${JSON.stringify(analyzed.keywords)} synonyms=${JSON.stringify(analyzed.legalSynonyms)}`,
		);
	}

	const cost: RetrievalCost = {
		analyze: analysisResult.cost,
		embedding: queryResult.cost,
	};
	const tokens: RetrievalTokens = {
		analyzeIn: analysisResult.tokensIn,
		analyzeOut: analysisResult.tokensOut,
		embedding: queryResult.tokens,
	};

	if (analyzed.nonLegal) {
		return {
			type: "early",
			reason: "non_legal",
			bestScore: 0,
			cost,
			tokens,
			analyzed,
		};
	}

	// 2. Concurrent vector + BM25 dispatch (Plan C).
	const bm25Span = trace?.span("bm25-search", "tool", {
		mainKeywords: analyzed.keywords,
		hasSynonyms: analyzed.legalSynonyms.length > 0,
		hasNormNameHint: !!analyzed.normNameHint,
		poolSize: RERANK_POOL_SIZE,
	});
	const vectorSpan = trace?.span("vector-search", "tool", {
		poolSize: RERANK_POOL_SIZE,
		minSimilarity: MIN_SIMILARITY,
		embeddingDims: queryResult.embedding.length,
	});

	const bm25Start = Date.now();
	const vectorStart = Date.now();
	const bm25BreakT = performance.now();

	const [bm25Result, vectorResultsRaw] = await Promise.all([
		dispatchBm25Stages({
			db,
			question,
			analyzed,
			embeddingNormIds: embeddedNormIds,
			vectors: vectorIndex?.vectors ?? null,
		}),
		vectorIndex
			? vectorSearchPooled(
					queryResult.embedding,
					vectorIndex.meta,
					vectorIndex.vectors,
					vectorIndex.dims,
					RERANK_POOL_SIZE,
				)
			: Promise.resolve([]),
	]);

	const vectorResults = vectorResultsRaw.filter(
		(r) => r.score >= MIN_SIMILARITY,
	);

	const vectorRanked: RankedItem[] = vectorResults.map((r) => ({
		key: `${r.normId}:${r.blockId}`,
		score: r.score,
	}));
	const bm25Ranked = bm25HitsToRanked(bm25Result.main);
	const synonymBm25Ranked = bm25HitsToRanked(bm25Result.synonym);
	const namedLawRanked = bm25HitsToRanked(bm25Result.namedLaw);
	const coreLawRanked = bm25HitsToRanked(bm25Result.coreLaw);
	const recentBm25Ranked = bm25HitsToRanked(bm25Result.recent);

	console.log(
		`[bm25-breakdown] wall=${(performance.now() - bm25BreakT).toFixed(0)}ms (parallel) ${Object.entries(
			bm25Result.stageTimings,
		)
			.map(([k, v]) => `${k}=${v.toFixed(0)}ms`)
			.join(" ")}`,
	);

	bm25Span?.end(
		{
			mainHits: bm25Ranked.length,
			synonymHits: synonymBm25Ranked.length,
			namedLawHits: namedLawRanked.length,
			coreLawHits: coreLawRanked.length,
			recentHits: recentBm25Ranked.length,
		},
		{ durationMs: Date.now() - bm25Start },
	);
	vectorSpan?.end(
		{ hits: vectorResults.length, topScore: vectorResults[0]?.score ?? 0 },
		{ durationMs: Date.now() - vectorStart },
	);

	// 3. Collection density signal.
	const fusionSpan = trace?.span("rrf-fusion", "tool", { rrfK: RRF_K });
	const fusionStart = Date.now();
	let anchorsInjected = 0;

	const normDensity = new Map<string, number>();
	for (const r of vectorRanked) {
		const normId = r.key.split(":")[0]!;
		normDensity.set(normId, (normDensity.get(normId) ?? 0) + r.score);
	}
	for (const r of bm25Ranked) {
		const normId = r.key.split(":")[0]!;
		normDensity.set(normId, (normDensity.get(normId) ?? 0) + r.score);
	}
	const normsByDensity = [...normDensity.entries()].sort((a, b) => b[1] - a[1]);
	const normDensityRank = new Map(
		normsByDensity.map(([normId], i) => [normId, i + 1]),
	);
	const allArticleKeys = new Set([
		...vectorRanked.map((r) => r.key),
		...bm25Ranked.map((r) => r.key),
	]);
	const densityRanked: RankedItem[] = [...allArticleKeys].map((key) => {
		const normId = key.split(":")[0]!;
		const rank = normDensityRank.get(normId) ?? normsByDensity.length;
		return { key, score: 1 / rank };
	});

	// 4. Recency / per-norm boost map.
	const allRetrievedKeys = new Set([
		...allArticleKeys,
		...namedLawRanked.map((r) => r.key),
		...synonymBm25Ranked.map((r) => r.key),
		...coreLawRanked.map((r) => r.key),
		...recentBm25Ranked.map((r) => r.key),
	]);
	const allNormIds = [
		...new Set([...allRetrievedKeys].map((k) => k.split(":")[0]!)),
	];
	const { recencyRanked, normBoostMap } = computeBoosts(
		db,
		allNormIds,
		allRetrievedKeys,
		analyzed.jurisdiction,
		analyzed.temporal,
	);

	// 5. RRF fuse.
	const rrfSystems = new Map<string, RankedItem[]>([
		["vector", vectorRanked],
		["bm25", bm25Ranked],
		["collection-density", densityRanked],
	]);
	if (synonymBm25Ranked.length > 0)
		rrfSystems.set("legal-synonyms", synonymBm25Ranked);
	if (coreLawRanked.length > 0) rrfSystems.set("core-law", coreLawRanked);
	if (recentBm25Ranked.length > 0)
		rrfSystems.set("recent-bm25", recentBm25Ranked);
	if (recencyRanked.length > 0) rrfSystems.set("recency", recencyRanked);
	if (namedLawRanked.length > 0) rrfSystems.set("named-law", namedLawRanked);
	const rawFused = reciprocalRankFusion(rrfSystems, RRF_K, RERANK_POOL_SIZE);

	// 6. Apply norm rank + jurisdiction multiplier to RRF scores.
	const boosted = rawFused
		.map((r) => {
			const normId = r.key.split(":")[0]!;
			const boost = normBoostMap.get(normId) ?? 1.0;
			return { ...r, rrfScore: r.rrfScore * boost };
		})
		.sort((a, b) => b.rrfScore - a.rrfScore);

	// 7. Diversity penalty + article-type penalty.
	const normSeenCounts = new Map<string, number>();
	const fused = boosted
		.map((r) => {
			const normId = r.key.split(":")[0]!;
			const blockId = r.key.split(":")[1]!;
			const seen = normSeenCounts.get(normId) ?? 0;
			normSeenCounts.set(normId, seen + 1);
			const dp = seen === 0 ? 1.0 : seen === 1 ? 0.7 : seen === 2 ? 0.5 : 0.3;
			const typePenalty = articleTypePenalty(blockId);
			return { ...r, rrfScore: r.rrfScore * dp * typePenalty };
		})
		.sort((a, b) => b.rrfScore - a.rrfScore);

	// 8. Sub-chunk vs parent dedup.
	const subchunkParents = new Set<string>();
	for (const r of fused) {
		const parts = r.key.split(":");
		const parsed = parseSubchunkId(parts[1]!);
		if (parsed) subchunkParents.add(`${parts[0]}:${parsed.parentBlockId}`);
	}
	const deduped = fused.filter((r) => !subchunkParents.has(r.key));

	// 9. Anchor norm injection.
	const fusedKeySet = new Set(deduped.map((r) => r.key));
	const anchorCandidates = vectorResults
		.filter(
			(r) =>
				!fusedKeySet.has(`${r.normId}:${r.blockId}`) &&
				r.score >= MIN_SIMILARITY,
		)
		.slice(0, 20);

	if (anchorCandidates.length > 0) {
		const anchorNormIds = [...new Set(anchorCandidates.map((r) => r.normId))];
		const ph = anchorNormIds.map(() => "?").join(",");
		const normRanks = db
			.query<{ id: string; rank: string; source_url: string }, string[]>(
				`SELECT id, rank, source_url FROM norms WHERE id IN (${ph})`,
			)
			.all(...anchorNormIds);
		const stateGeneralNorms = new Set(
			normRanks
				.filter((n) => {
					const juris = resolveJurisdiction(n.source_url, n.id);
					return ANCHOR_RANKS.has(n.rank) && juris === "es";
				})
				.map((n) => n.id),
		);

		const anchors = anchorCandidates
			.filter((r) => stateGeneralNorms.has(r.normId))
			.slice(0, 3);

		for (const a of anchors) {
			deduped.push({
				key: `${a.normId}:${a.blockId}`,
				sources: [{ system: "anchor-norm", rank: 1, originalScore: a.score }],
				rrfScore: deduped[deduped.length - 1]?.rrfScore ?? 0,
			});
			anchorsInjected++;
		}
	}

	// 10. Hydrate article data.
	const fusedKeys = new Set(deduped.map((r) => r.key));
	const allFusedArticles = getArticleData(
		db,
		deduped.map((r) => {
			const parts = r.key.split(":");
			return { normId: parts[0]!, blockId: parts[1]!, score: r.rrfScore };
		}),
	).filter((a) => fusedKeys.has(`${a.normId}:${a.blockId}`));
	fusionSpan?.end(
		{
			fusedCandidates: deduped.length,
			articlesAfterGetData: allFusedArticles.length,
			subchunksRemoved: fused.length - (deduped.length - anchorsInjected),
			anchorsInjected,
			systemCount: rrfSystems.size,
			systems: [...rrfSystems.keys()],
		},
		{ durationMs: Date.now() - fusionStart },
	);

	// 11. Rerank to TOP_K.
	const rerankSpan = trace?.span("rerank", "tool", {
		inputCandidates: allFusedArticles.length,
		topK: TOP_K,
		backend: cohereApiKey ? "cohere" : "llm",
	});
	const rerankStart = Date.now();
	let articles: RetrievedArticle[];
	let rerankerBackend = "none";

	if (allFusedArticles.length > TOP_K) {
		const candidates: RerankerCandidate[] = allFusedArticles.map((a) => ({
			key: `${a.normId}:${a.blockId}`,
			title: `${a.blockTitle} — ${describeNormScope(a.rank, resolveJurisdiction(a.sourceUrl, a.normId))}: ${a.normTitle}`,
			text: a.text,
		}));
		const reranked = await rerank(question, candidates, TOP_K, {
			cohereApiKey: cohereApiKey ?? undefined,
			openrouterApiKey: apiKey,
		});
		rerankerBackend = reranked.backend;
		const rerankedKeys = new Set(reranked.results.map((r) => r.key));
		const rerankedOrder = new Map(reranked.results.map((r) => [r.key, r.rank]));
		articles = allFusedArticles
			.filter((a) => rerankedKeys.has(`${a.normId}:${a.blockId}`))
			.sort(
				(a, b) =>
					(rerankedOrder.get(`${a.normId}:${a.blockId}`) ?? 999) -
					(rerankedOrder.get(`${b.normId}:${b.blockId}`) ?? 999),
			);

		articles = applyLegalHierarchyBoost(articles, allFusedArticles, db);
	} else {
		articles = allFusedArticles;
	}
	rerankSpan?.end(
		{ finalArticleCount: articles.length, backend: rerankerBackend },
		{ durationMs: Date.now() - rerankStart },
	);

	const bestScore = vectorResults[0]?.score ?? 0;
	const useTemporal = analyzed.temporal;

	if (articles.length === 0) {
		return {
			type: "early",
			reason: "no_articles",
			bestScore,
			cost,
			tokens,
			analyzed,
		};
	}

	if (bestScore < LOW_CONFIDENCE_THRESHOLD) {
		return {
			type: "early",
			reason: "low_confidence",
			bestScore,
			cost,
			tokens,
			analyzed,
		};
	}

	return {
		type: "ready",
		articles,
		allFusedArticles,
		bestScore,
		useTemporal,
		rerankerBackend,
		analyzed,
		cost,
		tokens,
	};
}
