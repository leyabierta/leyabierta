/**
 * Parse a filled-in review markdown (produced by a subagent on top of the
 * `build-review-input.ts` template) and emit:
 *   1. A summary markdown (counts by verdict, average score, breakdowns).
 *   2. A KEEP-only JSONL (subset of the original accepted JSONL).
 *   3. A MARGINAL+DROP JSONL (borderline queue for further iteration).
 *
 * Parsing is regex-based per-question section. Malformed sections are skipped
 * with a warning instead of crashing — the reviewer subagent's output will
 * never be perfectly machine-formatted.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { EvalQuestion } from "../schema.ts";

export type Verdict = "KEEP" | "MARGINAL" | "DROP";

export interface ReviewedQuestion {
	id: string;
	verdict: Verdict;
	scores: { c: number; a: number; l: number; s: number; total: number };
	rationale: string;
}

const SECTION_HEADER = /^##\s+Q\d+\s+—\s+(\S+)\s*$/m;
// Match a *filled-in* verdict line: a single value, not the unfilled
// "KEEP | MARGINAL | DROP" placeholder. We require the line to contain only the
// value (with optional surrounding whitespace / trailing punctuation).
const VERDICT_RE = /^Verdict:\s*(KEEP|MARGINAL|DROP)\s*$/im;
const SCORE_RE =
	/Score[^\n]*?=\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*=\s*(\d+)\s*\/\s*12/i;
const RATIONALE_RE = /^One-line rationale:\s*(.+?)\s*$/im;

export function parseReviewedMarkdown(md: string): {
	reviewed: ReviewedQuestion[];
	warnings: string[];
} {
	const warnings: string[] = [];
	const reviewed: ReviewedQuestion[] = [];

	// Split by ## Q\d+ headers; keep the headers with their section.
	const parts = md.split(/(?=^##\s+Q\d+\s+—\s+\S+\s*$)/m);
	for (const part of parts) {
		const headerMatch = part.match(SECTION_HEADER);
		if (!headerMatch) continue;
		const id = (headerMatch[1] ?? "").trim();

		const verdictMatch = part.match(VERDICT_RE);
		const scoreMatch = part.match(SCORE_RE);
		const rationaleMatch = part.match(RATIONALE_RE);

		if (!verdictMatch) {
			warnings.push(`[${id}] missing/unfilled Verdict line — skipping`);
			continue;
		}
		if (!scoreMatch) {
			warnings.push(`[${id}] missing/unfilled Score line — skipping`);
			continue;
		}
		const c = Number(scoreMatch[1]);
		const a = Number(scoreMatch[2]);
		const l = Number(scoreMatch[3]);
		const s = Number(scoreMatch[4]);
		const total = Number(scoreMatch[5]);
		if ([c, a, l, s, total].some((n) => Number.isNaN(n))) {
			warnings.push(`[${id}] non-numeric scores — skipping`);
			continue;
		}
		const rationale = rationaleMatch ? (rationaleMatch[1] ?? "").trim() : "";
		if (!rationale) {
			warnings.push(`[${id}] empty rationale (kept anyway)`);
		}

		reviewed.push({
			id,
			verdict: (verdictMatch[1] ?? "").toUpperCase() as Verdict,
			scores: { c, a, l, s, total },
			rationale,
		});
	}

	return { reviewed, warnings };
}

function avg(xs: number[]): number {
	if (xs.length === 0) return 0;
	return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function tally<T extends string>(xs: T[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const x of xs) out[x] = (out[x] ?? 0) + 1;
	return out;
}

function renderTable(title: string, counts: Record<string, number>): string {
	const lines: string[] = [];
	lines.push(`### ${title}`);
	lines.push("");
	lines.push("| Key | Count |");
	lines.push("|---|---|");
	const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	for (const [k, v] of entries) lines.push(`| ${k} | ${v} |`);
	lines.push("");
	return lines.join("\n");
}

export interface SummarizeOptions {
	reviewedMdPath: string;
	acceptedJsonlPath?: string;
	summaryOut: string;
	keepJsonlOut: string;
	marginalDropJsonlOut: string;
}

export function summarizeReview(opts: SummarizeOptions): {
	summary: string;
	kept: number;
	marginalDrop: number;
	warnings: string[];
} {
	const md = readFileSync(opts.reviewedMdPath, "utf8");
	const { reviewed, warnings } = parseReviewedMarkdown(md);
	for (const w of warnings) console.warn(`[summarize] ${w}`);

	const byId = new Map<string, ReviewedQuestion>();
	for (const r of reviewed) byId.set(r.id, r);

	// Optional: load original accepted JSONL to filter into KEEP / MARGINAL+DROP.
	let originalRows: EvalQuestion[] = [];
	const acceptedPath =
		opts.acceptedJsonlPath ?? guessAcceptedPath(opts.reviewedMdPath, md);
	if (acceptedPath) {
		try {
			const raw = readFileSync(acceptedPath, "utf8");
			originalRows = raw
				.split("\n")
				.filter((l) => l.trim().length > 0)
				.map((l) => JSON.parse(l) as EvalQuestion);
		} catch (e) {
			console.warn(
				`[summarize] could not load original accepted JSONL at ${acceptedPath}: ${(e as Error).message}`,
			);
		}
	}

	const keepRows: EvalQuestion[] = [];
	const marginalDropRows: EvalQuestion[] = [];
	for (const row of originalRows) {
		const r = byId.get(row.id);
		if (!r) continue;
		if (r.verdict === "KEEP") keepRows.push(row);
		else marginalDropRows.push(row);
	}

	writeFileSync(
		opts.keepJsonlOut,
		`${keepRows.map((r) => JSON.stringify(r)).join("\n")}${keepRows.length > 0 ? "\n" : ""}`,
	);
	writeFileSync(
		opts.marginalDropJsonlOut,
		`${marginalDropRows.map((r) => JSON.stringify(r)).join("\n")}${
			marginalDropRows.length > 0 ? "\n" : ""
		}`,
	);

	// Build summary markdown.
	const verdictCounts = tally(reviewed.map((r) => r.verdict));
	const totals = reviewed.map((r) => r.scores.total);
	const keepIds = new Set(
		reviewed.filter((r) => r.verdict === "KEEP").map((r) => r.id),
	);
	const keepRowsForBreakdown = originalRows.filter((r) => keepIds.has(r.id));
	const voiceCountsKeep = tally(keepRowsForBreakdown.map((r) => r.voice));
	const materiaCountsKeep = tally(keepRowsForBreakdown.map((r) => r.materia));

	const lines: string[] = [];
	lines.push(`# Review summary — ${opts.reviewedMdPath.split("/").pop()}`);
	lines.push("");
	lines.push(`- Generated: ${new Date().toISOString()}`);
	lines.push(`- Reviewed sections parsed: ${reviewed.length}`);
	lines.push(`- Original accepted rows loaded: ${originalRows.length}`);
	lines.push(`- Warnings: ${warnings.length}`);
	lines.push("");

	lines.push("## Verdict distribution");
	lines.push("");
	lines.push("| Verdict | Count | % |");
	lines.push("|---|---|---|");
	const total = reviewed.length || 1;
	for (const v of ["KEEP", "MARGINAL", "DROP"] as const) {
		const n = verdictCounts[v] ?? 0;
		lines.push(`| ${v} | ${n} | ${((100 * n) / total).toFixed(1)}% |`);
	}
	lines.push("");

	lines.push("## Score stats");
	lines.push("");
	lines.push(`- Average total: **${avg(totals).toFixed(2)} / 12**`);
	lines.push(
		`- Average C/A/L/S: ${avg(reviewed.map((r) => r.scores.c)).toFixed(2)} / ${avg(
			reviewed.map((r) => r.scores.a),
		).toFixed(2)} / ${avg(reviewed.map((r) => r.scores.l)).toFixed(2)} / ${avg(
			reviewed.map((r) => r.scores.s),
		).toFixed(2)}`,
	);
	lines.push("");

	lines.push(renderTable("Voice (KEEP only)", voiceCountsKeep));
	lines.push(renderTable("Materia (KEEP only)", materiaCountsKeep));

	lines.push("## Per-question");
	lines.push("");
	lines.push("| id | verdict | C | A | L | S | total | rationale |");
	lines.push("|---|---|---|---|---|---|---|---|");
	for (const r of reviewed) {
		const rationale = r.rationale.replace(/\|/g, "\\|").slice(0, 200);
		lines.push(
			`| ${r.id} | ${r.verdict} | ${r.scores.c} | ${r.scores.a} | ${r.scores.l} | ${r.scores.s} | ${r.scores.total} | ${rationale} |`,
		);
	}
	lines.push("");

	if (warnings.length > 0) {
		lines.push("## Warnings");
		lines.push("");
		for (const w of warnings) lines.push(`- ${w}`);
		lines.push("");
	}

	const summary = lines.join("\n");
	writeFileSync(opts.summaryOut, summary);

	return {
		summary,
		kept: keepRows.length,
		marginalDrop: marginalDropRows.length,
		warnings,
	};
}

/**
 * Try to recover the original accepted JSONL path from a hint at the top of
 * the review markdown ("- Source JSONL: `<path>`"), or return undefined.
 */
function guessAcceptedPath(
	_reviewedPath: string,
	md: string,
): string | undefined {
	const m = md.match(/Source JSONL:\s*`([^`]+)`/);
	return m?.[1];
}
