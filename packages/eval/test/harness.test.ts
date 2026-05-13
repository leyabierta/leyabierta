/**
 * Unit tests for packages/eval/src/harness.ts
 *
 * All tests use a fake synchronous retrieve function — no DB, no network.
 * Covers: per-query metrics, aggregate computation, edge cases.
 */

import { describe, expect, test } from "bun:test";
import {
	computeQueryMetrics,
	type EvalCandidate,
	runEval,
} from "../src/harness.ts";
import type { QAEntry } from "../src/qa-schema.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(
	id: string,
	question: string,
	boe_a_ids: string[],
	source: QAEntry["source"] = "dgt-generales",
	domain?: QAEntry["metadata"]["domain"],
): QAEntry {
	return {
		id,
		source,
		question,
		answer: "placeholder",
		norms: { citations_raw: [], boe_a_ids },
		metadata: { domain, jurisdiction: "es" },
	};
}

function makeCandidates(normIds: string[]): EvalCandidate[] {
	return normIds.map((norm_id, i) => ({
		norm_id,
		rank: i + 1,
		score: 1 / (i + 1),
	}));
}

async function* entriesFrom(entries: QAEntry[]): AsyncIterable<QAEntry> {
	for (const e of entries) yield e;
}

/** Fake retriever that always returns the same fixed candidate list */
function fakeRetrieve(candidates: EvalCandidate[]) {
	return async (_q: string): Promise<EvalCandidate[]> => candidates;
}

// ── computeQueryMetrics unit tests ────────────────────────────────────────────

describe("computeQueryMetrics", () => {
	test("full hit at rank 1", () => {
		const candidates = makeCandidates(["BOE-A-2000-001", "BOE-A-2000-002"]);
		const { metrics, hits } = computeQueryMetrics(
			["BOE-A-2000-001"],
			candidates,
			10,
		);
		expect(metrics.r1).toBe(1);
		expect(metrics.r5).toBe(1);
		expect(metrics.r10).toBe(1);
		expect(metrics.mrr).toBe(1);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.rank).toBe(1);
	});

	test("hit at rank 3 → R@1=0, R@5=1, MRR=1/3", () => {
		const candidates = makeCandidates([
			"BOE-A-2000-001",
			"BOE-A-2000-002",
			"BOE-A-2000-GOLD",
			"BOE-A-2000-004",
		]);
		const { metrics } = computeQueryMetrics(
			["BOE-A-2000-GOLD"],
			candidates,
			10,
		);
		expect(metrics.r1).toBe(0);
		expect(metrics.r5).toBe(1);
		expect(metrics.r10).toBe(1);
		expect(metrics.mrr).toBeCloseTo(1 / 3, 6);
	});

	test("hit at rank 6 → R@5=0, R@10=1", () => {
		const ids = [
			"BOE-A-2000-001",
			"BOE-A-2000-002",
			"BOE-A-2000-003",
			"BOE-A-2000-004",
			"BOE-A-2000-005",
			"BOE-A-2000-GOLD",
		];
		const candidates = makeCandidates(ids);
		const { metrics } = computeQueryMetrics(
			["BOE-A-2000-GOLD"],
			candidates,
			10,
		);
		expect(metrics.r1).toBe(0);
		expect(metrics.r5).toBe(0);
		expect(metrics.r10).toBe(1);
		expect(metrics.mrr).toBeCloseTo(1 / 6, 6);
	});

	test("no hit → all zeros", () => {
		const candidates = makeCandidates(["BOE-A-2000-001", "BOE-A-2000-002"]);
		const { metrics, hits } = computeQueryMetrics(
			["BOE-A-9999-999"],
			candidates,
			10,
		);
		expect(metrics.r1).toBe(0);
		expect(metrics.r5).toBe(0);
		expect(metrics.r10).toBe(0);
		expect(metrics.mrr).toBe(0);
		expect(hits).toHaveLength(0);
	});

	test("empty expected → all zeros (no ground truth)", () => {
		const candidates = makeCandidates(["BOE-A-2000-001"]);
		const { metrics } = computeQueryMetrics([], candidates, 10);
		expect(metrics.r1).toBe(0);
		expect(metrics.mrr).toBe(0);
	});

	test("empty candidates → no hit", () => {
		const { metrics } = computeQueryMetrics(["BOE-A-2000-001"], [], 10);
		expect(metrics.r1).toBe(0);
		expect(metrics.mrr).toBe(0);
	});

	test("multiple expected norms — first hit wins for MRR", () => {
		// GOLD2 is at rank 2, GOLD1 is at rank 5. MRR should be 1/2 (first hit).
		const candidates = makeCandidates([
			"BOE-A-2000-001",
			"BOE-A-2000-GOLD2",
			"BOE-A-2000-003",
			"BOE-A-2000-004",
			"BOE-A-2000-GOLD1",
		]);
		const { metrics, hits } = computeQueryMetrics(
			["BOE-A-2000-GOLD1", "BOE-A-2000-GOLD2"],
			candidates,
			10,
		);
		expect(metrics.r1).toBe(0);
		expect(metrics.r5).toBe(1);
		expect(metrics.r10).toBe(1);
		expect(metrics.mrr).toBeCloseTo(1 / 2, 6);
		expect(hits).toHaveLength(2);
	});

	test("topK cap — hit beyond topK is ignored", () => {
		// GOLD is at position 11 — beyond topK=10
		const ids = Array.from({ length: 12 }, (_, i) =>
			i === 10 ? "BOE-A-GOLD" : `BOE-A-2000-${i.toString().padStart(3, "0")}`,
		);
		const candidates = makeCandidates(ids);
		const { metrics } = computeQueryMetrics(["BOE-A-GOLD"], candidates, 10);
		expect(metrics.r10).toBe(0);
	});
});

// ── runEval integration tests ─────────────────────────────────────────────────

describe("runEval", () => {
	test("skips entries with empty boe_a_ids", async () => {
		const entries: QAEntry[] = [
			makeEntry("e1", "question 1", []),
			makeEntry("e2", "question 2", ["BOE-A-2000-001"]),
		];
		const results: EvalResult[] = [];
		const { aggregate } = await runEval({
			entries: entriesFrom(entries),
			retrieve: fakeRetrieve(makeCandidates(["BOE-A-2000-001"])),
			onResult: (r) => results.push(r as unknown as EvalResult),
		});
		// Only e2 has ground truth
		expect(results).toHaveLength(1);
		expect(results[0]!.query_id).toBe("e2");
		expect(aggregate.n).toBe(1);
	});

	test("all hits — aggregate R@1=1.0", async () => {
		const entries: QAEntry[] = [
			makeEntry("e1", "q1", ["BOE-A-2000-001"]),
			makeEntry("e2", "q2", ["BOE-A-2000-002"]),
			makeEntry("e3", "q3", ["BOE-A-2000-003"]),
		];
		// Retriever always returns the expected norm at rank 1
		const { aggregate } = await runEval({
			entries: entriesFrom(entries),
			retrieve: async (q) => {
				const id =
					q === "q1"
						? "BOE-A-2000-001"
						: q === "q2"
							? "BOE-A-2000-002"
							: "BOE-A-2000-003";
				return [{ norm_id: id, rank: 1, score: 1.0 }];
			},
		});
		expect(aggregate.n).toBe(3);
		expect(aggregate.r1).toBe(1);
		expect(aggregate.mrr).toBe(1);
	});

	test("no hits — aggregate R@1=0, MRR=0", async () => {
		const entries: QAEntry[] = [
			makeEntry("e1", "q1", ["BOE-A-EXPECTED"]),
			makeEntry("e2", "q2", ["BOE-A-EXPECTED"]),
		];
		const { aggregate } = await runEval({
			entries: entriesFrom(entries),
			retrieve: fakeRetrieve(
				makeCandidates(["BOE-A-WRONG-1", "BOE-A-WRONG-2"]),
			),
		});
		expect(aggregate.r1).toBe(0);
		expect(aggregate.r5).toBe(0);
		expect(aggregate.mrr).toBe(0);
	});

	test("mixed hits — partial recall", async () => {
		// 4 entries: e1 hit@1, e2 hit@3, e3 miss, e4 hit@5
		const candidates = {
			e1: makeCandidates(["BOE-A-GOLD-1"]),
			e2: makeCandidates(["X", "Y", "BOE-A-GOLD-2"]),
			e3: makeCandidates(["X", "Y", "Z"]),
			e4: makeCandidates(["A", "B", "C", "D", "BOE-A-GOLD-4"]),
		};

		const entries: QAEntry[] = [
			makeEntry("e1", "q1", ["BOE-A-GOLD-1"], "dgt-generales", "tax"),
			makeEntry("e2", "q2", ["BOE-A-GOLD-2"], "dgt-vinculantes", "tax"),
			makeEntry("e3", "q3", ["BOE-A-GOLD-3"], "dgt-generales", "admin"),
			makeEntry("e4", "q4", ["BOE-A-GOLD-4"], "dgt-generales", "tax"),
		];

		const { aggregate } = await runEval({
			entries: entriesFrom(entries),
			retrieve: async (q) => {
				const key = q as "q1" | "q2" | "q3" | "q4";
				const map = {
					q1: candidates.e1,
					q2: candidates.e2,
					q3: candidates.e3,
					q4: candidates.e4,
				};
				return map[key] ?? [];
			},
		});

		// R@1: e1 hit → 1/4 = 0.25
		expect(aggregate.r1).toBeCloseTo(0.25, 4);
		// R@5: e1, e2, e4 hit → 3/4 = 0.75
		expect(aggregate.r5).toBeCloseTo(0.75, 4);
		// R@10: same as R@5 here
		expect(aggregate.r10).toBeCloseTo(0.75, 4);
		// MRR: (1/1 + 1/3 + 0 + 1/5) / 4
		const expectedMrr = (1 / 1 + 1 / 3 + 0 + 1 / 5) / 4;
		expect(aggregate.mrr).toBeCloseTo(expectedMrr, 4);

		// per_source grouping
		expect(aggregate.per_source?.["dgt-generales"]?.n).toBe(3);
		expect(aggregate.per_source?.["dgt-vinculantes"]?.n).toBe(1);

		// per_domain grouping
		expect(aggregate.per_domain?.tax?.n).toBe(3);
		expect(aggregate.per_domain?.admin?.n).toBe(1);
		expect(aggregate.per_domain?.admin?.r1).toBe(0); // e3 is a miss
	});

	test("onResult callback fires for each evaluated entry", async () => {
		const entries: QAEntry[] = [
			makeEntry("e1", "q1", ["BOE-A-001"]),
			makeEntry("e2", "q2", ["BOE-A-002"]),
		];
		const seen: string[] = [];
		await runEval({
			entries: entriesFrom(entries),
			retrieve: fakeRetrieve([]),
			onResult: (r) => seen.push(r.query_id),
		});
		expect(seen).toContain("e1");
		expect(seen).toContain("e2");
	});

	test("topK=1 limits candidates to rank 1 only", async () => {
		const entries: QAEntry[] = [makeEntry("e1", "q1", ["BOE-A-GOLD"])];
		// GOLD is at position 2 in the returned list
		const candidates = makeCandidates(["BOE-A-OTHER", "BOE-A-GOLD"]);
		const { aggregate } = await runEval({
			entries: entriesFrom(entries),
			topK: 1,
			retrieve: fakeRetrieve(candidates),
		});
		expect(aggregate.r1).toBe(0);
	});

	test("empty dataset → n=0 aggregate", async () => {
		const { aggregate } = await runEval({
			entries: entriesFrom([]),
			retrieve: fakeRetrieve([]),
		});
		expect(aggregate.n).toBe(0);
		expect(aggregate.r1).toBe(0);
		expect(aggregate.mrr).toBe(0);
	});
});

// ── Aligned-citation ground-truth tests ───────────────────────────────────────
//
// These tests verify the schema can carry citations[] and that the harness
// correctly derives ground truth from boe_a_ids[] (which is the safe, complete
// set of resolved BOE-A IDs) rather than from a single citations[i].boe_a_id
// (which would be the antipattern: picking one id and losing the others).
//
// Fixture: entry with two citations
//   citations[0]: raw="Ley 37/1992, artículo 90"  boe_a_id="BOE-A-1992-28740"  article="90"
//   citations[1]: raw="Ley Orgánica 4/2000"        boe_a_id=null                article=null
// boe_a_ids (derived): ["BOE-A-1992-28740"]
//
// Ground truth for norm-level R@k = {"BOE-A-1992-28740"} (derived from all resolved ids).
// A retriever returning BOE-A-1992-28740 must score as a hit.

describe("aligned-citation ground truth", () => {
	function makeAlignedEntry(id: string, question: string): QAEntry {
		return {
			id,
			source: "dgt-generales",
			question,
			answer: "placeholder",
			norms: {
				citations_raw: ["Ley 37/1992, artículo 90", "Ley Orgánica 4/2000"],
				// Aligned schema: one entry per raw citation
				citations: [
					{
						raw: "Ley 37/1992, artículo 90",
						boe_a_id: "BOE-A-1992-28740",
						article: "90",
					},
					{ raw: "Ley Orgánica 4/2000", boe_a_id: null, article: null },
				],
				// Derived backwards-compat: only the resolved IDs (null filtered out)
				boe_a_ids: ["BOE-A-1992-28740"],
			},
			metadata: { domain: "tax", jurisdiction: "es" },
		};
	}

	test("harness uses full boe_a_ids set — entry with one null citation still scores a hit", async () => {
		// The antipattern would be to pick citations[0].boe_a_id and ignore citations[1]
		// (which would give the same result here but is semantically wrong) OR to somehow
		// iterate only citations and use citations[1].boe_a_id=null as ground truth, scoring
		// a miss even when the resolved norm IS retrieved.
		//
		// Correct behaviour: boe_a_ids=["BOE-A-1992-28740"] is the ground truth set.
		// Retriever returns that exact norm at rank 1 → R@1 must be 1.

		const entry = makeAlignedEntry(
			"aligned-1",
			"¿Qué dice el artículo 90 de la Ley del IVA?",
		);

		const { aggregate } = await runEval({
			entries: (async function* () {
				yield entry;
			})(),
			retrieve: async (_q) => [
				{ norm_id: "BOE-A-1992-28740", rank: 1, score: 1.0 },
			],
		});

		expect(aggregate.n).toBe(1);
		expect(aggregate.r1).toBe(1);
		expect(aggregate.mrr).toBe(1);
	});

	test("harness misses when only the unresolved citation's norm is NOT in boe_a_ids", async () => {
		// citations[1] has boe_a_id=null — it does NOT appear in boe_a_ids.
		// If a retriever returns "BOE-A-WRONG-999" (the unresolved norm), it is a miss.
		// This confirms boe_a_ids is the source of truth, not a guess from citations[].

		const entry = makeAlignedEntry(
			"aligned-2",
			"¿Qué dice la Ley Orgánica 4/2000?",
		);

		const { aggregate } = await runEval({
			entries: (async function* () {
				yield entry;
			})(),
			retrieve: async (_q) => [
				{ norm_id: "BOE-A-WRONG-999", rank: 1, score: 1.0 },
			],
		});

		expect(aggregate.n).toBe(1);
		expect(aggregate.r1).toBe(0);
		expect(aggregate.mrr).toBe(0);
	});

	test("multi-citation entry: both resolved norms are in ground truth set", async () => {
		// Fixture: two citations both resolved to different BOE-A IDs
		const entryBothResolved: QAEntry = {
			id: "aligned-3",
			source: "dgt-generales",
			question: "¿Qué combinan la Ley del IVA y el Código Civil?",
			answer: "placeholder",
			norms: {
				citations_raw: [
					"Ley 37/1992, artículo 90",
					"Real Decreto de 24 julio 1889",
				],
				citations: [
					{
						raw: "Ley 37/1992, artículo 90",
						boe_a_id: "BOE-A-1992-28740",
						article: "90",
					},
					{
						raw: "Real Decreto de 24 julio 1889",
						boe_a_id: "BOE-A-1889-4763",
						article: null,
					},
				],
				// Both ids must be in ground truth
				boe_a_ids: ["BOE-A-1992-28740", "BOE-A-1889-4763"],
			},
			metadata: { domain: "tax", jurisdiction: "es" },
		};

		// Retriever returns the SECOND norm (no article) at rank 1.
		// The antipattern would be to pick only citations[0].boe_a_id (IVA) as ground truth
		// and score a miss. The correct behaviour is to score a hit since BOE-A-1889-4763
		// IS in boe_a_ids.
		const { aggregate } = await runEval({
			entries: (async function* () {
				yield entryBothResolved;
			})(),
			retrieve: async (_q) => [
				{ norm_id: "BOE-A-1889-4763", rank: 1, score: 1.0 },
			],
		});

		expect(aggregate.n).toBe(1);
		expect(aggregate.r1).toBe(1); // hit: BOE-A-1889-4763 is in boe_a_ids
		expect(aggregate.mrr).toBe(1);
	});
});

// ── Type alias to avoid unused import warning ─────────────────────────────────
type EvalResult = import("../src/harness.ts").EvalResult;
