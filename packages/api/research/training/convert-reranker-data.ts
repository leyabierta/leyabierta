#!/usr/bin/env bun
/**
 * Convert the assembled reranker dataset (`reranker-v1.jsonl`) into the
 * triplet format expected by sentence-transformers cross-encoder training.
 *
 * Each input pair has 1 query, 1 positive, and N hard negatives. The
 * converter expands this to N triplets per pair (one per negative), so
 * the training run sees each (query, positive) compared against every
 * hard negative.
 *
 * Input row (reranker-v1.jsonl):
 *   { id, query, register, is_trap, positive: {text, ...},
 *     hard_negatives: [{text, source, ...}, ...], meta: {...} }
 *
 * Output row (triplets.jsonl):
 *   { query, positive, negative, source, register, is_trap, pair_id }
 *
 * The `source`, `register`, `is_trap`, and `pair_id` fields are kept so
 * the trainer can apply per-stratum loss weighting if we decide to.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type RerankerPair = {
	id: string;
	query: string;
	register: string;
	is_trap: boolean;
	positive: { text: string };
	hard_negatives: Array<{
		text: string;
		source: "semantic-topk" | "materia-sibling";
	}>;
};

export type Triplet = {
	query: string;
	positive: string;
	negative: string;
	source: "semantic-topk" | "materia-sibling";
	register: string;
	is_trap: boolean;
	pair_id: string;
};

/**
 * Expand one (query, positive, N negatives) pair into N (query, positive,
 * negative) triplets. Skips pairs with no negatives (shouldn't happen at
 * pilot scale — the assembler enforces ≥1 of each type — but we don't
 * trust input invariants on a converter).
 */
export function pairToTriplets(pair: RerankerPair): Triplet[] {
	if (!pair.positive?.text || pair.hard_negatives.length === 0) return [];
	return pair.hard_negatives.map((neg) => ({
		query: pair.query,
		positive: pair.positive.text,
		negative: neg.text,
		source: neg.source,
		register: pair.register,
		is_trap: pair.is_trap,
		pair_id: pair.id,
	}));
}

/**
 * Truncate a passage (positive or negative) to a max char length. Cross-
 * encoders cap at ~512 tokens; we approximate with characters here so the
 * converter doesn't need a tokenizer dependency. The trainer can re-truncate
 * with the actual tokenizer; this just keeps the JSONL manageable.
 */
export function truncatePassage(text: string, maxChars = 2000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}…`;
}

export function applyTruncation(
	triplets: readonly Triplet[],
	maxChars: number,
): Triplet[] {
	return triplets.map((t) => ({
		...t,
		positive: truncatePassage(t.positive, maxChars),
		negative: truncatePassage(t.negative, maxChars),
	}));
}

type ConvertArgs = {
	inPath: string;
	outPath: string;
	maxChars: number;
	dropTraps: boolean;
};

function loadJsonl(path: string): RerankerPair[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as RerankerPair);
}

function writeJsonl(path: string, rows: readonly Triplet[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const body = rows.map((r) => JSON.stringify(r)).join("\n");
	writeFileSync(path, rows.length === 0 ? "" : `${body}\n`, "utf8");
}

function main(args: ConvertArgs): void {
	const pairs = loadJsonl(args.inPath);
	const filtered = args.dropTraps ? pairs.filter((p) => !p.is_trap) : pairs;
	const triplets = filtered.flatMap(pairToTriplets);
	const truncated = applyTruncation(triplets, args.maxChars);
	writeJsonl(args.outPath, truncated);

	const bySource = new Map<string, number>();
	const byRegister = new Map<string, number>();
	for (const t of truncated) {
		bySource.set(t.source, (bySource.get(t.source) ?? 0) + 1);
		byRegister.set(t.register, (byRegister.get(t.register) ?? 0) + 1);
	}
	console.log(`Read ${pairs.length} pairs from ${args.inPath}`);
	if (args.dropTraps) {
		console.log(`  dropped ${pairs.length - filtered.length} trap pairs`);
	}
	console.log(`Wrote ${truncated.length} triplets to ${args.outPath}`);
	console.log(
		`  by negative source: ${JSON.stringify(Object.fromEntries(bySource))}`,
	);
	console.log(
		`  by register: ${JSON.stringify(Object.fromEntries(byRegister))}`,
	);
}

function parseArgs(argv: readonly string[]): ConvertArgs {
	const opts: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const eq = a.indexOf("=");
		if (eq > 0) {
			opts[a.slice(2, eq)] = a.slice(eq + 1);
		} else {
			opts[a.slice(2)] = argv[++i] ?? "";
		}
	}
	return {
		inPath: resolve(
			opts.in ?? "packages/api/research/datasets/reranker-v1.jsonl",
		),
		outPath: resolve(
			opts.out ?? "packages/api/research/training/triplets.jsonl",
		),
		maxChars: Number.parseInt(opts["max-chars"] ?? "2000", 10),
		dropTraps: opts["drop-traps"] === "true",
	};
}

if (import.meta.main) {
	main(parseArgs(process.argv.slice(2)));
}
