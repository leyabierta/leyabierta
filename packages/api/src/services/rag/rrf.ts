/**
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked lists into one.
 *
 * Algorithm: RRF(d) = Σ 1/(k + rank_i(d))
 * where k is a constant (default 60) and rank_i(d) is the 1-based rank
 * of document d in the i-th ranked list.
 *
 * Reference: Cormack, Clarke & Buettcher (2009)
 * "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods"
 */

export interface RankedItem {
	key: string; // unique identifier (e.g. "normId:blockId")
	score: number; // original score from the retrieval system
}

export interface RRFResult {
	key: string;
	rrfScore: number;
	/** Which systems contributed this result and at what rank */
	sources: Array<{ system: string; rank: number; originalScore: number }>;
}

/**
 * Fuse multiple ranked lists using Reciprocal Rank Fusion.
 *
 * @param rankedLists - Map of system name → ranked items (best first)
 * @param k - RRF constant (default 60, per the original paper)
 * @param topK - Max results to return
 */
export function reciprocalRankFusion(
	rankedLists: Map<string, RankedItem[]>,
	k: number = 60,
	topK: number = 50,
): RRFResult[] {
	const scores = new Map<string, RRFResult>();

	for (const [systemName, items] of rankedLists) {
		for (let rank = 0; rank < items.length; rank++) {
			const item = items[rank]!;
			const rrfContribution = 1 / (k + rank + 1); // rank is 0-based, formula uses 1-based

			let entry = scores.get(item.key);
			if (!entry) {
				entry = { key: item.key, rrfScore: 0, sources: [] };
				scores.set(item.key, entry);
			}
			entry.rrfScore += rrfContribution;
			entry.sources.push({
				system: systemName,
				rank: rank + 1,
				originalScore: item.score,
			});
		}
	}

	const results = [...scores.values()];
	results.sort((a, b) => b.rrfScore - a.rrfScore);
	return results.slice(0, topK);
}
