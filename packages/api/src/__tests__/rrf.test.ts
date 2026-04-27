/**
 * Unit tests for Reciprocal Rank Fusion (RRF).
 *
 * Pure function — no I/O. Verifies the fusion math and the source-tracking
 * metadata (which system contributed each result, and at what rank).
 */

import { describe, expect, it } from "bun:test";
import { type RankedItem, reciprocalRankFusion } from "../services/rag/rrf.ts";

describe("reciprocalRankFusion", () => {
	it("empty input returns empty list", () => {
		const result = reciprocalRankFusion(new Map());
		expect(result).toEqual([]);
	});

	it("single list returns items in the same order", () => {
		const lists = new Map<string, RankedItem[]>([
			[
				"bm25",
				[
					{ key: "a", score: 10 },
					{ key: "b", score: 5 },
					{ key: "c", score: 1 },
				],
			],
		]);
		const result = reciprocalRankFusion(lists);
		expect(result.map((r) => r.key)).toEqual(["a", "b", "c"]);
		// RRF score for rank 1 with k=60 is 1/61.
		expect(result[0]!.rrfScore).toBeCloseTo(1 / 61, 10);
		expect(result[1]!.rrfScore).toBeCloseTo(1 / 62, 10);
	});

	it("agreeing lists boost shared items above singletons", () => {
		const lists = new Map<string, RankedItem[]>([
			[
				"bm25",
				[
					{ key: "a", score: 10 },
					{ key: "x", score: 8 },
				],
			],
			[
				"vector",
				[
					{ key: "a", score: 0.9 },
					{ key: "y", score: 0.8 },
				],
			],
		]);
		const result = reciprocalRankFusion(lists);
		// "a" appears in both lists at rank 1 → 2/61, while x and y each
		// only get 1/62. So "a" must win.
		expect(result[0]!.key).toBe("a");
		expect(result[0]!.rrfScore).toBeCloseTo(2 / 61, 10);
		expect(result[0]!.sources).toHaveLength(2);
	});

	it("respects topK cap", () => {
		const lists = new Map<string, RankedItem[]>([
			[
				"bm25",
				Array.from({ length: 100 }, (_, i) => ({
					key: `k${i}`,
					score: 100 - i,
				})),
			],
		]);
		const result = reciprocalRankFusion(lists, 60, 5);
		expect(result).toHaveLength(5);
		expect(result[0]!.key).toBe("k0");
	});

	it("RRF k constant reduces the magnitude of rank-1 contributions", () => {
		const lists = new Map<string, RankedItem[]>([
			["bm25", [{ key: "a", score: 1 }]],
		]);
		const k60 = reciprocalRankFusion(lists, 60);
		const k0 = reciprocalRankFusion(lists, 0);
		// With k=0 the rank-1 contribution is 1; with k=60 it's 1/61.
		expect(k0[0]!.rrfScore).toBeCloseTo(1, 10);
		expect(k60[0]!.rrfScore).toBeCloseTo(1 / 61, 10);
	});

	it("disagreeing lists interleave by rank position", () => {
		// BM25 likes a > b; vector likes b > a. With equal weights and
		// k=60, both end up tied → RRF score 1/61 + 1/62 each.
		const lists = new Map<string, RankedItem[]>([
			[
				"bm25",
				[
					{ key: "a", score: 10 },
					{ key: "b", score: 5 },
				],
			],
			[
				"vector",
				[
					{ key: "b", score: 0.9 },
					{ key: "a", score: 0.5 },
				],
			],
		]);
		const result = reciprocalRankFusion(lists);
		expect(result).toHaveLength(2);
		expect(result[0]!.rrfScore).toBeCloseTo(1 / 61 + 1 / 62, 10);
		expect(result[1]!.rrfScore).toBeCloseTo(1 / 61 + 1 / 62, 10);
	});

	it("tracks per-system source rank and original score", () => {
		const lists = new Map<string, RankedItem[]>([
			["bm25", [{ key: "x", score: 12.5 }]],
			[
				"vector",
				[
					{ key: "z", score: 0.9 },
					{ key: "x", score: 0.7 },
				],
			],
		]);
		const result = reciprocalRankFusion(lists);
		const x = result.find((r) => r.key === "x")!;
		expect(x.sources).toHaveLength(2);
		const bm25Source = x.sources.find((s) => s.system === "bm25")!;
		const vecSource = x.sources.find((s) => s.system === "vector")!;
		expect(bm25Source.rank).toBe(1);
		expect(bm25Source.originalScore).toBe(12.5);
		expect(vecSource.rank).toBe(2);
		expect(vecSource.originalScore).toBe(0.7);
	});
});
