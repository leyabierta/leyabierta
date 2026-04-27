/**
 * Unit tests for the reranker dataset sampler (Fase 1a).
 *
 * Covers the deterministic helpers — allocation, shuffling, article filtering,
 * and stratified picking. The DB layer is exercised end-to-end via integration
 * (see `bun run packages/api/research/build-reranker-dataset.ts sample`).
 */

import { describe, expect, test } from "bun:test";
import {
	allocateByWeight,
	classifyArticle,
	mulberry32,
	pickFromPool,
	pickMateriaSibling,
	pickSemanticNegatives,
	type RankedCandidate,
	type SampledArticle,
	seededShuffle,
} from "../../research/build-reranker-dataset.ts";

describe("mulberry32", () => {
	test("is deterministic for the same seed", () => {
		const a = mulberry32(42);
		const b = mulberry32(42);
		const seqA = Array.from({ length: 5 }, () => a());
		const seqB = Array.from({ length: 5 }, () => b());
		expect(seqA).toEqual(seqB);
	});

	test("different seeds give different sequences", () => {
		const a = mulberry32(1);
		const b = mulberry32(2);
		expect(a()).not.toBe(b());
	});

	test("output is in [0, 1)", () => {
		const r = mulberry32(7);
		for (let i = 0; i < 100; i++) {
			const v = r();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe("seededShuffle", () => {
	test("preserves all elements", () => {
		const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const shuffled = seededShuffle(arr, 123);
		expect(shuffled.slice().sort((a, b) => a - b)).toEqual(arr);
	});

	test("does not mutate input", () => {
		const arr = [1, 2, 3];
		const copy = [...arr];
		seededShuffle(arr, 1);
		expect(arr).toEqual(copy);
	});

	test("is deterministic for the same seed", () => {
		const arr = [1, 2, 3, 4, 5, 6, 7, 8];
		expect(seededShuffle(arr, 42)).toEqual(seededShuffle(arr, 42));
	});

	test("different seeds usually produce different orderings", () => {
		const arr = [1, 2, 3, 4, 5, 6, 7, 8];
		expect(seededShuffle(arr, 1)).not.toEqual(seededShuffle(arr, 2));
	});

	test("empty input returns empty output", () => {
		expect(seededShuffle([], 1)).toEqual([]);
	});
});

describe("allocateByWeight", () => {
	test("allocates proportionally and sums to total", () => {
		const out = allocateByWeight(100, { a: 0.7, b: 0.3 });
		expect(out.a + out.b).toBe(100);
		expect(out.a).toBe(70);
		expect(out.b).toBe(30);
	});

	test("handles non-normalized weights", () => {
		const out = allocateByWeight(50, { a: 2, b: 1, c: 1 });
		expect(out.a + out.b + out.c).toBe(50);
		expect(out.a).toBe(25);
	});

	test("handles fractional remainders via largest-remainder rounding", () => {
		const out = allocateByWeight(10, { a: 1, b: 1, c: 1 });
		expect(out.a + out.b + out.c).toBe(10);
		// Each gets at least floor(10/3) = 3; one stratum gets the extra.
		for (const k of ["a", "b", "c"]) {
			expect(out[k]).toBeGreaterThanOrEqual(3);
			expect(out[k]).toBeLessThanOrEqual(4);
		}
	});

	test("zero-weight strata get zero", () => {
		const out = allocateByWeight(20, { a: 1, b: 0 });
		expect(out.a).toBe(20);
		expect(out.b).toBe(0);
	});

	test("all-zero weights yield all zeros", () => {
		const out = allocateByWeight(20, { a: 0, b: 0 });
		expect(out).toEqual({ a: 0, b: 0 });
	});

	test("total = 0 yields all zeros", () => {
		const out = allocateByWeight(0, { a: 0.5, b: 0.5 });
		expect(out).toEqual({ a: 0, b: 0 });
	});

	test("rejects negative total", () => {
		expect(() => allocateByWeight(-1, { a: 1 })).toThrow();
	});

	test("rejects negative weights", () => {
		expect(() => allocateByWeight(10, { a: -1, b: 1 })).toThrow();
	});
});

describe("classifyArticle", () => {
	test("ok for valid precepto with enough text", () => {
		expect(
			classifyArticle({
				block_id: "a1",
				block_type: "precepto",
				current_text: "x".repeat(100),
			}),
		).toBe("ok");
	});

	test("rejects non-precepto blocks", () => {
		expect(
			classifyArticle({
				block_id: "a1",
				block_type: "encabezado",
				current_text: "x".repeat(100),
			}),
		).toBe("wrong-block-type");
	});

	test("rejects empty text", () => {
		expect(
			classifyArticle({
				block_id: "a1",
				block_type: "precepto",
				current_text: "",
			}),
		).toBe("empty-text");
	});

	test("rejects whitespace-only text", () => {
		expect(
			classifyArticle({
				block_id: "a1",
				block_type: "precepto",
				current_text: "   \n\t  ",
			}),
		).toBe("empty-text");
	});

	test("rejects too-short text", () => {
		expect(
			classifyArticle({
				block_id: "a1",
				block_type: "precepto",
				current_text: "Demasiado corto.",
			}),
		).toBe("too-short");
	});

	test("rejects disposiciones derogatorias by block_id prefix", () => {
		expect(
			classifyArticle({
				block_id: "dd1",
				block_type: "precepto",
				current_text: "x".repeat(200),
			}),
		).toBe("derogatoria");
		expect(
			classifyArticle({
				block_id: "ddunica",
				block_type: "precepto",
				current_text: "x".repeat(200),
			}),
		).toBe("derogatoria");
	});
});

describe("pickFromPool", () => {
	function art(
		norm_id: string,
		block_id: string,
		rank: string,
	): SampledArticle {
		return {
			norm_id,
			block_id,
			block_type: "precepto",
			title: "",
			text: "x".repeat(120),
			rank,
			jurisdiction: "es",
			published_at: "2020-01-01",
		};
	}

	test("respects rank weights when pool is large enough", () => {
		const pool: SampledArticle[] = [];
		for (let i = 0; i < 200; i++) pool.push(art(`N${i}`, `a${i}`, "ley"));
		for (let i = 0; i < 200; i++) pool.push(art(`M${i}`, `a${i}`, "orden"));
		const picked = pickFromPool(pool, 20, { ley: 0.8, orden: 0.2 }, 1);
		expect(picked.length).toBe(20);
		const leyCount = picked.filter((a) => a.rank === "ley").length;
		const ordenCount = picked.filter((a) => a.rank === "orden").length;
		expect(leyCount).toBe(16);
		expect(ordenCount).toBe(4);
	});

	test("falls back to other ranks when one is exhausted", () => {
		const pool: SampledArticle[] = [
			art("A", "a1", "ley"),
			art("A", "a2", "ley"),
			art("B", "a1", "orden"),
			art("B", "a2", "orden"),
			art("B", "a3", "orden"),
			art("B", "a4", "orden"),
			art("B", "a5", "orden"),
		];
		const picked = pickFromPool(pool, 6, { ley: 0.8, orden: 0.2 }, 1);
		// Only 2 leyes available; should fill the rest from orden.
		expect(picked.length).toBe(6);
		expect(picked.filter((a) => a.rank === "ley").length).toBe(2);
		expect(picked.filter((a) => a.rank === "orden").length).toBe(4);
	});

	test("never returns duplicates", () => {
		const pool: SampledArticle[] = [];
		for (let i = 0; i < 30; i++) pool.push(art(`N${i}`, "a1", "ley"));
		const picked = pickFromPool(pool, 30, { ley: 1 }, 7);
		const keys = new Set(picked.map((a) => `${a.norm_id}/${a.block_id}`));
		expect(keys.size).toBe(picked.length);
	});

	test("is deterministic for the same seed", () => {
		const pool: SampledArticle[] = [];
		for (let i = 0; i < 50; i++) pool.push(art(`N${i}`, "a1", "ley"));
		const a = pickFromPool(pool, 10, { ley: 1 }, 99);
		const b = pickFromPool(pool, 10, { ley: 1 }, 99);
		expect(a.map((x) => x.norm_id)).toEqual(b.map((x) => x.norm_id));
	});

	test("returns empty for count 0 or empty pool", () => {
		expect(pickFromPool([], 10, { ley: 1 }, 1)).toEqual([]);
		expect(pickFromPool([art("A", "a1", "ley")], 0, { ley: 1 }, 1)).toEqual([]);
	});
});

describe("pickSemanticNegatives", () => {
	function rk(norm: string, block: string): RankedCandidate {
		return { norm_id: norm, block_id: block };
	}

	test("drops same-norm siblings before windowing", () => {
		const ranked = [
			rk("GOLD", "a1"),
			rk("GOLD", "a2"),
			rk("OTHER1", "a1"),
			rk("OTHER2", "a1"),
			rk("OTHER3", "a1"),
			rk("OTHER4", "a1"),
			rk("OTHER5", "a1"),
			rk("OTHER6", "a1"),
		];
		// Range 0-2 against the FILTERED list (after removing GOLD).
		const picked = pickSemanticNegatives(ranked, "GOLD", 3, 0, 2, 7);
		expect(picked.length).toBe(3);
		for (const p of picked) expect(p.norm_id).not.toBe("GOLD");
		// All picks must come from the first 3 OTHER items.
		const allowed = new Set(["OTHER1", "OTHER2", "OTHER3"]);
		for (const p of picked) expect(allowed.has(p.norm_id)).toBe(true);
	});

	test("range outside filtered list falls back to whole pool", () => {
		const ranked = [rk("GOLD", "a1"), rk("OTHER1", "a1"), rk("OTHER2", "a1")];
		const picked = pickSemanticNegatives(ranked, "GOLD", 1, 50, 60, 1);
		expect(picked.length).toBe(1);
		expect(["OTHER1", "OTHER2"]).toContain(picked[0].norm_id);
	});

	test("returns empty when no non-gold candidates exist", () => {
		const ranked = [rk("GOLD", "a1"), rk("GOLD", "a2")];
		expect(pickSemanticNegatives(ranked, "GOLD", 2, 0, 5, 1)).toEqual([]);
	});

	test("count of 0 returns empty", () => {
		const ranked = [rk("OTHER", "a1")];
		expect(pickSemanticNegatives(ranked, "GOLD", 0, 0, 5, 1)).toEqual([]);
	});

	test("is deterministic for the same seed", () => {
		const ranked = [
			rk("OTHER1", "a1"),
			rk("OTHER2", "a1"),
			rk("OTHER3", "a1"),
			rk("OTHER4", "a1"),
			rk("OTHER5", "a1"),
		];
		const a = pickSemanticNegatives(ranked, "GOLD", 2, 0, 4, 99);
		const b = pickSemanticNegatives(ranked, "GOLD", 2, 0, 4, 99);
		expect(a).toEqual(b);
	});

	test("clamps count to window size", () => {
		const ranked = [rk("OTHER1", "a1"), rk("OTHER2", "a1")];
		const picked = pickSemanticNegatives(ranked, "GOLD", 10, 0, 5, 1);
		expect(picked.length).toBe(2);
	});
});

describe("pickMateriaSibling", () => {
	const cand = (n: string) => ({
		norm_id: n,
		block_id: "a1",
		text: "x".repeat(120),
	});

	test("picks a non-gold candidate", () => {
		const pool = [cand("GOLD"), cand("OTHER1"), cand("OTHER2")];
		const picked = pickMateriaSibling(pool, "GOLD", 1);
		expect(picked).not.toBeNull();
		expect(picked?.norm_id).not.toBe("GOLD");
	});

	test("returns null when only gold exists", () => {
		expect(
			pickMateriaSibling([cand("GOLD"), cand("GOLD")], "GOLD", 1),
		).toBeNull();
	});

	test("returns null for empty pool", () => {
		expect(pickMateriaSibling([], "GOLD", 1)).toBeNull();
	});

	test("is deterministic for the same seed", () => {
		const pool = [
			cand("OTHER1"),
			cand("OTHER2"),
			cand("OTHER3"),
			cand("OTHER4"),
		];
		expect(pickMateriaSibling(pool, "GOLD", 5)).toEqual(
			pickMateriaSibling(pool, "GOLD", 5),
		);
	});
});
