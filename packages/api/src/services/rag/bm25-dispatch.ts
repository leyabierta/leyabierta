/**
 * BM25 stage dispatcher.
 *
 * Wraps the five FTS5 sub-queries (main / synonym / namedLaw / coreLaw / recent)
 * that historically lived inline in `pipeline.ts` (twice — `runBm25` and
 * `runBm252` — Sprint 3 closes the duplication). Each stage is dispatched to
 * the worker pool and falls back to the in-process synchronous implementation
 * on pool failure (busy / FFI crash / lib missing on this platform).
 *
 * Per-stage fallback resilience: one busy stage downgrading to sync does NOT
 * sink the other four. This was introduced in Sprint 2 and we preserve it.
 */

import type { Database } from "bun:sqlite";
import type { AnalyzedQuery } from "./analyzer.ts";
import { isFundamentalRank, resolveNormsByName } from "./analyzer.ts";
import { bm25HybridSearch } from "./blocks-fts.ts";
import type { InMemoryVectorIndex } from "./embeddings.ts";
import { resolveJurisdiction } from "./jurisdiction.ts";
import type { RankedItem } from "./rrf.ts";
import { bm25SearchPooled } from "./vector-pool.ts";

/**
 * Pool saturation counter. Every BM25 stage that gets `VECTOR_POOL_BUSY`
 * back from the pool falls through to the sync `bm25HybridSearch` (so
 * the request still succeeds), but the parallelism win disappears
 * silently. Logging every event would be noisy under load; instead we
 * count here and emit one summary log per BUSY_LOG_EVERY events plus
 * a warning whenever a stage actually falls back.
 */
let bm25PoolBusyCount = 0;
const BUSY_LOG_EVERY = 100;
function recordBm25PoolBusy() {
	bm25PoolBusyCount++;
	if (bm25PoolBusyCount % BUSY_LOG_EVERY === 0) {
		console.warn(
			`[bm25-pool] saturation: ${bm25PoolBusyCount} BUSY events since boot — pool may be undersized for current load`,
		);
	}
}

/**
 * Fundamental state laws — covers 90%+ of citizen questions. Used by the
 * "core law" BM25 stage to ensure foundational laws enter the pool when
 * the citizen's colloquial vocabulary doesn't match the formal legal text.
 */
export const CORE_NORMS = [
	"BOE-A-2015-11430", // Estatuto de los Trabajadores
	"BOE-A-1994-26003", // LAU
	"BOE-A-1978-31229", // Constitución Española
	"BOE-A-2015-11724", // LGSS
	"BOE-A-2007-20555", // TRLGDCU
	"BOE-A-2018-16673", // LOPDGDD
	"BOE-A-1889-4763", // Código Civil
];

export const RERANK_POOL_SIZE = 80;
const RECENT_YEARS = 3;

export type Bm25Hit = {
	normId: string;
	blockId: string;
	rank: number;
};

export type Bm25StageResult = {
	main: Bm25Hit[];
	synonym: Bm25Hit[];
	namedLaw: Bm25Hit[];
	coreLaw: Bm25Hit[];
	recent: Bm25Hit[];
	stageTimings: Record<string, number>;
};

/** Convert a raw BM25 hit list into RRF-ready ranked items (score = 1 / rank). */
export function bm25HitsToRanked(hits: Bm25Hit[]): RankedItem[] {
	return hits.map((r) => ({
		key: `${r.normId}:${r.blockId}`,
		score: 1 / r.rank,
	}));
}

/**
 * Dispatch all five BM25 stages concurrently against the worker pool, with
 * per-stage sync fallback. Returns the raw hit lists per stage plus a per-
 * stage timing map for log/trace consumers.
 */
export async function dispatchBm25Stages(opts: {
	db: Database;
	question: string;
	analyzed: AnalyzedQuery;
	embeddingNormIds: string[];
	vectors: InMemoryVectorIndex | null;
}): Promise<Bm25StageResult> {
	const { db, question, analyzed, embeddingNormIds, vectors } = opts;

	const synonymInputs =
		analyzed.legalSynonyms.length > 0
			? {
					query: analyzed.legalSynonyms.join(" "),
					keywords: analyzed.legalSynonyms,
				}
			: null;

	let namedLawInputs: {
		query: string;
		keywords: string[];
		filter: string[];
	} | null = null;
	if (analyzed.normNameHint) {
		let matchedNormIds = resolveNormsByName(
			db,
			analyzed.normNameHint,
			embeddingNormIds,
		);
		if (matchedNormIds.length > 5) {
			const ph = matchedNormIds.map(() => "?").join(",");
			const normInfos = db
				.query<{ id: string; rank: string; source_url: string }, string[]>(
					`SELECT id, rank, source_url FROM norms WHERE id IN (${ph})`,
				)
				.all(...matchedNormIds);
			const normInfoMap = new Map(normInfos.map((n) => [n.id, n]));
			const fundamentalMatches = matchedNormIds.filter((id) => {
				const norm = normInfoMap.get(id);
				if (!norm) return false;
				const juris = resolveJurisdiction(norm.source_url, id);
				return isFundamentalRank(norm.rank) && juris === "es";
			});
			if (fundamentalMatches.length > 0 && fundamentalMatches.length <= 5) {
				matchedNormIds = fundamentalMatches;
			}
		}
		if (matchedNormIds.length > 0 && matchedNormIds.length <= 5) {
			const allTerms = [...analyzed.keywords, ...analyzed.legalSynonyms];
			namedLawInputs = {
				query: allTerms.join(" "),
				keywords: allTerms,
				filter: matchedNormIds,
			};
		}
	}

	const coreLawInputs =
		analyzed.legalSynonyms.length > 0 && !analyzed.jurisdiction
			? (() => {
					const coreInStore = CORE_NORMS.filter((id) =>
						embeddingNormIds.includes(id),
					);
					return coreInStore.length > 0
						? {
								query: analyzed.legalSynonyms.join(" "),
								keywords: analyzed.legalSynonyms,
								filter: coreInStore,
							}
						: null;
				})()
			: null;

	let recentInputs: {
		query: string;
		keywords: string[];
		filter: string[];
	} | null = null;
	if (analyzed.keywords.length > 0) {
		const cutoff = new Date();
		cutoff.setFullYear(cutoff.getFullYear() - RECENT_YEARS);
		const cutoffStr = cutoff.toISOString().slice(0, 10);
		const recentNormIds = db
			.query<{ id: string }, [string]>(
				`SELECT id FROM norms
				 WHERE status = 'vigente'
				   AND published_at >= ?
				   AND id IN (SELECT DISTINCT norm_id FROM embeddings)`,
			)
			.all(cutoffStr)
			.map((r) => r.id);
		if (recentNormIds.length > 0) {
			const allTerms = [...analyzed.keywords, ...analyzed.legalSynonyms];
			recentInputs = {
				query: allTerms.join(" "),
				keywords: allTerms,
				filter: recentNormIds,
			};
		}
	}

	const stageTimings: Record<string, number> = {};
	const stageT = (k: string) => {
		const start = performance.now();
		return () => {
			stageTimings[k] = performance.now() - start;
		};
	};

	const runBm25 = async (
		query: string,
		keywords: string[],
		topK: number,
		filter?: string[],
	): Promise<Bm25Hit[]> => {
		if (vectors) {
			try {
				return await bm25SearchPooled(vectors, query, keywords, topK, filter);
			} catch (err) {
				const msg = (err as Error).message;
				if (msg === "VECTOR_POOL_BUSY") {
					recordBm25PoolBusy();
				} else {
					console.warn(`[bm25-pool] fallback to sync: ${msg}`);
				}
			}
		}
		return bm25HybridSearch(db, query, keywords, topK, filter);
	};

	const mainStop = stageT("main");
	const synonymStop = synonymInputs ? stageT("synonym") : () => {};
	const namedLawStop = namedLawInputs ? stageT("namedLaw") : () => {};
	const coreLawStop = coreLawInputs ? stageT("coreLaw") : () => {};
	const recentStop = recentInputs ? stageT("recent") : () => {};

	const [main, synonym, namedLaw, coreLaw, recent] = await Promise.all([
		runBm25(
			question,
			analyzed.keywords,
			RERANK_POOL_SIZE,
			embeddingNormIds,
		).then((r) => {
			mainStop();
			return r;
		}),
		synonymInputs
			? runBm25(
					synonymInputs.query,
					synonymInputs.keywords,
					RERANK_POOL_SIZE,
					embeddingNormIds,
				).then((r) => {
					synonymStop();
					return r;
				})
			: Promise.resolve([] as Bm25Hit[]),
		namedLawInputs
			? runBm25(
					namedLawInputs.query,
					namedLawInputs.keywords,
					Math.floor(RERANK_POOL_SIZE / 2),
					namedLawInputs.filter,
				).then((r) => {
					namedLawStop();
					return r;
				})
			: Promise.resolve([] as Bm25Hit[]),
		coreLawInputs
			? runBm25(
					coreLawInputs.query,
					coreLawInputs.keywords,
					Math.floor(RERANK_POOL_SIZE / 2),
					coreLawInputs.filter,
				).then((r) => {
					coreLawStop();
					return r;
				})
			: Promise.resolve([] as Bm25Hit[]),
		recentInputs
			? runBm25(
					recentInputs.query,
					recentInputs.keywords,
					Math.floor(RERANK_POOL_SIZE / 2),
					recentInputs.filter,
				).then((r) => {
					recentStop();
					return r;
				})
			: Promise.resolve([] as Bm25Hit[]),
	]);

	return { main, synonym, namedLaw, coreLaw, recent, stageTimings };
}
