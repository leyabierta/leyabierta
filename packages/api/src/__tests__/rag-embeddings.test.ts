/**
 * Tests for vectorSearch — pure cosine-similarity function.
 * No mocking needed: operates on Float32Arrays directly.
 */

import { describe, expect, test } from "bun:test";
import { type EmbeddingStore, vectorSearch } from "../services/rag/embeddings.ts";

function makeStore(
	articles: Array<{ normId: string; blockId: string }>,
	vectors: Float32Array,
	dimensions: number,
): EmbeddingStore {
	return {
		model: "test",
		dimensions,
		count: articles.length,
		articles,
		vectors,
		norms: null, // let vectorSearch compute norms on the fly
	};
}

describe("vectorSearch", () => {
	test("identical vectors produce score close to 1.0", () => {
		const vec = new Float32Array([1, 2, 3, 4]);
		const store = makeStore(
			[{ normId: "BOE-A-2024-001", blockId: "art1" }],
			new Float32Array([1, 2, 3, 4]),
			4,
		);

		const results = vectorSearch(vec, store, 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.score).toBeCloseTo(1.0, 5);
		expect(results[0]!.normId).toBe("BOE-A-2024-001");
	});

	test("orthogonal vectors produce score close to 0", () => {
		const query = new Float32Array([1, 0, 0, 0]);
		const store = makeStore(
			[{ normId: "BOE-A-2024-001", blockId: "art1" }],
			new Float32Array([0, 1, 0, 0]),
			4,
		);

		const results = vectorSearch(query, store, 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.score).toBeCloseTo(0, 5);
	});

	test("zero-length query embedding returns empty array", () => {
		const query = new Float32Array([0, 0, 0, 0]);
		const store = makeStore(
			[{ normId: "BOE-A-2024-001", blockId: "art1" }],
			new Float32Array([1, 2, 3, 4]),
			4,
		);

		const results = vectorSearch(query, store, 10);
		// queryNorm === 0 → early return with empty array
		expect(results).toHaveLength(0);
	});

	test("topK larger than store count returns all items", () => {
		const query = new Float32Array([1, 0]);
		const store = makeStore(
			[
				{ normId: "N1", blockId: "b1" },
				{ normId: "N2", blockId: "b2" },
			],
			new Float32Array([1, 0, 0, 1]),
			2,
		);

		const results = vectorSearch(query, store, 100);
		expect(results).toHaveLength(2);
	});

	test("empty store (count=0) returns empty array", () => {
		const query = new Float32Array([1, 2, 3]);
		const store = makeStore([], new Float32Array(0), 3);

		const results = vectorSearch(query, store, 10);
		expect(results).toHaveLength(0);
	});

	test("results are sorted by score descending", () => {
		const query = new Float32Array([1, 0, 0]);
		// Three vectors with different alignment to query
		const store = makeStore(
			[
				{ normId: "LOW", blockId: "b1" },
				{ normId: "HIGH", blockId: "b2" },
				{ normId: "MID", blockId: "b3" },
			],
			new Float32Array([
				0, 1, 0,    // LOW: orthogonal
				1, 0, 0,    // HIGH: identical direction
				0.5, 0.5, 0, // MID: partial overlap
			]),
			3,
		);

		const results = vectorSearch(query, store, 10);
		expect(results).toHaveLength(3);
		expect(results[0]!.normId).toBe("HIGH");
		expect(results[1]!.normId).toBe("MID");
		expect(results[2]!.normId).toBe("LOW");
		// Verify descending order
		for (let i = 1; i < results.length; i++) {
			expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
		}
	});
});
