#!/usr/bin/env bun
/**
 * Build the reranker fine-tuning dataset (Fase 1a of RAG-FT).
 *
 * Pipeline (3 stages, separate subcommands so each can be audited and re-run):
 *
 *   sample    Pick articles from the DB stratified by jurisdiction × rank.
 *             Output: reranker-articles-batch.jsonl (deterministic, seeded).
 *
 *   queries   Hand the sampled batch to Claude Code subagents, one per
 *             jurisdiction shard, for query generation. Output:
 *             reranker-queries-{state,ccaa}.jsonl (run by subagents, not
 *             by this script).
 *
 *   assemble  Combine generated queries with mined hard negatives
 *             (semantic-topk via BM25 + materia-sibling via DB join) into
 *             the final reranker-v1.jsonl + meta.
 *
 * Spec: packages/api/research/RAG-FT-PLAN.md → "Fase 1a — Dataset implementation spec".
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bm25ArticleSearch } from "../src/services/rag/blocks-fts.ts";

export type SampledArticle = {
	norm_id: string;
	block_id: string;
	block_type: string;
	title: string;
	text: string;
	rank: string;
	jurisdiction: string;
	published_at: string;
};

// Jurisdiction strata weights. State (~70%) vs CCAA (~30%) mirrors the rough
// split we see in the eval set; CCAA is split equally across regions to avoid
// the biggest CCAA dominating just because it has more articles.
export const JURISDICTION_WEIGHTS = {
	state: 0.7,
	ccaa: 0.3,
} as const;

// Rank weights inside each jurisdiction stratum. Heavier weight on leyes
// (orgánicas + ordinarias) because those are what citizens ask about.
export const RANK_WEIGHTS: Record<string, number> = {
	ley_organica: 0.25,
	ley: 0.4,
	real_decreto_ley: 0.1,
	real_decreto_legislativo: 0.05,
	real_decreto: 0.15,
	orden: 0.05,
	// Everything else (instruccion, circular, otro, acuerdo_internacional,
	// decreto, constitucion) is filtered out at the SQL level — they're
	// either too few or not what citizens typically ask about.
};

const ALLOWED_RANKS = Object.keys(RANK_WEIGHTS);

/**
 * Tiny deterministic PRNG (mulberry32) so sampling is reproducible across
 * machines without bringing in a dependency.
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
	const out = arr.slice();
	const rand = mulberry32(seed);
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * Allocate `total` items across strata in proportion to their weights, with
 * "largest remainder" rounding so the sum is always exactly `total`.
 *
 * Strata with weight 0 always get 0. Negative weights are rejected.
 */
export function allocateByWeight(
	total: number,
	weights: Record<string, number>,
): Record<string, number> {
	if (!Number.isInteger(total) || total < 0) {
		throw new Error(`total must be a non-negative integer, got ${total}`);
	}
	const keys = Object.keys(weights);
	for (const k of keys) {
		if (weights[k] < 0 || !Number.isFinite(weights[k])) {
			throw new Error(`invalid weight for "${k}": ${weights[k]}`);
		}
	}
	const sum = keys.reduce((s, k) => s + weights[k], 0);
	if (sum === 0) {
		return Object.fromEntries(keys.map((k) => [k, 0]));
	}
	const raw = Object.fromEntries(
		keys.map((k) => [k, (weights[k] / sum) * total]),
	);
	const floor = Object.fromEntries(
		keys.map((k) => [k, Math.floor(raw[k])] as const),
	);
	let allocated = keys.reduce((s, k) => s + floor[k], 0);
	const remainders = keys
		.map((k) => ({ k, frac: raw[k] - floor[k] }))
		.sort((a, b) => b.frac - a.frac);
	let i = 0;
	while (allocated < total) {
		floor[remainders[i % remainders.length].k] += 1;
		allocated += 1;
		i += 1;
	}
	return floor;
}

export type ArticleFilterReason =
	| "ok"
	| "empty-text"
	| "too-short"
	| "derogatoria"
	| "wrong-block-type";

export function classifyArticle(row: {
	block_id: string;
	block_type: string;
	current_text: string;
}): ArticleFilterReason {
	if (row.block_type !== "precepto") return "wrong-block-type";
	if (!row.current_text || row.current_text.trim() === "") return "empty-text";
	if (row.current_text.length < 80) return "too-short";
	// Disposiciones derogatorias have block_id starting with "dd"
	// (e.g. "dd1", "ddunica"). They mostly say "se deroga X" and aren't
	// useful as positives for citizen queries.
	if (/^dd/.test(row.block_id)) return "derogatoria";
	return "ok";
}

type SampleArgs = {
	dbPath: string;
	outPath: string;
	total: number;
	seed: number;
};

function fetchPool(db: Database, stratum: "state" | "ccaa"): SampledArticle[] {
	const placeholders = ALLOWED_RANKS.map(() => "?").join(",");
	const jurisdictionClause =
		stratum === "state" ? "n.jurisdiction = 'es'" : "n.jurisdiction != 'es'";
	const sql = `
		SELECT
			b.norm_id      AS norm_id,
			b.block_id     AS block_id,
			b.block_type   AS block_type,
			b.title        AS title,
			b.current_text AS current_text,
			n.rank         AS rank,
			n.jurisdiction AS jurisdiction,
			n.published_at AS published_at
		FROM blocks b
		JOIN norms n ON n.id = b.norm_id
		WHERE n.status = 'vigente'
			AND b.block_type = 'precepto'
			AND length(b.current_text) >= 80
			AND b.block_id NOT LIKE 'dd%'
			AND n.rank IN (${placeholders})
			AND ${jurisdictionClause}
	`;
	const rows = db.query(sql).all(...ALLOWED_RANKS) as Array<{
		norm_id: string;
		block_id: string;
		block_type: string;
		title: string;
		current_text: string;
		rank: string;
		jurisdiction: string;
		published_at: string;
	}>;
	return rows
		.filter((r) => classifyArticle(r) === "ok")
		.map((r) => ({
			norm_id: r.norm_id,
			block_id: r.block_id,
			block_type: r.block_type,
			title: r.title,
			text: r.current_text,
			rank: r.rank,
			jurisdiction: r.jurisdiction,
			published_at: r.published_at,
		}));
}

export function pickFromPool(
	pool: readonly SampledArticle[],
	count: number,
	rankWeights: Record<string, number>,
	seed: number,
): SampledArticle[] {
	if (count === 0 || pool.length === 0) return [];
	const allocation = allocateByWeight(count, rankWeights);
	const byRank = new Map<string, SampledArticle[]>();
	for (const a of pool) {
		const list = byRank.get(a.rank) ?? [];
		list.push(a);
		byRank.set(a.rank, list);
	}
	const picked: SampledArticle[] = [];
	let unmetDemand = 0;
	for (const [rank, want] of Object.entries(allocation)) {
		const available = byRank.get(rank) ?? [];
		const shuffled = seededShuffle(available, seed + hashString(rank));
		const take = Math.min(want, shuffled.length);
		picked.push(...shuffled.slice(0, take));
		unmetDemand += want - take;
	}
	// Fill any unmet demand by drawing from the remaining pool uniformly.
	if (unmetDemand > 0) {
		const pickedKeys = new Set(picked.map((a) => `${a.norm_id}/${a.block_id}`));
		const leftovers = pool.filter(
			(a) => !pickedKeys.has(`${a.norm_id}/${a.block_id}`),
		);
		const shuffled = seededShuffle(leftovers, seed ^ 0x9e3779b9);
		picked.push(...shuffled.slice(0, unmetDemand));
	}
	return picked;
}

function hashString(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * Serialise a list of articles to JSONL (one row per article, trailing
 * newline). Pulled out of the sample command so we can emit the merged
 * batch and the per-jurisdiction shards through the same code path.
 */
export function articlesToJsonl(articles: readonly SampledArticle[]): string {
	if (articles.length === 0) return "";
	return `${articles.map((a) => JSON.stringify(a)).join("\n")}\n`;
}

/**
 * Split a sampled batch into the two jurisdiction shards used downstream
 * by the query-generation subagents. State = ES; CCAA = everything else
 * (es-ct, es-pv, es-vc, ...).
 */
export function splitArticlesByShard(articles: readonly SampledArticle[]): {
	state: SampledArticle[];
	ccaa: SampledArticle[];
} {
	const state: SampledArticle[] = [];
	const ccaa: SampledArticle[] = [];
	for (const a of articles) {
		if (a.jurisdiction === "es") state.push(a);
		else ccaa.push(a);
	}
	return { state, ccaa };
}

// ───── assemble: query + positive + hard negatives → training pair ─────

export type RankedCandidate = { norm_id: string; block_id: string };

export type HardNegative = {
	norm_id: string;
	block_id: string;
	text: string;
	source: "semantic-topk" | "materia-sibling";
};

/**
 * Filter a BM25-ranked list to drop the gold and same-norm siblings, then
 * select `count` items from positions [rangeStart, rangeEnd] of the filtered
 * list (clamped to bounds), seeded for reproducibility.
 *
 * Positions are 0-indexed against the *filtered* list so we don't waste range
 * picking the gold itself when it's the top hit. The spec asks for ranks 5-15
 * to balance "close enough to be confusable" with "wrong enough to teach a
 * useful signal".
 */
export function pickSemanticNegatives(
	ranked: readonly RankedCandidate[],
	goldNormId: string,
	count: number,
	rangeStart: number,
	rangeEnd: number,
	seed: number,
): RankedCandidate[] {
	const filtered = ranked.filter((r) => r.norm_id !== goldNormId);
	if (filtered.length === 0 || count <= 0) return [];
	const start = Math.max(0, rangeStart);
	const end = Math.min(filtered.length, rangeEnd + 1);
	const window = filtered.slice(start, end);
	if (window.length === 0) {
		// Range out of bounds — fall back to whatever filtered candidates exist.
		return seededShuffle(filtered, seed).slice(0, count);
	}
	return seededShuffle(window, seed).slice(0, count);
}

/**
 * Pick a precepto from a different norm whose materias overlap with the
 * gold's. Returns null if no candidate exists (rare but possible for very
 * niche materias).
 */
export function pickMateriaSibling(
	candidates: readonly { norm_id: string; block_id: string; text: string }[],
	goldNormId: string,
	seed: number,
): { norm_id: string; block_id: string; text: string } | null {
	const filtered = candidates.filter((c) => c.norm_id !== goldNormId);
	if (filtered.length === 0) return null;
	return seededShuffle(filtered, seed)[0];
}

type AssembleArgs = {
	dbPath: string;
	articlesPath: string;
	queriesPaths: string[];
	outPath: string;
	metaPath: string;
	seed: number;
	bm25TopK: number;
	semanticNegRange: [number, number];
	semanticNegCount: number;
};

type ArticleIndex = Map<string, SampledArticle>;
type QueryRow = {
	article: string;
	queries: { text: string; register: string }[];
	is_trap: boolean;
	skip_reason?: string;
};

function loadArticleIndex(path: string): ArticleIndex {
	const idx: ArticleIndex = new Map();
	const lines = readFileSync(path, "utf8").trim().split("\n");
	for (const line of lines) {
		const a = JSON.parse(line) as SampledArticle;
		idx.set(`${a.norm_id}/${a.block_id}`, a);
	}
	return idx;
}

function loadQueries(paths: readonly string[]): QueryRow[] {
	const rows: QueryRow[] = [];
	for (const path of paths) {
		const lines = readFileSync(path, "utf8").trim().split("\n");
		for (const line of lines) rows.push(JSON.parse(line));
	}
	return rows;
}

function fetchMateriaSiblingPool(
	db: Database,
	goldNormId: string,
	limit = 200,
): { norm_id: string; block_id: string; text: string }[] {
	// Find norms that share at least one materia with the gold and pull a
	// pool of preceptos from them. The pool is bounded so we don't OOM on
	// very common materias ("Empleo", "Vivienda").
	const sql = `
		WITH shared AS (
			SELECT DISTINCT m2.norm_id AS norm_id
			FROM materias m1
			JOIN materias m2 ON m1.materia = m2.materia
			WHERE m1.norm_id = ? AND m2.norm_id != ?
		)
		SELECT b.norm_id, b.block_id, b.current_text AS text
		FROM blocks b
		JOIN shared s ON s.norm_id = b.norm_id
		JOIN norms n ON n.id = b.norm_id
		WHERE b.block_type = 'precepto'
			AND length(b.current_text) >= 80
			AND b.block_id NOT LIKE 'dd%'
			AND n.status = 'vigente'
		ORDER BY RANDOM()
		LIMIT ?
	`;
	return db.query(sql).all(goldNormId, goldNormId, limit) as Array<{
		norm_id: string;
		block_id: string;
		text: string;
	}>;
}

function getBlockText(
	db: Database,
	normId: string,
	blockId: string,
): string | null {
	const row = db
		.query("SELECT current_text FROM blocks WHERE norm_id = ? AND block_id = ?")
		.get(normId, blockId) as { current_text: string } | null;
	return row?.current_text ?? null;
}

function assembleCommand(args: AssembleArgs): void {
	const articleIndex = loadArticleIndex(args.articlesPath);
	const queryRows = loadQueries(args.queriesPaths);
	const db = new Database(args.dbPath, { readonly: true });

	type Pair = {
		id: string;
		query: string;
		register: string;
		is_trap: boolean;
		positive: SampledArticle;
		hard_negatives: HardNegative[];
		meta: {
			generation: "synthetic-claude";
			generator_pass: "v1";
			created_at: string;
		};
	};

	const pairs: Pair[] = [];
	const today = new Date().toISOString().slice(0, 10);
	let pairCounter = 0;
	let skippedRows = 0;
	let missingPositives = 0;
	let noMateriaSibling = 0;

	try {
		for (const row of queryRows) {
			if (row.skip_reason || row.queries.length === 0) {
				skippedRows += 1;
				continue;
			}
			const positive = articleIndex.get(row.article);
			if (!positive) {
				missingPositives += 1;
				console.warn(`  ! missing positive for ${row.article}, skipping`);
				continue;
			}
			const materiaPool = fetchMateriaSiblingPool(db, positive.norm_id, 200);
			if (materiaPool.length === 0) noMateriaSibling += 1;

			for (let qi = 0; qi < row.queries.length; qi++) {
				const q = row.queries[qi];
				pairCounter += 1;
				const id = `rkr-${String(pairCounter).padStart(6, "0")}`;
				const seedBase = args.seed + hashString(`${row.article}|${qi}`);

				// Semantic-topk negatives via BM25 over the corpus.
				const ranked = bm25ArticleSearch(db, q.text, args.bm25TopK);
				const semNegs = pickSemanticNegatives(
					ranked.map((r) => ({ norm_id: r.normId, block_id: r.blockId })),
					positive.norm_id,
					args.semanticNegCount,
					args.semanticNegRange[0],
					args.semanticNegRange[1],
					seedBase,
				);
				const semNegRecords: HardNegative[] = [];
				for (const n of semNegs) {
					const text = getBlockText(db, n.norm_id, n.block_id);
					if (!text) continue;
					semNegRecords.push({
						norm_id: n.norm_id,
						block_id: n.block_id,
						text,
						source: "semantic-topk",
					});
				}

				// Materia-sibling.
				const sibling = pickMateriaSibling(
					materiaPool,
					positive.norm_id,
					seedBase ^ 0x9e3779b9,
				);
				const negatives: HardNegative[] = [...semNegRecords];
				if (sibling) {
					negatives.push({
						norm_id: sibling.norm_id,
						block_id: sibling.block_id,
						text: sibling.text,
						source: "materia-sibling",
					});
				}

				pairs.push({
					id,
					query: q.text,
					register: q.register,
					is_trap: row.is_trap,
					positive,
					hard_negatives: negatives,
					meta: {
						generation: "synthetic-claude",
						generator_pass: "v1",
						created_at: today,
					},
				});
			}
		}
	} finally {
		db.close();
	}

	mkdirSync(dirname(args.outPath), { recursive: true });
	writeFileSync(
		args.outPath,
		`${pairs.map((p) => JSON.stringify(p)).join("\n")}\n`,
		"utf8",
	);

	const bothNegTypes = pairs.filter(
		(p) =>
			p.hard_negatives.some((n) => n.source === "semantic-topk") &&
			p.hard_negatives.some((n) => n.source === "materia-sibling"),
	).length;
	const onlySemantic = pairs.filter(
		(p) =>
			p.hard_negatives.some((n) => n.source === "semantic-topk") &&
			!p.hard_negatives.some((n) => n.source === "materia-sibling"),
	).length;
	const onlySibling = pairs.filter(
		(p) =>
			!p.hard_negatives.some((n) => n.source === "semantic-topk") &&
			p.hard_negatives.some((n) => n.source === "materia-sibling"),
	).length;
	const noNegs = pairs.filter((p) => p.hard_negatives.length === 0).length;

	const meta = {
		generated_at: new Date().toISOString(),
		seed: args.seed,
		bm25_top_k: args.bm25TopK,
		semantic_neg_range: args.semanticNegRange,
		semantic_neg_count: args.semanticNegCount,
		input_articles: args.articlesPath,
		input_queries: args.queriesPaths,
		stats: {
			total_pairs: pairs.length,
			trap_pairs: pairs.filter((p) => p.is_trap).length,
			skipped_query_rows: skippedRows,
			missing_positives: missingPositives,
			pairs_with_both_negative_types: bothNegTypes,
			pairs_only_semantic: onlySemantic,
			pairs_only_materia_sibling: onlySibling,
			pairs_with_no_negatives: noNegs,
			gold_norms_with_no_materia_sibling: noMateriaSibling,
		},
	};
	writeFileSync(args.metaPath, `${JSON.stringify(meta, null, "\t")}\n`, "utf8");

	console.log(`Wrote ${pairs.length} pairs to ${args.outPath}`);
	console.log(`Wrote meta to ${args.metaPath}`);
	console.log(
		`  both-types ${bothNegTypes}/${pairs.length} (${
			pairs.length === 0 ? 0 : ((bothNegTypes / pairs.length) * 100).toFixed(1)
		}%)`,
	);
	console.log(
		`  only-semantic ${onlySemantic}, only-sibling ${onlySibling}, no-negs ${noNegs}`,
	);
	console.log(`  trap pairs: ${meta.stats.trap_pairs}`);
}

function sampleCommand(args: SampleArgs): void {
	const db = new Database(args.dbPath, { readonly: true });
	try {
		const allocation = allocateByWeight(args.total, JURISDICTION_WEIGHTS);
		const stateArticles = pickFromPool(
			fetchPool(db, "state"),
			allocation.state,
			RANK_WEIGHTS,
			args.seed,
		);
		const ccaaArticles = pickFromPool(
			fetchPool(db, "ccaa"),
			allocation.ccaa,
			RANK_WEIGHTS,
			args.seed + 1,
		);
		const all = [...stateArticles, ...ccaaArticles];
		mkdirSync(dirname(args.outPath), { recursive: true });
		writeFileSync(args.outPath, articlesToJsonl(all), "utf8");
		// Also emit per-jurisdiction shards next to the merged batch so the
		// downstream query-generation step can hand one shard per subagent
		// without an ad-hoc split.
		const shards = splitArticlesByShard(all);
		const dir = dirname(args.outPath);
		const baseName = "reranker-articles-shard";
		writeFileSync(
			`${dir}/${baseName}-state.jsonl`,
			articlesToJsonl(shards.state),
			"utf8",
		);
		writeFileSync(
			`${dir}/${baseName}-ccaa.jsonl`,
			articlesToJsonl(shards.ccaa),
			"utf8",
		);
		const distByJur = new Map<string, number>();
		const distByRank = new Map<string, number>();
		for (const a of all) {
			distByJur.set(a.jurisdiction, (distByJur.get(a.jurisdiction) ?? 0) + 1);
			distByRank.set(a.rank, (distByRank.get(a.rank) ?? 0) + 1);
		}
		console.log(`Wrote ${all.length} articles to ${args.outPath}`);
		console.log(
			"  state/ccaa:",
			JSON.stringify({
				state: stateArticles.length,
				ccaa: ccaaArticles.length,
			}),
		);
		console.log(
			"  by jurisdiction:",
			JSON.stringify(Object.fromEntries(distByJur)),
		);
		console.log("  by rank:", JSON.stringify(Object.fromEntries(distByRank)));
	} finally {
		db.close();
	}
}

function parseRawOpts(argv: readonly string[]): {
	command: string;
	opts: Record<string, string | string[]>;
} {
	const command = argv[0] ?? "";
	const opts: Record<string, string | string[]> = {};
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const eq = arg.indexOf("=");
		const [k, v] =
			eq > 0
				? [arg.slice(2, eq), arg.slice(eq + 1)]
				: [arg.slice(2), argv[++i] ?? ""];
		const existing = opts[k];
		if (existing === undefined) {
			opts[k] = v;
		} else if (Array.isArray(existing)) {
			existing.push(v);
		} else {
			opts[k] = [existing, v];
		}
	}
	return { command, opts };
}

function parseSampleArgs(opts: Record<string, string | string[]>): SampleArgs {
	const get = (k: string, d: string) => {
		const v = opts[k];
		return typeof v === "string" ? v : Array.isArray(v) ? v[0] : d;
	};
	return {
		dbPath: resolve(get("db", "data/leyabierta.db")),
		outPath: resolve(
			get(
				"out",
				"packages/api/research/datasets/reranker-articles-batch.jsonl",
			),
		),
		total: Number.parseInt(get("total", "50"), 10),
		seed: Number.parseInt(get("seed", "42"), 10),
	};
}

function parseAssembleArgs(
	opts: Record<string, string | string[]>,
): AssembleArgs {
	const get = (k: string, d: string) => {
		const v = opts[k];
		return typeof v === "string" ? v : Array.isArray(v) ? v[0] : d;
	};
	const queriesRaw = opts.queries ?? [];
	const queriesPaths = (Array.isArray(queriesRaw) ? queriesRaw : [queriesRaw])
		.filter((s): s is string => typeof s === "string" && s.length > 0)
		.map((s) => resolve(s));
	if (queriesPaths.length === 0) {
		throw new Error(
			"--queries <path> is required (repeat flag for multiple shards)",
		);
	}
	const range = get("semantic-neg-range", "5,15")
		.split(",")
		.map((s) => Number.parseInt(s.trim(), 10));
	if (range.length !== 2 || range.some((n) => !Number.isFinite(n))) {
		throw new Error(
			`invalid --semantic-neg-range: ${get("semantic-neg-range", "")}`,
		);
	}
	return {
		dbPath: resolve(get("db", "data/leyabierta.db")),
		articlesPath: resolve(
			get(
				"articles",
				"packages/api/research/datasets/reranker-articles-batch.jsonl",
			),
		),
		queriesPaths,
		outPath: resolve(
			get("out", "packages/api/research/datasets/reranker-v1.jsonl"),
		),
		metaPath: resolve(
			get("meta", "packages/api/research/datasets/reranker-v1.meta.json"),
		),
		seed: Number.parseInt(get("seed", "42"), 10),
		bm25TopK: Number.parseInt(get("bm25-top-k", "30"), 10),
		semanticNegRange: [range[0], range[1]],
		semanticNegCount: Number.parseInt(get("semantic-neg-count", "2"), 10),
	};
}

if (import.meta.main) {
	const { command, opts } = parseRawOpts(process.argv.slice(2));
	if (command === "sample") {
		sampleCommand(parseSampleArgs(opts));
	} else if (command === "assemble") {
		assembleCommand(parseAssembleArgs(opts));
	} else {
		console.error(`Unknown command "${command}".

Usage:
  sample    --total N --seed N --db PATH --out PATH
  assemble  --articles PATH --queries PATH [--queries PATH ...] --out PATH --meta PATH
            [--db PATH] [--seed N] [--bm25-top-k 30]
            [--semantic-neg-range 5,15] [--semantic-neg-count 2]
`);
		process.exit(1);
	}
}
