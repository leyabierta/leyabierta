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
 */
import type { Database } from "bun:sqlite";
import { ensureVectorIndex } from "./embeddings.ts";

type VectorIndex = Awaited<ReturnType<typeof ensureVectorIndex>>;

let cached: VectorIndex = null;
let inflight: Promise<VectorIndex> | null = null;

export async function getSharedVectorIndex(
	db: Database,
	modelKey: string,
	dataDir: string,
): Promise<VectorIndex> {
	if (cached) return cached;
	if (!inflight) {
		inflight = ensureVectorIndex(db, modelKey, dataDir)
			.then((idx) => {
				cached = idx;
				return idx;
			})
			.catch((err) => {
				inflight = null;
				throw err;
			});
	}
	return inflight;
}

/** Test-only: drop the cached index so unit tests can force a fresh load. */
export function _resetSharedVectorIndexForTests(): void {
	cached = null;
	inflight = null;
}
