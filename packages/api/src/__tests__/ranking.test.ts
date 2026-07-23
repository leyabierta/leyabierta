/**
 * Unit tests for authority-aware ranking (issue #131).
 *
 * Pure function tests — no database, no I/O. The integration path (fetching
 * metadata + calling into these functions from `services/db.ts`) is covered
 * separately in db-service.test.ts.
 */

import { describe, expect, it } from "bun:test";
import {
	AUTHORITY_LOG_WEIGHT,
	bm25NormalizedFromPosition,
	computeRankingScore,
	DEFAULT_JURISDICTION_BOOST,
	DEFAULT_RANK_WEIGHT,
	DEFAULT_STATUS_PENALTY,
	jurisdictionBoost,
	rankWeight,
	reorderByAuthority,
	statusPenalty,
} from "../services/ranking.ts";

function signals(
	overrides: Partial<Parameters<typeof computeRankingScore>[0]> = {},
) {
	return {
		bm25Normalized: 1,
		authorityScore: 0,
		rank: "ley",
		status: "vigente",
		jurisdiction: "es",
		...overrides,
	};
}

describe("rankWeight", () => {
	it("returns the configured weight for a known rank", () => {
		expect(rankWeight("constitucion")).toBeGreaterThan(rankWeight("ley"));
		expect(rankWeight("ley")).toBeGreaterThan(rankWeight("orden"));
	});

	it("falls back to the neutral default for an unknown rank", () => {
		expect(rankWeight("something-new")).toBe(DEFAULT_RANK_WEIGHT);
	});
});

describe("statusPenalty", () => {
	it("does not penalize vigente", () => {
		expect(statusPenalty("vigente")).toBe(1.0);
	});

	it("penalizes derogada hard", () => {
		expect(statusPenalty("derogada")).toBeLessThan(0.5);
	});

	it("penalizes parcialmente_derogada less than derogada", () => {
		expect(statusPenalty("parcialmente_derogada")).toBeGreaterThan(
			statusPenalty("derogada"),
		);
		expect(statusPenalty("parcialmente_derogada")).toBeLessThan(1.0);
	});

	it("falls back to the neutral default for an unknown status", () => {
		expect(statusPenalty("unknown")).toBe(DEFAULT_STATUS_PENALTY);
	});
});

describe("jurisdictionBoost", () => {
	it("boosts state-level (es) legislation", () => {
		expect(jurisdictionBoost("es")).toBeGreaterThan(1.0);
	});

	it("leaves regional jurisdictions neutral, not penalized", () => {
		expect(jurisdictionBoost("es-ct")).toBe(DEFAULT_JURISDICTION_BOOST);
		expect(jurisdictionBoost("es-ct")).toBe(1.0);
	});
});

describe("computeRankingScore", () => {
	it("authorityScore = 0 is a no-op on the authority factor", () => {
		const withZeroAuthority = computeRankingScore(
			signals({ authorityScore: 0 }),
		);
		const baseline =
			1 *
			rankWeight("ley") *
			statusPenalty("vigente") *
			jurisdictionBoost("es");
		expect(withZeroAuthority).toBeCloseTo(baseline, 10);
	});

	it("higher authorityScore strictly increases the score, all else equal", () => {
		const low = computeRankingScore(signals({ authorityScore: 1 }));
		const high = computeRankingScore(signals({ authorityScore: 100 }));
		expect(high).toBeGreaterThan(low);
	});

	it("authority factor grows with log(1 + authorityScore), not linearly", () => {
		const at10 = computeRankingScore(signals({ authorityScore: 10 }));
		const at1000 = computeRankingScore(signals({ authorityScore: 1000 }));
		const at100000 = computeRankingScore(signals({ authorityScore: 100000 }));
		// Going from 10 → 1000 (100x) should grow the score far more than
		// going from 1000 → 100000 (also 100x) shrinks in absolute log terms,
		// but both deltas should be modest — nowhere near 100x each.
		expect(at1000 / at10).toBeLessThan(2);
		expect(at100000 / at1000).toBeLessThan(2);
	});

	it("negative or NaN authorityScore degrades to the zero-authority factor instead of poisoning the score", () => {
		const negative = computeRankingScore(signals({ authorityScore: -5 }));
		const nan = computeRankingScore(signals({ authorityScore: Number.NaN }));
		const zero = computeRankingScore(signals({ authorityScore: 0 }));
		expect(negative).toBeCloseTo(zero, 10);
		expect(nan).toBeCloseTo(zero, 10);
		expect(Number.isNaN(negative)).toBe(false);
		expect(Number.isNaN(nan)).toBe(false);
	});

	it("derogada must not outscore an otherwise-identical vigente candidate", () => {
		const vigente = computeRankingScore(signals({ status: "vigente" }));
		const derogada = computeRankingScore(signals({ status: "derogada" }));
		expect(derogada).toBeLessThan(vigente);
	});

	it("a strong rank/authority advantage cannot fully cancel the derogada penalty at equal text relevance", () => {
		// The bug this issue fixes: a repealed norm should not outrank the
		// norm that replaced it. Even giving the derogada candidate the
		// maximum plausible rank weight and a very high authority score,
		// it should still lose to a vigente "ley" with no authority at all,
		// as long as both matched the query equally well (same bm25Normalized).
		const derogadaButFamous = computeRankingScore({
			bm25Normalized: 1,
			authorityScore: 380, // ~max observed in production
			rank: "constitucion",
			status: "derogada",
			jurisdiction: "es",
		});
		const vigenteButObscure = computeRankingScore({
			bm25Normalized: 1,
			authorityScore: 0,
			rank: "ley",
			status: "vigente",
			jurisdiction: "es",
		});
		expect(derogadaButFamous).toBeLessThan(vigenteButObscure);
	});
});

describe("bm25NormalizedFromPosition", () => {
	it("position 0 (best match) normalizes to 1", () => {
		expect(bm25NormalizedFromPosition(0)).toBe(1);
	});

	it("is strictly decreasing as position increases", () => {
		const p0 = bm25NormalizedFromPosition(0);
		const p1 = bm25NormalizedFromPosition(1);
		const p10 = bm25NormalizedFromPosition(10);
		expect(p0).toBeGreaterThan(p1);
		expect(p1).toBeGreaterThan(p10);
	});

	it("never reaches 0 or negative for any non-negative position", () => {
		for (const p of [0, 1, 5, 100, 10000]) {
			expect(bm25NormalizedFromPosition(p)).toBeGreaterThan(0);
		}
	});
});

describe("reorderByAuthority", () => {
	it("returns the same order when no metadata is available (all no-ops)", () => {
		const ids = ["a", "b", "c"];
		expect(reorderByAuthority(ids, new Map())).toEqual(ids);
	});

	it("is a no-op when every candidate has identical signals", () => {
		const ids = ["a", "b", "c"];
		const meta = new Map(
			ids.map((id) => [
				id,
				{
					rank: "ley",
					status: "vigente",
					jurisdiction: "es",
					authorityScore: 0,
				},
			]),
		);
		expect(reorderByAuthority(ids, meta)).toEqual(ids);
	});

	it("THE CORE FIX: a derogada norm ranked first by BM25 must not stay above the vigente norm that replaced it", () => {
		// "old-derogated" is a slightly better textual match (position 0) —
		// today's bug. "new-vigente" is the current law (position 1).
		const orderedIds = ["old-derogated", "new-vigente"];
		const meta = new Map<
			string,
			{
				rank: string;
				status: string;
				jurisdiction: string;
				authorityScore: number;
			}
		>([
			[
				"old-derogated",
				{
					rank: "ley",
					status: "derogada",
					jurisdiction: "es",
					authorityScore: 5,
				},
			],
			[
				"new-vigente",
				{
					rank: "ley",
					status: "vigente",
					jurisdiction: "es",
					authorityScore: 5,
				},
			],
		]);

		const result = reorderByAuthority(orderedIds, meta);
		expect(result[0]).toBe("new-vigente");
		expect(result[1]).toBe("old-derogated");
	});

	it("a candidate missing from metadataById keeps its position-based score instead of vanishing", () => {
		const orderedIds = ["known", "unknown"];
		const meta = new Map([
			[
				"known",
				{
					rank: "ley",
					status: "derogada",
					jurisdiction: "es",
					authorityScore: 0,
				},
			],
		]);
		const result = reorderByAuthority(orderedIds, meta);
		expect(result).toContain("unknown");
		expect(result).toHaveLength(2);
		// "unknown" has no penalty applied (score = 0.5, its raw position
		// signal) while "known" is derogada-penalized well below that.
		expect(result[0]).toBe("unknown");
	});

	it("preserves relative order for ties (stable sort)", () => {
		const orderedIds = ["a", "b", "c"];
		const meta = new Map(
			orderedIds.map((id) => [
				id,
				{
					rank: "orden",
					status: "vigente",
					jurisdiction: "es-ct",
					authorityScore: 0,
				},
			]),
		);
		expect(reorderByAuthority(orderedIds, meta)).toEqual(orderedIds);
	});
});

describe("AUTHORITY_LOG_WEIGHT sanity", () => {
	it("is a small positive number (nudges, doesn't dominate)", () => {
		expect(AUTHORITY_LOG_WEIGHT).toBeGreaterThan(0);
		expect(AUTHORITY_LOG_WEIGHT).toBeLessThan(1);
	});
});
