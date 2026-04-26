/**
 * Parity test: native SIMD cosine_topk vs JS vectorSearchInMemory.
 *
 * Builds a synthetic corpus (small N, modest dim) and asserts that for
 * a battery of random queries, the native top-K is the same set as the
 * JS top-K and the scores agree within a tight epsilon (FMA + reduction
 * order differ from scalar accumulation, so exact equality is too strict).
 */

import { describe, expect, test } from "bun:test";
import {
	type InMemoryVectorIndex,
	vectorSearchInMemory,
} from "../services/rag/embeddings.ts";
import {
	simdAvailable,
	vectorSearchSIMD,
} from "../services/rag/vector-simd.ts";

const N = 1024;
const DIMS = 128;
const TOP_K = 10;
const SCORE_EPS = 1e-4;

function makeIndex(seed: number): {
	meta: Array<{ normId: string; blockId: string }>;
	index: InMemoryVectorIndex;
} {
	// Deterministic PRNG (xorshift32) so failures reproduce.
	let s = seed | 0 || 1;
	const rnd = () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		// Map to roughly [-1, 1)
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

	const index: InMemoryVectorIndex = {
		chunks: [vectors],
		vectorsPerChunk: [N],
		normsPerChunk: [norms],
		totalVectors: N,
	};
	return { meta, index };
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

describe("vectorSearchSIMD parity", () => {
	test.skipIf(!simdAvailable())(
		"matches JS top-K set and scores within epsilon",
		() => {
			const { meta, index } = makeIndex(0xc0ffee);

			for (let trial = 0; trial < 20; trial++) {
				const q = makeQuery(0xa11ce + trial);
				const jsRes = vectorSearchInMemory(q, meta, index, DIMS, TOP_K);
				const simdRes = vectorSearchSIMD(q, meta, index, DIMS, TOP_K);

				expect(simdRes.length).toBe(jsRes.length);

				const jsKeys = jsRes.map((r) => `${r.normId}:${r.blockId}`).sort();
				const simdKeys = simdRes.map((r) => `${r.normId}:${r.blockId}`).sort();
				expect(simdKeys).toEqual(jsKeys);

				// Score-by-key parity within epsilon
				const jsScores = new Map(
					jsRes.map((r) => [`${r.normId}:${r.blockId}`, r.score]),
				);
				for (const r of simdRes) {
					const expected = jsScores.get(`${r.normId}:${r.blockId}`)!;
					expect(Math.abs(r.score - expected)).toBeLessThan(SCORE_EPS);
				}
			}
		},
	);

	test("simdAvailable() returns boolean", () => {
		expect(typeof simdAvailable()).toBe("boolean");
	});
});
