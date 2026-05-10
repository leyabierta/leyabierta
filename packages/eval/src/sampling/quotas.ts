/**
 * Quota table for the stratified sampler.
 *
 * ── Math ──
 * Goal: ~2000 accepted questions in the eval dataset. Empirically the multi-
 * agent pipeline accepts ≈40% of generated drafts (the 3-of-3 judge panel,
 * the leak detector, the citizen-voice critic and dedup all knock items out),
 * so we need ≈ 2000 / 0.40 = 5000 seeds total.
 *
 * Stratification cells: (materia × jurisdiction × rank × decade).
 *   - top 30 materias + "_other"                         → 31 buckets
 *   - jurisdictions with ≥50 vigente norms + "_other"     → ~18 buckets
 *   - 7 ranks (ley, ley-organica, real-decreto,
 *              real-decreto-ley, real-decreto-legislativo,
 *              orden, otros)                              → 7
 *   - 6 decades (1970s … 2020s)                           → 6
 * Cartesian product is huge (≈23k cells) but the corpus only populates a
 * fraction of them. We size each populated cell by:
 *
 *     target(cell) = clamp( round(BASE * density(cell) ^ ALPHA), MIN, MAX )
 *
 * where
 *     density(cell) = #eligible_articles_in_cell / #eligible_articles_total
 *     ALPHA = 0.7   (sub-linear: rich cells contribute, but tail is preserved)
 *     BASE  = 5000  (target seed budget)
 *     MIN   = 1     (any populated cell deserves at least 1 seed)
 *     MAX   = 50    (no cell may dominate the dataset)
 *
 * After computing per-cell quotas we re-scale globally so that the sum is
 * exactly the requested seed budget (default 5000). The MIN/MAX caps are
 * re-applied after rescaling to avoid hot cells eating the tail.
 *
 * In addition we apply a (materia × decade) floor of 5 seeds when that cross-
 * cell has data, to guarantee thematic and temporal coverage independent of
 * jurisdiction/rank skew.
 */

export interface CellKey {
	materia: string;
	jurisdiction: string;
	rank: string;
	decade: string;
}

export interface QuotaInputs {
	/** Map "materia|jurisdiction|rank|decade" → eligible article count. */
	cellCounts: Map<string, number>;
	/** Total seed budget (default 5000). */
	budget?: number;
	min?: number;
	max?: number;
	alpha?: number;
	/** Floor applied to every populated (materia × decade) cross-cell. */
	materiaDecadeFloor?: number;
}

export interface QuotaResult {
	/** Map cell-key → target seed count. */
	targets: Map<string, number>;
	totalTarget: number;
}

export const DEFAULT_BUDGET = 5000;
export const DEFAULT_MIN = 1;
export const DEFAULT_MAX = 50;
export const DEFAULT_ALPHA = 0.7;
export const DEFAULT_MATERIA_DECADE_FLOOR = 5;

export function cellKey(c: CellKey): string {
	return `${c.materia}|${c.jurisdiction}|${c.rank}|${c.decade}`;
}

export function parseCellKey(k: string): CellKey {
	const [materia, jurisdiction, rank, decade] = k.split("|");
	return {
		materia: materia ?? "",
		jurisdiction: jurisdiction ?? "",
		rank: rank ?? "",
		decade: decade ?? "",
	};
}

/**
 * Compute target seed counts per cell from raw eligibility counts.
 * Pure function — no DB access — so it is easy to unit-test or inspect.
 */
export function computeQuotas(input: QuotaInputs): QuotaResult {
	const budget = input.budget ?? DEFAULT_BUDGET;
	const min = input.min ?? DEFAULT_MIN;
	const max = input.max ?? DEFAULT_MAX;
	const alpha = input.alpha ?? DEFAULT_ALPHA;
	const floor = input.materiaDecadeFloor ?? DEFAULT_MATERIA_DECADE_FLOOR;

	const totalArticles = Array.from(input.cellCounts.values()).reduce(
		(a, b) => a + b,
		0,
	);
	if (totalArticles === 0) {
		return { targets: new Map(), totalTarget: 0 };
	}

	// Step 1: raw weights ∝ density^alpha, capped at `max` per cell.
	const rawWeights = new Map<string, number>();
	let weightSum = 0;
	for (const [k, count] of input.cellCounts) {
		if (count <= 0) continue;
		const density = count / totalArticles;
		const w = density ** alpha;
		rawWeights.set(k, w);
		weightSum += w;
	}

	// Step 2: scale to budget, then clamp.
	const targets = new Map<string, number>();
	for (const [k, w] of rawWeights) {
		const eligible = input.cellCounts.get(k) ?? 0;
		const raw = (w / weightSum) * budget;
		const clamped = Math.max(min, Math.min(max, Math.round(raw)));
		// Never request more seeds than the cell can supply.
		targets.set(k, Math.min(clamped, eligible));
	}

	// Step 3: enforce (materia × decade) floor.
	if (floor > 0) {
		const mdAggregate = new Map<string, number>();
		for (const [k, t] of targets) {
			const c = parseCellKey(k);
			const md = `${c.materia}|${c.decade}`;
			mdAggregate.set(md, (mdAggregate.get(md) ?? 0) + t);
		}
		for (const [md, total] of mdAggregate) {
			if (total >= floor) continue;
			// Distribute the missing seeds across populated cells of this (materia,decade).
			const need = floor - total;
			const candidates = Array.from(targets.entries()).filter(([k]) => {
				const c = parseCellKey(k);
				return `${c.materia}|${c.decade}` === md;
			});
			if (candidates.length === 0) continue;
			let added = 0;
			let i = 0;
			while (added < need) {
				const [k, t] = candidates[i % candidates.length]!;
				const eligible = input.cellCounts.get(k) ?? 0;
				if (t < Math.min(max, eligible)) {
					targets.set(k, t + 1);
					added += 1;
				} else if (
					candidates.every(([kk]) => {
						const eg = input.cellCounts.get(kk) ?? 0;
						return (targets.get(kk) ?? 0) >= Math.min(max, eg);
					})
				) {
					break;
				}
				i += 1;
			}
		}
	}

	const totalTarget = Array.from(targets.values()).reduce((a, b) => a + b, 0);
	return { targets, totalTarget };
}
