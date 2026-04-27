/**
 * Unit tests for the reranker dataset → triplet converter (Fase 1b).
 *
 * The converter is pure (input pair → output triplets), so all tests run
 * against fixtures rather than the real dataset on disk.
 */

import { describe, expect, test } from "bun:test";
import {
	applyTruncation,
	pairToTriplets,
	type RerankerPair,
	truncatePassage,
} from "../../research/training/convert-reranker-data.ts";

function pair(over: Partial<RerankerPair> = {}): RerankerPair {
	return {
		id: "rkr-000001",
		query: "¿cuántos días libres me dan si me caso?",
		register: "informal",
		is_trap: false,
		positive: { text: "Quince días naturales en caso de matrimonio." },
		hard_negatives: [
			{ text: "Cinco días por nacimiento.", source: "semantic-topk" },
			{ text: "Permiso por mudanza.", source: "materia-sibling" },
		],
		...over,
	};
}

describe("pairToTriplets", () => {
	test("expands one pair into N triplets, one per negative", () => {
		const triplets = pairToTriplets(pair());
		expect(triplets.length).toBe(2);
		expect(triplets[0].query).toBe(pair().query);
		expect(triplets[0].positive).toBe(
			"Quince días naturales en caso de matrimonio.",
		);
		expect(triplets[0].negative).toBe("Cinco días por nacimiento.");
		expect(triplets[0].source).toBe("semantic-topk");
		expect(triplets[1].source).toBe("materia-sibling");
	});

	test("preserves register, is_trap, and pair_id on every triplet", () => {
		const triplets = pairToTriplets(
			pair({ register: "procedural", is_trap: true }),
		);
		for (const t of triplets) {
			expect(t.register).toBe("procedural");
			expect(t.is_trap).toBe(true);
			expect(t.pair_id).toBe("rkr-000001");
		}
	});

	test("returns empty for pair with no negatives", () => {
		expect(pairToTriplets(pair({ hard_negatives: [] }))).toEqual([]);
	});

	test("returns empty for pair with empty positive text", () => {
		const p: RerankerPair = pair();
		(p as { positive: { text: string } }).positive = { text: "" };
		expect(pairToTriplets(p)).toEqual([]);
	});
});

describe("truncatePassage", () => {
	test("returns text unchanged when shorter than max", () => {
		expect(truncatePassage("hola", 100)).toBe("hola");
	});

	test("truncates and adds ellipsis when over max", () => {
		const t = truncatePassage("x".repeat(200), 50);
		expect(t.length).toBe(51); // 50 chars + 1 ellipsis
		expect(t.endsWith("…")).toBe(true);
	});

	test("handles exact-length input", () => {
		expect(truncatePassage("abc", 3)).toBe("abc");
	});

	test("handles empty input", () => {
		expect(truncatePassage("", 100)).toBe("");
	});
});

describe("applyTruncation", () => {
	test("truncates positive and negative independently", () => {
		const triplets = pairToTriplets(
			pair({
				positive: { text: "x".repeat(500) },
				hard_negatives: [{ text: "y".repeat(500), source: "semantic-topk" }],
			}),
		);
		const out = applyTruncation(triplets, 100);
		expect(out[0].positive.length).toBe(101); // 100 + …
		expect(out[0].negative.length).toBe(101);
	});

	test("does not truncate already-short passages", () => {
		const triplets = pairToTriplets(pair());
		const out = applyTruncation(triplets, 1000);
		expect(out[0].positive).toBe(triplets[0].positive);
		expect(out[0].negative).toBe(triplets[0].negative);
	});

	test("does not mutate input triplets", () => {
		const triplets = pairToTriplets(
			pair({ positive: { text: "x".repeat(500) } }),
		);
		const before = triplets[0].positive;
		applyTruncation(triplets, 50);
		expect(triplets[0].positive).toBe(before);
	});
});
