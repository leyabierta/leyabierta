#!/usr/bin/env bun
/**
 * Build the reranker fine-tuning dataset (Fase 1a of RAG-FT).
 *
 * Pipeline (3 stages, separate subcommands so each can be audited and re-run):
 *
 *   sample    Pick articles from the DB stratified by jurisdiction × rank.
 *             Output: reranker-articles-batch.jsonl (deterministic, seeded).
 *
 *   queries   (next PR) Hand the sampled batch to Claude Code subagents,
 *             one per jurisdiction shard, for query generation.
 *
 *   assemble  (next PR) Combine generated queries with mined hard negatives
 *             into the final reranker-v1.jsonl.
 *
 * Spec: packages/api/research/RAG-FT-PLAN.md → "Fase 1a — Dataset implementation spec".
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
		const lines = all.map((a) => JSON.stringify(a));
		writeFileSync(args.outPath, `${lines.join("\n")}\n`, "utf8");
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

function parseArgs(argv: readonly string[]): SampleArgs & { command: string } {
	const command = argv[0] ?? "";
	const opts: Record<string, string> = {};
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const eq = arg.indexOf("=");
		if (eq > 0) {
			opts[arg.slice(2, eq)] = arg.slice(eq + 1);
		} else {
			opts[arg.slice(2)] = argv[++i] ?? "";
		}
	}
	return {
		command,
		dbPath: resolve(opts.db ?? "data/leyabierta.db"),
		outPath: resolve(
			opts.out ??
				"packages/api/research/datasets/reranker-articles-batch.jsonl",
		),
		total: Number.parseInt(opts.total ?? "50", 10),
		seed: Number.parseInt(opts.seed ?? "42", 10),
	};
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	if (args.command === "sample") {
		sampleCommand(args);
	} else {
		console.error(
			"Usage: bun run packages/api/research/build-reranker-dataset.ts sample [--total N] [--seed N] [--db PATH] [--out PATH]",
		);
		process.exit(1);
	}
}
