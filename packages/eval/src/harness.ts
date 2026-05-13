/**
 * Eval harness — retrieval-quality measurement for the Ley Abierta RAG pipeline.
 *
 * Pure module: accepts an injected `retrieve` function so it can be unit-tested
 * with a deterministic fake, or wired to the real RAG pipeline in prod.
 *
 * Metrics computed per query:
 *   R@1   — any expected norm_id in rank 1
 *   R@5   — any expected norm_id in top 5
 *   R@10  — any expected norm_id in top 10
 *   MRR   — mean reciprocal rank of first hit (0 if no hit)
 *
 * Aggregates break down by `source` (from QAEntry.source) and
 * `metadata.domain` (from QAEntry.metadata.domain) when present.
 *
 * ── Ground-truth contract ────────────────────────────────────────────────────
 *
 * This harness evaluates at NORM level only (does the retriever return the
 * right law?). The ground truth set for each query is:
 *
 *   entry.norms.boe_a_ids   — all resolved BOE-A IDs for the entry (safe: the
 *                             full set is used, not one representative ID, so
 *                             order/alignment do not affect correctness here).
 *
 * For ARTICLE-level evaluation (did the retriever return the right article
 * within the right law?), you MUST use the aligned schema instead:
 *
 *   entry.norms.citations[]  — one entry per raw citation, aligned so
 *                              citations[i].boe_a_id and citations[i].article
 *                              always refer to the same legal reference.
 *
 * Using boe_a_ids[] for article-level evaluation is the antipattern:
 * it loses the citation→article alignment and can produce wrong ground truth
 * when an entry contains multiple distinct citations to different norms.
 * (See enrich-citations.ts for schema details.)
 */

import type { QAEntry } from "./qa-schema.ts";

// ── Public types ──────────────────────────────────────────────────────────────

export interface EvalCandidate {
	norm_id: string; // BOE-A-...
	rank: number; // 1-based
	score: number;
}

export interface EvalResult {
	query_id: string;
	question: string;
	expected_norm_ids: string[];
	retrieved: EvalCandidate[]; // top-K
	hits: { rank: number; norm_id: string }[]; // intersection
	metrics: { r1: number; r5: number; r10: number; mrr: number };
}

export interface GroupMetrics {
	n: number;
	r1: number;
	r5: number;
	r10: number;
	mrr: number;
}

export interface AggregateMetrics {
	n: number;
	r1: number;
	r5: number;
	r10: number;
	mrr: number;
	per_source?: Record<string, GroupMetrics>;
	per_domain?: Record<string, GroupMetrics>;
}

export interface RunEvalOpts {
	entries: AsyncIterable<QAEntry>;
	topK?: number; // default 10
	retrieve: (q: string) => Promise<EvalCandidate[]>;
	onResult?: (r: EvalResult) => void;
	concurrency?: number; // default 4;
	/**
	 * Optional successor map: gold norm_id → set of equivalent successor norm_ids.
	 * When a gold norm has been derogated and replaced (Ley 30/1992 → 39/2015+40/2015,
	 * RDL 4/2004 → Ley 27/2014, etc.), a retriever that returns the successor is
	 * substantively correct. With this map, those retrievals score as hits.
	 *
	 * Built from BOE `analisis.referencias_posteriores` ("SE DEROGA POR" relations).
	 */
	successorsMap?: Map<string, Set<string>>;
}

// ── Successor expansion ──────────────────────────────────────────────────────

/**
 * Expands a list of gold norm_ids to include their known successor norms.
 * Used when scoring: a retriever returning the successor of a derogated norm
 * is substantively correct.
 */
export function expandWithSuccessors(
	expected: string[],
	successorsMap?: Map<string, Set<string>>,
): string[] {
	if (!successorsMap || successorsMap.size === 0) return expected;
	const expanded = new Set(expected);
	for (const id of expected) {
		const succ = successorsMap.get(id);
		if (succ) for (const s of succ) expanded.add(s);
	}
	return [...expanded];
}

// ── Per-query metric computation ──────────────────────────────────────────────

export function computeQueryMetrics(
	expected: string[],
	retrieved: EvalCandidate[],
	topK: number,
): {
	hits: { rank: number; norm_id: string }[];
	metrics: { r1: number; r5: number; r10: number; mrr: number };
} {
	if (expected.length === 0) {
		// No ground truth — cannot compute metrics
		return {
			hits: [],
			metrics: { r1: 0, r5: 0, r10: 0, mrr: 0 },
		};
	}

	const expectedSet = new Set(expected);
	const capped = retrieved.slice(0, topK);

	const hits: { rank: number; norm_id: string }[] = [];
	for (const c of capped) {
		if (expectedSet.has(c.norm_id)) {
			hits.push({ rank: c.rank, norm_id: c.norm_id });
		}
	}

	// Sort hits by rank ascending for MRR
	hits.sort((a, b) => a.rank - b.rank);

	const firstHitRank = hits.length > 0 ? hits[0]!.rank : null;

	const r1 = firstHitRank !== null && firstHitRank <= 1 ? 1 : 0;
	const r5 = firstHitRank !== null && firstHitRank <= 5 ? 1 : 0;
	const r10 = firstHitRank !== null && firstHitRank <= 10 ? 1 : 0;
	const mrr = firstHitRank !== null ? 1 / firstHitRank : 0;

	return { hits, metrics: { r1, r5, r10, mrr } };
}

// ── Aggregate helpers ─────────────────────────────────────────────────────────

function emptyGroup(): GroupMetrics {
	return { n: 0, r1: 0, r5: 0, r10: 0, mrr: 0 };
}

function accumulateGroup(g: GroupMetrics, m: EvalResult["metrics"]): void {
	g.n += 1;
	g.r1 += m.r1;
	g.r5 += m.r5;
	g.r10 += m.r10;
	g.mrr += m.mrr;
}

function finaliseGroup(g: GroupMetrics): GroupMetrics {
	if (g.n === 0) return g;
	return {
		n: g.n,
		r1: g.r1 / g.n,
		r5: g.r5 / g.n,
		r10: g.r10 / g.n,
		mrr: g.mrr / g.n,
	};
}

function buildAggregate(
	results: EvalResult[],
	bySource: Map<string, GroupMetrics>,
	byDomain: Map<string, GroupMetrics>,
): AggregateMetrics {
	const total = emptyGroup();
	for (const r of results) {
		accumulateGroup(total, r.metrics);
	}
	const agg = finaliseGroup(total);

	const per_source: Record<string, GroupMetrics> = {};
	for (const [k, g] of bySource) {
		per_source[k] = finaliseGroup(g);
	}

	const per_domain: Record<string, GroupMetrics> = {};
	for (const [k, g] of byDomain) {
		per_domain[k] = finaliseGroup(g);
	}

	return {
		n: agg.n,
		r1: agg.r1,
		r5: agg.r5,
		r10: agg.r10,
		mrr: agg.mrr,
		...(Object.keys(per_source).length > 0 && { per_source }),
		...(Object.keys(per_domain).length > 0 && { per_domain }),
	};
}

// ── Main harness function ─────────────────────────────────────────────────────

export async function runEval(opts: RunEvalOpts): Promise<{
	results: EvalResult[];
	aggregate: AggregateMetrics;
}> {
	const topK = opts.topK ?? 10;
	const concurrency = opts.concurrency ?? 4;

	const results: EvalResult[] = [];
	const bySource = new Map<string, GroupMetrics>();
	const byDomain = new Map<string, GroupMetrics>();

	// Collect all entries (needed for concurrency pool)
	const pending: QAEntry[] = [];
	for await (const entry of opts.entries) {
		pending.push(entry);
	}

	// Process with bounded concurrency
	let idx = 0;

	async function worker(): Promise<void> {
		while (idx < pending.length) {
			const entry = pending[idx++]!;

			// audit: ok — norm-level R@k uses the full boe_a_ids set as expected.
			// Order/alignment does not matter: computeQueryMetrics builds a Set over
			// all ids. Do NOT change this to citations[].boe_a_id without simultaneously
			// adding article-level hit logic; doing so would drop entries that have
			// multiple citations (only one would survive the Set build).
			const expected = entry.norms.boe_a_ids;
			if (expected.length === 0) {
				// Skip — no ground truth
				continue;
			}

			const retrieved = await opts.retrieve(entry.question);

			// Ensure ranks are 1-based and candidates are sorted
			const sorted = retrieved
				.slice(0, topK)
				.map((c, i) => ({ ...c, rank: i + 1 }));

			// Expand gold with known derogated→successor mappings so a retriever
			// returning the live successor of a derogated norm scores as a hit.
			const expectedExpanded = expandWithSuccessors(
				expected,
				opts.successorsMap,
			);

			const { hits, metrics } = computeQueryMetrics(
				expectedExpanded,
				sorted,
				topK,
			);

			const result: EvalResult = {
				query_id: entry.id,
				question: entry.question,
				expected_norm_ids: expected,
				retrieved: sorted,
				hits,
				metrics,
			};

			results.push(result);

			// Accumulate into grouping buckets (raw sums, finalise later)
			const src = entry.source;
			if (!bySource.has(src)) bySource.set(src, emptyGroup());
			accumulateGroup(bySource.get(src)!, metrics);

			const domain = entry.metadata?.domain;
			if (domain) {
				if (!byDomain.has(domain)) byDomain.set(domain, emptyGroup());
				accumulateGroup(byDomain.get(domain)!, metrics);
			}

			opts.onResult?.(result);
		}
	}

	const workers = Array.from({ length: concurrency }, () => worker());
	await Promise.all(workers);

	const aggregate = buildAggregate(results, bySource, byDomain);

	return { results, aggregate };
}
