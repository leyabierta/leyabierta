/**
 * Process-wide singleton for the flat binary vector index.
 *
 * Both `RagPipeline` (used by `/v1/ask`) and `HybridSearcherImpl` (used by
 * `/v1/laws` hybrid mode) need the same `vectors-int8.bin` mapped into RAM.
 * Before this singleton each owned its own private cache and the file got
 * loaded twice on the first request that hit a path the other had not warmed
 * up yet — adding ~5s to the first `/v1/ask` after a `/v1/laws` call.
 *
 * The single in-flight promise also dedupes concurrent first-callers so
 * parallel cold requests can't trigger two parallel loads.
 *
 * Circuit breaker (Issue #57): if `ensureVectorIndex` fails MAX_FAILURES times
 * in a row the singleton stops retrying for COOLDOWN_MS and returns null.
 * Callers that check for null degrade gracefully (BM25-only); callers that
 * throw on null (HybridSearcher.getVectorIndex) propagate a single clear error
 * rather than hammering the filesystem/DB on every request.
 */
import type { Database } from "bun:sqlite";
import { ensureVectorIndex } from "./embeddings.ts";

type VectorIndex = Awaited<ReturnType<typeof ensureVectorIndex>>;

/** Consecutive failures before entering the open (blocking) state. */
const MAX_FAILURES = 3;
/** How long to wait after MAX_FAILURES before retrying (ms). */
const COOLDOWN_MS = 60_000;

let cached: VectorIndex = null;
let inflight: Promise<VectorIndex> | null = null;
let loadedModelKey: string | null = null;
let loadedDataDir: string | null = null;

// Circuit-breaker state.
let consecutiveFailures = 0;
let openUntil = 0; // epoch ms; 0 = closed (normal operation)

export async function getSharedVectorIndex(
	db: Database,
	modelKey: string,
	dataDir: string,
): Promise<VectorIndex> {
	if (cached) {
		if (
			process.env.NODE_ENV !== "production" &&
			(modelKey !== loadedModelKey || dataDir !== loadedDataDir)
		) {
			console.warn(
				`[vector-index-singleton] cache hit ignores divergent params: ` +
					`requested modelKey="${modelKey}" dataDir="${dataDir}", ` +
					`cached modelKey="${loadedModelKey}" dataDir="${loadedDataDir}". ` +
					`Returning cached index regardless.`,
			);
		}
		return cached;
	}

	// Circuit breaker — open state: refuse to retry until cooldown expires.
	if (openUntil > 0 && Date.now() < openUntil) {
		const remainS = Math.ceil((openUntil - Date.now()) / 1000);
		console.warn(
			`[vector-index-singleton] circuit open — skipping load (retry in ${remainS}s)`,
		);
		return null;
	}

	if (!inflight) {
		inflight = ensureVectorIndex(db, modelKey, dataDir)
			.then((idx) => {
				cached = idx;
				loadedModelKey = modelKey;
				loadedDataDir = dataDir;
				// Reset circuit breaker on success.
				consecutiveFailures = 0;
				openUntil = 0;
				return idx;
			})
			.catch((err) => {
				inflight = null;
				consecutiveFailures += 1;
				if (consecutiveFailures >= MAX_FAILURES) {
					openUntil = Date.now() + COOLDOWN_MS;
					console.error(
						`[vector-index-singleton] ${consecutiveFailures} consecutive failures — ` +
							`circuit open for ${COOLDOWN_MS / 1000}s. Last error: ${err instanceof Error ? err.message : String(err)}`,
					);
				} else {
					console.warn(
						`[vector-index-singleton] load failed (attempt ${consecutiveFailures}/${MAX_FAILURES}): ` +
							`${err instanceof Error ? err.message : String(err)}`,
					);
				}
				throw err;
			});
	}
	return inflight;
}

/** Test-only: drop the cached index so unit tests can force a fresh load. */
export function _resetSharedVectorIndexForTests(): void {
	cached = null;
	inflight = null;
	loadedModelKey = null;
	loadedDataDir = null;
	consecutiveFailures = 0;
	openUntil = 0;
}
