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
	type CellKey,
	cellKey,
	computeQuotas,
	DEFAULT_BUDGET,
	type QuotaResult,
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

	constructor(opts: StratifiedSamplerOptions = {}) {
		this.dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
		this.db = new Database(this.dbPath, { readonly: true });
		this.budget = opts.budget ?? DEFAULT_BUDGET;
		this.rng = mulberry32(opts.seed ?? 0xc0ffee);
	}

	close(): void {
		this.db.close();
	}

	// ── public API ────────────────────────────────────────────────────────

	async sample(opts: {
		n: number;
		seenSeeds: Set<string>;
	}): Promise<ArticleSeed[]> {
		this.ensureLoaded();
		const cells = this.candidatesByCell!;
		const targets = this.snapshot!.quotas.targets;

		// Cell ordering: largest target first, so smaller cells aren't starved
		// when the global cap `n` is tight.
		const cellOrder = Array.from(targets.entries())
			.filter(([, t]) => t > 0)
			.sort((a, b) => b[1] - a[1])
			.map(([k]) => k);

		const out: ArticleSeed[] = [];
		const used = new Set<string>(opts.seenSeeds);

		// Per-cell usage counters relative to the requested n.
		const totalQuota = Array.from(targets.values()).reduce((a, b) => a + b, 0);
		const scale = totalQuota > 0 ? opts.n / totalQuota : 0;

		for (const key of cellOrder) {
			if (out.length >= opts.n) break;
			const target = targets.get(key) ?? 0;
			// Scale per-cell target down to the requested n.
			const scaled = Math.max(1, Math.round(target * scale));
			const want = Math.min(scaled, opts.n - out.length);
			if (want <= 0) continue;
			const pool = cells.get(key);
			if (!pool || pool.length === 0) continue;
			const picked = this.weightedReservoir(pool, want, used);
			for (const c of picked) {
				const seedKey = `${c.normId}#${c.articleId}`;
				if (used.has(seedKey)) continue;
				used.add(seedKey);
				out.push(this.toSeed(c));
				if (out.length >= opts.n) break;
			}
		}

		// If we still have budget left (cells were exhausted), do a second
		// pass over all cells, ignoring per-cell quotas, weighted by reforms.
		if (out.length < opts.n) {
			const all = Array.from(cells.values()).flat();
			const picked = this.weightedReservoir(all, opts.n - out.length, used);
			for (const c of picked) {
				const seedKey = `${c.normId}#${c.articleId}`;
				if (used.has(seedKey)) continue;
				used.add(seedKey);
				out.push(this.toSeed(c));
				if (out.length >= opts.n) break;
			}
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
			const materiaList = n.materias
				? n.materias.split("\t").filter(Boolean)
				: [];
			// If the norm has no materias, file under "_other" so it still gets
			// covered (e.g. early constitutional norms with no analisis tags).
			const bucketed = materiaList.length
				? materiaList.map((m) =>
						this.topMateriaSet!.has(m) ? m : OTHER_BUCKET,
					)
				: [OTHER_BUCKET];
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
		const rows = this.db
			.query<{ materia: string }, []>(
				`SELECT m.materia AS materia
				   FROM materias m
				   JOIN norms n ON n.id = m.norm_id
				  WHERE n.status = 'vigente'
			   GROUP BY m.materia
			   ORDER BY COUNT(DISTINCT m.norm_id) DESC
				  LIMIT $limit`.replace("$limit", String(TOP_MATERIAS)),
			)
			.all();
		return new Set(rows.map((r) => r.materia));
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
				  LIMIT ${TOP_MATERIAS}`,
			)
			.all();
		return rows.map((r) => ({ materia: r.materia, norms: r.n }));
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
		// Pick the first non-_other materia tag (the "primary" topic) for the seed.
		const primaryMateria =
			c.materias.find((m) => this.topMateriaSet?.has(m)) ??
			c.materias[0] ??
			OTHER_BUCKET;
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
	): Candidate[] {
		if (k <= 0 || pool.length === 0) return [];
		const heap: { key: number; c: Candidate }[] = [];
		for (const c of pool) {
			const seedKey = `${c.normId}#${c.articleId}`;
			if (used.has(seedKey)) continue;
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
