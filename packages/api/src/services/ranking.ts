/**
 * Authority-aware relevance scoring for law search (issue #131).
 *
 * Today's default relevance order in `services/db.ts` is purely a BM25
 * candidate-position order (exact title match → title BM25 → content BM25).
 * That has no notion of legal authority, normative rank, or lifecycle
 * status, so a `derogada` (repealed) norm can — and does — rank above the
 * `vigente` norm that replaced it whenever the repealed text happens to
 * match the query terms slightly better. That's the concrete bug issue
 * #131 is about.
 *
 * This module layers four signals on top of the existing BM25 order:
 *
 *   score = bm25Normalized
 *         × (1 + AUTHORITY_LOG_WEIGHT · log(1 + authorityScore))
 *         × rankWeight(rank)
 *         × statusPenalty(status)
 *         × jurisdictionBoost(jurisdiction)
 *
 * The combination is multiplicative, not additive, so every factor
 * defaults to 1.0 (a no-op) for values it doesn't special-case. That keeps
 * unrecognized `rank`/`status`/`jurisdiction` values inert instead of
 * crashing or silently zeroing out a result.
 *
 * This module is pure — no database access, no I/O, no bun:sqlite import.
 * `services/db.ts` is responsible for fetching the (rank, status,
 * jurisdiction, authority_score) tuple per candidate and handing it to
 * `reorderByAuthority` below. That split is deliberate: it's what makes
 * this file trivially unit-testable and keeps the SQL surface area for
 * issue #131 as small as possible (see services/db.ts for the integration,
 * kept intentionally minimal because issue #128 touches the same method).
 *
 * `authority_score` itself is precomputed (not calculated at query time) —
 * see packages/pipeline/src/db/authority.ts and
 * packages/api/src/scripts/recalculate-authority-scores.ts.
 */

// ── Tunable weights ──────────────────────────────────────────────────────
// All defaults are deliberately conservative: they nudge the relevance
// order BM25 already produced, they don't override it wholesale. A norm
// with a much stronger text match should generally still win over one
// that's merely more "authoritative" but barely matches the query — the
// exception this issue explicitly targets is the derogada/vigente case,
// where STATUS_PENALTIES does most of the work.
//
// Calibrate here, not at call sites — these are the only knobs to turn.

/**
 * Weight applied to log(1 + authorityScore). At authorityScore = 0 the
 * authority factor is exactly 1 (no-op) — norms with no recorded incoming
 * references are never penalized for it, only norms with many are boosted.
 * At the highest authority_score observed in production (~380 incoming
 * references — foundational norms like the Estatuto de los Trabajadores or
 * the Ley General de la Seguridad Social) the factor caps around 1.9×.
 */
export const AUTHORITY_LOG_WEIGHT = 0.15;

/**
 * peso_rango — normative hierarchy weight. Higher-rank instruments (leyes,
 * decretos-leyes, the Constitución) outrank administrative orders and
 * resolutions when text relevance is otherwise similar. Unrecognized rank
 * values fall back to DEFAULT_RANK_WEIGHT (neutral).
 */
export const RANK_WEIGHTS: Readonly<Record<string, number>> = {
	constitucion: 1.5,
	ley_organica: 1.35,
	ley: 1.25,
	real_decreto_ley: 1.2,
	real_decreto_legislativo: 1.2,
	acuerdo_internacional: 1.15,
	real_decreto: 1.1,
	decreto: 1.05,
	reglamento: 1.05,
	orden: 1.0,
	resolucion: 0.95,
	circular: 0.9,
	instruccion: 0.9,
	acuerdo: 0.9,
	otro: 0.85,
};
export const DEFAULT_RANK_WEIGHT = 1.0;

/**
 * penalización_estado — the core fix for issue #131. `vigente` (in force)
 * is a no-op. `derogada` (repealed) is penalized hard so it stops
 * outranking the vigente norm that superseded it.
 * `parcialmente_derogada` sits in between since part of the text is still
 * in force. Unrecognized status values fall back to DEFAULT_STATUS_PENALTY
 * (neutral) rather than being silently penalized.
 */
export const STATUS_PENALTIES: Readonly<Record<string, number>> = {
	vigente: 1.0,
	parcialmente_derogada: 0.75,
	derogada: 0.35,
};
export const DEFAULT_STATUS_PENALTY = 1.0;

/**
 * boost_jurisdicción — state-level (`es`) legislation applies to every
 * citizen regardless of where they live, so it gets a small boost over
 * regional legislation. Regional jurisdictions are left at the neutral 1.0
 * baseline — NOT penalized — so a search from/about a specific autonomous
 * community still surfaces its `es-xx` norms without them being pushed
 * down for being regional.
 */
export const JURISDICTION_BOOSTS: Readonly<Record<string, number>> = {
	es: 1.1,
};
export const DEFAULT_JURISDICTION_BOOST = 1.0;

export interface RankingSignals {
	/** Normalized text-relevance signal in (0, 1] — 1 is the strongest match. */
	bm25Normalized: number;
	/** Raw in-degree count from the referencias graph (>= 0). */
	authorityScore: number;
	rank: string;
	status: string;
	jurisdiction: string;
}

export function rankWeight(rank: string): number {
	return RANK_WEIGHTS[rank] ?? DEFAULT_RANK_WEIGHT;
}

export function statusPenalty(status: string): number {
	return STATUS_PENALTIES[status] ?? DEFAULT_STATUS_PENALTY;
}

export function jurisdictionBoost(jurisdiction: string): number {
	return JURISDICTION_BOOSTS[jurisdiction] ?? DEFAULT_JURISDICTION_BOOST;
}

function authorityFactor(authorityScore: number): number {
	// Guard against negative/NaN input from bad data rather than letting
	// Math.log1p produce NaN and poison the whole score.
	const safe = Number.isFinite(authorityScore)
		? Math.max(0, authorityScore)
		: 0;
	return 1 + AUTHORITY_LOG_WEIGHT * Math.log1p(safe);
}

/**
 * Combine BM25 relevance with authority, normative rank, lifecycle status,
 * and jurisdiction into a single ranking score. Pure: same inputs always
 * produce the same output, no DB access, no hidden state.
 */
export function computeRankingScore(signals: RankingSignals): number {
	return (
		signals.bm25Normalized *
		authorityFactor(signals.authorityScore) *
		rankWeight(signals.rank) *
		statusPenalty(signals.status) *
		jurisdictionBoost(signals.jurisdiction)
	);
}

/**
 * Convert a 0-based position in an already relevance-ordered candidate list
 * into a normalized BM25 signal in (0, 1]. `searchLaws`'s three-pass FTS
 * query (exact title → title BM25 → content BM25) already returns
 * candidates in relevance order but doesn't carry the underlying numeric
 * BM25 value out of SQLite, so position is used as a reciprocal-rank proxy
 * — the same convention the hybrid search path already uses for hybrid
 * fusion (see `services/rag/rrf.ts`).
 */
export function bm25NormalizedFromPosition(position: number): number {
	return 1 / (position + 1);
}

/** Per-candidate metadata needed to compute a ranking score for one norm. */
export interface AuthorityRankingCandidate {
	rank: string;
	status: string;
	jurisdiction: string;
	authorityScore: number;
}

/**
 * Re-sort an already relevance-ordered list of norm ids by
 * `computeRankingScore`, using each id's position in `orderedIds` as its
 * BM25 signal. Candidates missing from `metadataById` keep their original
 * position-based score (no authority/status/jurisdiction adjustment) rather
 * than being dropped — a missing lookup should never make a result vanish.
 *
 * Stable for ties: Array.prototype.sort is stable per spec, and ties are
 * additionally broken by original position to make that explicit.
 *
 * Pure — takes plain data in, returns plain data out.
 */
export function reorderByAuthority(
	orderedIds: readonly string[],
	metadataById: ReadonlyMap<string, AuthorityRankingCandidate>,
): string[] {
	const scored = orderedIds.map((id, position) => {
		const bm25Normalized = bm25NormalizedFromPosition(position);
		const meta = metadataById.get(id);
		const score = meta
			? computeRankingScore({ bm25Normalized, ...meta })
			: bm25Normalized;
		return { id, position, score };
	});

	scored.sort((a, b) => b.score - a.score || a.position - b.position);
	return scored.map((s) => s.id);
}
