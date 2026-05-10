/**
 * Stratified sampler for the eval dataset generator.
 *
 * Reads from the local SQLite DB (read-only) and produces (norm, article) seeds
 * balanced across (materia × jurisdiction × rank × decade) cells, weighted by
 * `reforms_count` (proxy for legal importance) with a small dose of randomness
 * for diversity.
 */

import { Database } from "bun:sqlite";
import type { ArticleSeed, Sampler } from "../agents/types.ts";
import {
	ALWAYS_KEEP_MATERIAS,
	type CellKey,
	cellKey,
	computeQuotas,
	DEFAULT_BUDGET,
	GEOGRAPHIC_MATERIAS,
	parseCellKey,
	type QuotaResult,
	UNCLASSIFIED_BUCKET,
} from "./quotas.ts";

// ── Tunables ──────────────────────────────────────────────────────────────

export const DEFAULT_DB_PATH = "data/leyabierta.db";

/** Top-N most common materias kept as their own bucket; rest collapsed to `_other`. */
export const TOP_MATERIAS = 30;

/** Jurisdictions with at least this many vigente norms get their own bucket. */
export const JURISDICTION_MIN_NORMS = 50;

/** Articles shorter than this are considered stubs. */
export const MIN_ARTICLE_CHARS = 200;

/** Truncate prefetched article text to this many chars to keep seeds light. */
export const ARTICLE_TEXT_TRUNCATE = 2000;

/** Canonical rank labels exposed in seeds and quotas. */
export const RANK_LABELS = [
	"ley",
	"ley-organica",
	"real-decreto",
	"real-decreto-ley",
	"real-decreto-legislativo",
	"orden",
	"otros",
] as const;
export type RankLabel = (typeof RANK_LABELS)[number];

/** Canonical decade labels. */
export const DECADE_LABELS = [
	"1970s",
	"1980s",
	"1990s",
	"2000s",
	"2010s",
	"2020s",
] as const;
export type DecadeLabel = (typeof DECADE_LABELS)[number];

export const OTHER_BUCKET = "_other";

/**
 * Default run-level target shares per jurisdiction. The pilot 50 spent all
 * 50 seats on `es` and `es-ct` because per-batch jurisdiction allocation
 * with n=2 only ever reached the top-2 quota holders. Tracking emitted
 * counts across all `sample()` calls and re-deriving deficits before each
 * batch is what fixes this.
 *
 * Values are renormalized over the *populated* jurisdictions at runtime so
 * a missing community (e.g. a small one with no cells) doesn't waste seats.
 * Override via `StratifiedSamplerOptions.targetJurisdictionShares`.
 */
export const DEFAULT_JURISDICTION_SHARES: Readonly<Record<string, number>> = {
	es: 0.5,
	"es-ct": 0.1,
	"es-an": 0.05,
	"es-pv": 0.05,
	"es-vc": 0.05,
	"es-ga": 0.05,
	"es-ar": 0.05,
	"es-cm": 0.03,
	"es-cl": 0.03,
	"es-mc": 0.02,
	"es-ib": 0.02,
	"es-cn": 0.02,
	"es-nc": 0.01,
	"es-ex": 0.01,
	"es-ri": 0.01,
	"es-ast": 0.01,
	"es-cb": 0.01,
	"es-md": 0.01,
};

// ── Helpers ────────────────────────────────────────────────────────────────

export function normalizeRank(raw: string): RankLabel {
	const r = raw.replace(/_/g, "-");
	switch (r) {
		case "ley":
		case "ley-organica":
		case "real-decreto":
		case "real-decreto-ley":
		case "real-decreto-legislativo":
		case "orden":
			return r;
		default:
			return "otros";
	}
}

export function decadeOf(publishedAt: string): DecadeLabel | null {
	const m = /^(\d{4})/.exec(publishedAt);
	if (!m) return null;
	const year = Number.parseInt(m[1]!, 10);
	if (year < 1970 || year >= 2030) return null;
	const start = Math.floor(year / 10) * 10;
	return `${start}s` as DecadeLabel;
}

/**
 * Article block_ids look like `a1`, `a1-2`, `a23`. Disposiciones look like
 * `da*`, `df*`, `dt*`, `dd*`. The `block_id GLOB 'a[0-9]*'` pattern keeps the
 * first set and excludes the second (and assorted oddities like `ar`).
 */
const ARTICLE_BLOCK_GLOB = "a[0-9]*";

// ── DB row shapes ─────────────────────────────────────────────────────────

interface NormRow {
	id: string;
	rank: string;
	jurisdiction: string;
	published_at: string;
	reforms_count: number;
	materias: string; // tab-joined
}

interface ArticleRow {
	norm_id: string;
	block_id: string;
	title: string;
	current_text: string;
}

// ── Internal seed candidate ───────────────────────────────────────────────

interface Candidate {
	normId: string;
	articleId: string;
	articleTitle: string;
	articleText: string;
	materias: string[];
	jurisdiction: string;
	rank: RankLabel;
	publishedAt: string;
	decade: DecadeLabel;
	reformsCount: number;
}

// ── Distribution snapshot for `inspect` ───────────────────────────────────

export interface CorpusSnapshot {
	totalNormsVigente: number;
	totalArticlesEligible: number;
	topMaterias: { materia: string; norms: number }[];
	jurisdictions: { jurisdiction: string; norms: number; bucket: string }[];
	cellCounts: Map<string, number>;
	quotas: QuotaResult;
}

// ── Sampler ───────────────────────────────────────────────────────────────

export interface StratifiedSamplerOptions {
	dbPath?: string;
	budget?: number;
	seed?: number; // deterministic randomness
	/**
	 * Run-level target shares per jurisdiction (must sum to ≤ 1). The
	 * sampler renormalizes over jurisdictions that actually have populated
	 * cells before applying. If omitted, `DEFAULT_JURISDICTION_SHARES` is
	 * used. Useful for pilots where you want a specific geographic mix.
	 */
	targetJurisdictionShares?: Readonly<Record<string, number>>;
}

/**
 * Tiny mulberry32 PRNG so tests / the inspector can be reproducible.
 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export class StratifiedSampler implements Sampler {
	readonly dbPath: string;
	private readonly db: Database;
	private readonly budget: number;
	private readonly rng: () => number;

	private topMateriaSet: Set<string> | null = null;
	private jurisdictionSet: Set<string> | null = null;
	private candidatesByCell: Map<string, Candidate[]> | null = null;
	private snapshot: CorpusSnapshot | null = null;

	/**
	 * Run-level state: total seeds emitted, broken down by jurisdiction.
	 * Persists across `sample()` calls so the deficit-based allocation can
	 * see the *cumulative* shortfall, not just per-batch counts. This is the
	 * fix for the pilot 50 jurisdiction-coverage bug.
	 */
	private emittedByJur: Map<string, number> = new Map();
	private totalEmitted = 0;

	private readonly targetJurisdictionShares: Readonly<Record<string, number>>;

	constructor(opts: StratifiedSamplerOptions = {}) {
		this.dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
		this.db = new Database(this.dbPath, { readonly: true });
		this.budget = opts.budget ?? DEFAULT_BUDGET;
		this.rng = mulberry32(opts.seed ?? 0xc0ffee);
		this.targetJurisdictionShares =
			opts.targetJurisdictionShares ?? DEFAULT_JURISDICTION_SHARES;
	}

	close(): void {
		this.db.close();
	}

	// ── public API ────────────────────────────────────────────────────────

	async sample(opts: {
		n: number;
		seenSeeds: Set<string>;
		maxPerNorm?: number;
		/**
		 * Norm IDs to NEVER sample as primary seeds. Used for the held-out
		 * eval set: those normIds back the human gold-standard questions and
		 * must stay invisible to the agentic generator so the final eval is
		 * unbiased. Caller (cli.ts) passes the set from `heldoutNormIds()`.
		 */
		excludeNormIds?: Set<string>;
	}): Promise<ArticleSeed[]> {
		this.ensureLoaded();
		const cells = this.candidatesByCell!;
		const targets = this.snapshot!.quotas.targets;

		// Per-norm cap. Default 3 — caller can override. The sampler
		// enforces the cap itself by deriving per-norm counts from
		// `seenSeeds` (every entry is `normId#articleId`), so the caller
		// only needs to thread `seenSeeds` through subsequent batches.
		// Previous default `ceil(budget/200)`=25 was effectively no cap and
		// is what let BOE-A-2010-13312 dominate the pilot 50.
		const maxPerNorm = opts.maxPerNorm ?? 3;

		const normDrawCounts = new Map<string, number>();
		for (const sk of opts.seenSeeds) {
			const hash = sk.indexOf("#");
			const normId = hash >= 0 ? sk.slice(0, hash) : sk;
			normDrawCounts.set(normId, (normDrawCounts.get(normId) ?? 0) + 1);
		}

		const out: ArticleSeed[] = [];
		const used = new Set<string>(opts.seenSeeds);

		const excludeNormIds = opts.excludeNormIds;
		const accept = (c: Candidate): boolean => {
			const seedKey = `${c.normId}#${c.articleId}`;
			if (used.has(seedKey)) return false;
			if (excludeNormIds?.has(c.normId)) return false;
			if ((normDrawCounts.get(c.normId) ?? 0) >= maxPerNorm) return false;
			used.add(seedKey);
			normDrawCounts.set(c.normId, (normDrawCounts.get(c.normId) ?? 0) + 1);
			out.push(this.toSeed(c));
			this.emittedByJur.set(
				c.jurisdiction,
				(this.emittedByJur.get(c.jurisdiction) ?? 0) + 1,
			);
			this.totalEmitted += 1;
			return true;
		};

		// ── Run-level deficit-based jurisdiction allocation ──
		// The pilot 50 lost all non-(es,es-ct) coverage because each batch
		// (n=2) re-ran a per-batch allocation that always rounded down to
		// the top two quota holders. We now keep cumulative emitted counts
		// in `this.emittedByJur` and, on each batch, compute how far each
		// populated jurisdiction is *behind* its target share assuming the
		// new batch lands. Seats are distributed across jurisdictions in
		// proportion to their cumulative deficit (largest-remainder
		// rounding), so under-served communities catch up over time even
		// when individual batches are tiny.
		const populatedJurs = new Set<string>();
		const cellsByJur = new Map<string, string[]>();
		for (const [k, t] of targets) {
			if (t <= 0) continue;
			const c = parseCellKey(k);
			populatedJurs.add(c.jurisdiction);
			const arr = cellsByJur.get(c.jurisdiction);
			if (arr) arr.push(k);
			else cellsByJur.set(c.jurisdiction, [k]);
		}
		for (const arr of cellsByJur.values()) {
			arr.sort((a, b) => (targets.get(b) ?? 0) - (targets.get(a) ?? 0));
		}

		const wantByJur = this.allocateByDeficit(populatedJurs, opts.n);
		// Iterate from largest want to smallest — this lets the bigger
		// jurisdiction (`es`) take its share early and leaves the tail of
		// the batch for under-represented ones.
		const jurOrder = Array.from(wantByJur.entries()).sort(
			(a, b) => b[1] - a[1],
		);

		for (const [j] of jurOrder) {
			const want = wantByJur.get(j) ?? 0;
			if (want <= 0) continue;
			const startedAt = out.length;
			for (const key of cellsByJur.get(j) ?? []) {
				if (out.length - startedAt >= want) break;
				if (out.length >= opts.n) break;
				const pool = cells.get(key);
				if (!pool || pool.length === 0) continue;
				const remaining = want - (out.length - startedAt);
				const picked = this.weightedReservoir(
					pool,
					remaining,
					used,
					normDrawCounts,
					maxPerNorm,
				);
				for (const c of picked) {
					if (out.length - startedAt >= want) break;
					if (out.length >= opts.n) break;
					accept(c);
				}
			}
		}

		// Fallback fill: if some jurisdictions couldn't supply their share
		// (cell exhausted, norm cap hit), top up with any remaining
		// candidates weighted by reforms_count.
		if (out.length < opts.n) {
			const all = Array.from(cells.values()).flat();
			const picked = this.weightedReservoir(
				all,
				opts.n - out.length,
				used,
				normDrawCounts,
				maxPerNorm,
			);
			for (const c of picked) {
				if (out.length >= opts.n) break;
				accept(c);
			}
		}

		return out;
	}

	/**
	 * Distribute `n` seats across `populatedJurs` proportional to each
	 * jurisdiction's run-level deficit (target_share × (totalEmitted+n) −
	 * already_emitted). Uses largest-remainder rounding so the integer
	 * counts sum exactly to `n` (modulo zero-deficit cases). When every
	 * jurisdiction is already at or above target, we fall back to the bare
	 * target-share split so the batch still gets work done.
	 */
	private allocateByDeficit(
		populatedJurs: Set<string>,
		n: number,
	): Map<string, number> {
		const out = new Map<string, number>();
		if (n <= 0 || populatedJurs.size === 0) return out;

		// Step 1: build the share table restricted to populated jurisdictions.
		const rawShares = new Map<string, number>();
		let shareSum = 0;
		for (const j of populatedJurs) {
			const s = this.targetJurisdictionShares[j] ?? 0;
			if (s > 0) {
				rawShares.set(j, s);
				shareSum += s;
			}
		}
		// Any populated jurisdiction missing from the share table gets a
		// tiny default share — enough to surface eventually but not enough
		// to crowd out explicit shares.
		const fallbackShare = 0.005;
		for (const j of populatedJurs) {
			if (!rawShares.has(j)) {
				rawShares.set(j, fallbackShare);
				shareSum += fallbackShare;
			}
		}
		// Renormalize to sum to 1.
		const shares = new Map<string, number>();
		for (const [j, s] of rawShares) shares.set(j, s / shareSum);

		// Step 2: cumulative deficit assuming the batch lands.
		const horizon = this.totalEmitted + n;
		const deficits = new Map<string, number>();
		let deficitSum = 0;
		for (const [j, s] of shares) {
			const expected = s * horizon;
			const actual = this.emittedByJur.get(j) ?? 0;
			const d = Math.max(0, expected - actual);
			deficits.set(j, d);
			deficitSum += d;
		}

		// Step 3: distribute seats by largest-remainder over deficits, or
		// fall back to plain shares if everyone is at target already.
		const weights = deficitSum > 0 ? deficits : new Map(shares);
		const weightSum =
			deficitSum > 0
				? deficitSum
				: Array.from(weights.values()).reduce((a, b) => a + b, 0);
		if (weightSum <= 0) return out;

		const fractional: { j: string; floor: number; rem: number }[] = [];
		let assigned = 0;
		for (const [j, w] of weights) {
			const exact = (w / weightSum) * n;
			const fl = Math.floor(exact);
			fractional.push({ j, floor: fl, rem: exact - fl });
			assigned += fl;
			out.set(j, fl);
		}
		// Hand out the remaining `n - assigned` seats to the largest
		// fractional remainders (classic largest-remainder method).
		fractional.sort((a, b) => b.rem - a.rem);
		let i = 0;
		while (assigned < n && i < fractional.length) {
			const { j } = fractional[i]!;
			out.set(j, (out.get(j) ?? 0) + 1);
			assigned += 1;
			i += 1;
		}
		// Edge case: if n > fractional.length (huge batch), keep cycling.
		while (assigned < n) {
			const { j } = fractional[i % fractional.length]!;
			out.set(j, (out.get(j) ?? 0) + 1);
			assigned += 1;
			i += 1;
		}
		return out;
	}

	/** Expose the corpus snapshot for `inspect.ts`. */
	getSnapshot(): CorpusSnapshot {
		this.ensureLoaded();
		return this.snapshot!;
	}

	// ── loading ───────────────────────────────────────────────────────────

	private ensureLoaded(): void {
		if (this.candidatesByCell) return;

		this.topMateriaSet = this.loadTopMaterias();
		this.jurisdictionSet = this.loadActiveJurisdictions();

		const norms = this.loadNorms();
		const articles = this.loadArticles();

		const articlesByNorm = new Map<string, ArticleRow[]>();
		for (const row of articles) {
			const arr = articlesByNorm.get(row.norm_id);
			if (arr) arr.push(row);
			else articlesByNorm.set(row.norm_id, [row]);
		}

		const cells = new Map<string, Candidate[]>();
		const cellCounts = new Map<string, number>();
		const topMateriasOrdered = this.loadTopMateriasOrdered();
		const jurisdictionCounts = this.loadJurisdictionCounts();

		let totalArticles = 0;

		for (const n of norms) {
			const rank = normalizeRank(n.rank);
			const decade = decadeOf(n.published_at);
			if (!decade) continue;
			const jurisdiction = this.jurisdictionSet!.has(n.jurisdiction)
				? n.jurisdiction
				: OTHER_BUCKET;
			// Drop geographic materia tags ("Cataluña", "Canarias", …) — they
			// are jurisdictions, not subject areas, and the BOE materia table
			// mixes them in. Jurisdiction is already its own axis, so keeping
			// them would produce nonsensical cells like
			// (materia=Cataluña × jurisdiction=es).
			const materiaList = n.materias
				? n.materias
						.split("\t")
						.filter(Boolean)
						.filter((m) => !GEOGRAPHIC_MATERIAS.has(m))
				: [];
			// If the norm has no thematic materias (either never tagged, or
			// only tagged geographically), file it under `_unclassified` —
			// distinct from `_other` (long-tail thematic) so the inspector
			// can tell them apart.
			const bucketed = materiaList.length
				? materiaList.map((m) =>
						this.topMateriaSet!.has(m) ? m : OTHER_BUCKET,
					)
				: [UNCLASSIFIED_BUCKET];
			// De-dup so a norm tagged with multiple "_other" materias doesn't
			// double-count in its own cell.
			const materiaBuckets = Array.from(new Set(bucketed));

			const arts = articlesByNorm.get(n.id);
			if (!arts || arts.length === 0) continue;

			for (const a of arts) {
				if (a.current_text.length < MIN_ARTICLE_CHARS) continue;
				totalArticles += 1;
				for (const materia of materiaBuckets) {
					const ck: CellKey = { materia, jurisdiction, rank, decade };
					const key = cellKey(ck);
					const cand: Candidate = {
						normId: a.norm_id,
						articleId: a.block_id,
						articleTitle: a.title,
						articleText: a.current_text,
						materias: materiaList,
						jurisdiction,
						rank,
						publishedAt: n.published_at,
						decade,
						reformsCount: n.reforms_count,
					};
					const arr = cells.get(key);
					if (arr) arr.push(cand);
					else cells.set(key, [cand]);
					cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
				}
			}
		}

		const quotas = computeQuotas({ cellCounts, budget: this.budget });

		this.candidatesByCell = cells;
		this.snapshot = {
			totalNormsVigente: norms.length,
			totalArticlesEligible: totalArticles,
			topMaterias: topMateriasOrdered,
			jurisdictions: jurisdictionCounts,
			cellCounts,
			quotas,
		};
	}

	// ── DB queries ────────────────────────────────────────────────────────

	private loadTopMaterias(): Set<string> {
		// Pull more than TOP_MATERIAS rows and filter geographic tags client-
		// side, then truncate. We avoid a SQL `NOT IN (?, ?, ?, ...)` to keep
		// the query string static; the over-fetch is small.
		const rows = this.db
			.query<{ materia: string }, []>(
				`SELECT m.materia AS materia
				   FROM materias m
				   JOIN norms n ON n.id = m.norm_id
				  WHERE n.status = 'vigente'
			   GROUP BY m.materia
			   ORDER BY COUNT(DISTINCT m.norm_id) DESC
				  LIMIT ${TOP_MATERIAS + GEOGRAPHIC_MATERIAS.size + 5}`,
			)
			.all();
		const filtered = rows
			.filter((r) => !GEOGRAPHIC_MATERIAS.has(r.materia))
			.slice(0, TOP_MATERIAS);
		// Union with ALWAYS_KEEP so high-citizen-pain but low-volume
		// materias (Vivienda, Arrendamientos urbanos, Trabajo, IVA, …)
		// keep their own bucket instead of getting buried in `_other`,
		// which would render their MATERIA_BOOSTS entries unreachable.
		const set = new Set(filtered.map((r) => r.materia));
		for (const m of ALWAYS_KEEP_MATERIAS) set.add(m);
		return set;
	}

	private loadTopMateriasOrdered(): { materia: string; norms: number }[] {
		const rows = this.db
			.query<{ materia: string; n: number }, []>(
				`SELECT m.materia AS materia, COUNT(DISTINCT m.norm_id) AS n
				   FROM materias m
				   JOIN norms n ON n.id = m.norm_id
				  WHERE n.status = 'vigente'
			   GROUP BY m.materia
			   ORDER BY n DESC
				  LIMIT ${TOP_MATERIAS + GEOGRAPHIC_MATERIAS.size + 5}`,
			)
			.all();
		return rows
			.filter((r) => !GEOGRAPHIC_MATERIAS.has(r.materia))
			.slice(0, TOP_MATERIAS)
			.map((r) => ({ materia: r.materia, norms: r.n }));
	}

	private loadActiveJurisdictions(): Set<string> {
		const rows = this.db
			.query<{ jurisdiction: string }, []>(
				`SELECT jurisdiction
				   FROM norms
				  WHERE status = 'vigente'
			   GROUP BY jurisdiction
				 HAVING COUNT(*) >= ${JURISDICTION_MIN_NORMS}`,
			)
			.all();
		return new Set(rows.map((r) => r.jurisdiction));
	}

	private loadJurisdictionCounts(): {
		jurisdiction: string;
		norms: number;
		bucket: string;
	}[] {
		const rows = this.db
			.query<{ jurisdiction: string; n: number }, []>(
				`SELECT jurisdiction, COUNT(*) AS n
				   FROM norms
				  WHERE status = 'vigente'
			   GROUP BY jurisdiction
			   ORDER BY n DESC`,
			)
			.all();
		const active = this.jurisdictionSet ?? new Set<string>();
		return rows.map((r) => ({
			jurisdiction: r.jurisdiction,
			norms: r.n,
			bucket: active.has(r.jurisdiction) ? r.jurisdiction : OTHER_BUCKET,
		}));
	}

	private loadNorms(): NormRow[] {
		// `materias` is tab-joined to avoid an extra round-trip. Tab is safe:
		// materias never contain it.
		return this.db
			.query<NormRow, []>(
				`SELECT n.id          AS id,
					    n.rank        AS rank,
					    n.jurisdiction AS jurisdiction,
					    n.published_at AS published_at,
					    COALESCE(rc.cnt, 0) AS reforms_count,
					    COALESCE(mm.materias, '') AS materias
				   FROM norms n
			  LEFT JOIN (
					   SELECT norm_id, COUNT(*) AS cnt
						 FROM reforms
					 GROUP BY norm_id
					 ) rc ON rc.norm_id = n.id
			  LEFT JOIN (
					   SELECT norm_id, GROUP_CONCAT(materia, char(9)) AS materias
						 FROM materias
					 GROUP BY norm_id
					 ) mm ON mm.norm_id = n.id
				  WHERE n.status = 'vigente'`,
			)
			.all();
	}

	private loadArticles(): ArticleRow[] {
		return this.db
			.query<ArticleRow, []>(
				`SELECT b.norm_id      AS norm_id,
					    b.block_id     AS block_id,
					    b.title        AS title,
					    b.current_text AS current_text
				   FROM blocks b
				   JOIN norms  n ON n.id = b.norm_id
				  WHERE n.status     = 'vigente'
				    AND b.block_type = 'precepto'
				    AND b.block_id GLOB '${ARTICLE_BLOCK_GLOB}'
				    AND length(b.current_text) >= ${MIN_ARTICLE_CHARS}`,
			)
			.all();
	}

	// ── seed building ─────────────────────────────────────────────────────

	private toSeed(c: Candidate): ArticleSeed {
		const yearMatch = /^(\d{4})/.exec(c.publishedAt);
		const year = yearMatch ? Number.parseInt(yearMatch[1]!, 10) : 0;
		const text =
			c.articleText.length > ARTICLE_TEXT_TRUNCATE
				? `${c.articleText.slice(0, ARTICLE_TEXT_TRUNCATE)}…`
				: c.articleText;
		// Pick the first non-_other materia tag (the "primary" topic) for the
		// seed. `c.materias` has already been stripped of geographic tags in
		// `ensureLoaded`. If nothing thematic remains, surface
		// `_unclassified` (not `_other`) so downstream consumers can tell
		// "had no thematic materia" from "had a tail thematic materia".
		const primaryMateria =
			c.materias.find((m) => this.topMateriaSet?.has(m)) ??
			c.materias[0] ??
			UNCLASSIFIED_BUCKET;
		return {
			normId: c.normId,
			articleId: c.articleId,
			articleTitle: c.articleTitle,
			articleText: text,
			materia: primaryMateria,
			jurisdiction: c.jurisdiction,
			rank: c.rank,
			publicationYear: year,
		};
	}

	/**
	 * Weighted reservoir sampling (A-Res, Efraimidis & Spirakis 2006). Each
	 * candidate's "key" is `random()^(1/weight)` and we keep the top-k. With
	 * `weight = 1 + reformsCount`, more-reformed articles dominate but every
	 * eligible article has a non-zero shot, which is what we want for diversity.
	 *
	 * Skips candidates already in `used` so we don't pick the same seed twice
	 * across cells (the same article can appear in multiple materia buckets).
	 */
	private weightedReservoir(
		pool: Candidate[],
		k: number,
		used: Set<string>,
		normDrawCounts?: Map<string, number>,
		maxPerNorm?: number,
	): Candidate[] {
		if (k <= 0 || pool.length === 0) return [];
		const heap: { key: number; c: Candidate }[] = [];
		for (const c of pool) {
			const seedKey = `${c.normId}#${c.articleId}`;
			if (used.has(seedKey)) continue;
			if (
				maxPerNorm !== undefined &&
				normDrawCounts !== undefined &&
				(normDrawCounts.get(c.normId) ?? 0) >= maxPerNorm
			) {
				continue;
			}
			const w = 1 + c.reformsCount;
			const u = Math.max(this.rng(), 1e-12);
			const key = Math.log(u) / w; // equivalent ordering, avoids u^(1/w)=0
			heap.push({ key, c });
		}
		heap.sort((a, b) => b.key - a.key);
		// De-dup by (norm,article) within the picked set (a candidate can be
		// duplicated across materia buckets in the same cell — shouldn't happen
		// but cheap to defend).
		const out: Candidate[] = [];
		const seenLocal = new Set<string>();
		for (const { c } of heap) {
			const sk = `${c.normId}#${c.articleId}`;
			if (seenLocal.has(sk)) continue;
			seenLocal.add(sk);
			out.push(c);
			if (out.length >= k) break;
		}
		return out;
	}
}
