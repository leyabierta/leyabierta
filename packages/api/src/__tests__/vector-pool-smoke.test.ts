/**
 * Smoke test for the vector worker pool.
 *
 * Spawns a small pool against a synthetic in-memory index and verifies:
 *   - The pool initializes (workers respond ready).
 *   - Queries dispatched in parallel resolve with correct top-K.
 *   - Results match vectorSearchInMemory within score epsilon.
 *
 * Skipped if the native lib isn't available on the host (e.g. CI matrix
 * without gcc + AVX2). Parity is the contract; throughput we measure
 * separately on the production corpus.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	type InMemoryVectorIndex,
	vectorSearchInMemory,
} from "../services/rag/embeddings.ts";
import {
	shutdownVectorPool,
	vectorSearchPooled,
} from "../services/rag/vector-pool.ts";
import { simdAvailable } from "../services/rag/vector-simd.ts";

const N = 512;
const DIMS = 64;
const TOP_K = 8;
const SCORE_EPS = 1e-4;

function makeIndex(seed: number): {
	meta: Array<{ normId: string; blockId: string }>;
	index: InMemoryVectorIndex;
} {
	let s = seed | 0 || 1;
	const rnd = () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return ((s | 0) / 0x80000000) * 1.0;
	};

	const vectors = new Float32Array(N * DIMS);
	for (let i = 0; i < vectors.length; i++) vectors[i] = rnd();

	const norms = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		let sum = 0;
		const off = i * DIMS;
		for (let j = 0; j < DIMS; j++) sum += vectors[off + j]! * vectors[off + j]!;
		norms[i] = Math.sqrt(sum);
	}

	const meta = Array.from({ length: N }, (_, i) => ({
		normId: `N${i}`,
		blockId: `b${i}`,
	}));

	return {
		meta,
		index: {
			chunks: [vectors],
			vectorsPerChunk: [N],
			normsPerChunk: [norms],
			totalVectors: N,
		},
	};
}

function makeQuery(seed: number): Float32Array {
	let s = seed | 0 || 7;
	const q = new Float32Array(DIMS);
	for (let i = 0; i < DIMS; i++) {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		q[i] = ((s | 0) / 0x80000000) * 1.0;
	}
	return q;
}

afterAll(() => shutdownVectorPool());

describe("vectorSearchPooled smoke", () => {
	test.skipIf(!simdAvailable())(
		"matches in-process top-K, supports concurrent queries",
		async () => {
			const { meta, index } = makeIndex(0xbeef);
			const queries = Array.from({ length: 6 }, (_, i) => makeQuery(0x100 + i));

			// Run all 6 in parallel — pool must serialize internally.
			const pooledAll = await Promise.all(
				queries.map((q) =>
					vectorSearchPooled(q, meta, index, DIMS, TOP_K, {
						workerCount: 2,
					}),
				),
			);

			for (let qi = 0; qi < queries.length; qi++) {
				const ref = vectorSearchInMemory(
					queries[qi]!,
					meta,
					index,
					DIMS,
					TOP_K,
				);
				const got = pooledAll[qi]!;
				expect(got.length).toBe(ref.length);
				const refKeys = ref.map((r) => `${r.normId}:${r.blockId}`).sort();
				const gotKeys = got.map((r) => `${r.normId}:${r.blockId}`).sort();
				expect(gotKeys).toEqual(refKeys);
				const refScores = new Map(
					ref.map((r) => [`${r.normId}:${r.blockId}`, r.score] as const),
				);
				for (const r of got) {
					const expected = refScores.get(`${r.normId}:${r.blockId}`)!;
					expect(Math.abs(r.score - expected)).toBeLessThan(SCORE_EPS);
				}
			}
		},
		20000,
	);

	test("simdAvailable() exposes a boolean", () => {
		expect(typeof simdAvailable()).toBe("boolean");
	});
});
