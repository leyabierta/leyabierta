/**
 * Validation and import logic for per-article citizen summaries generated
 * offline (article-summaries-offline.ts): rows come from a JSONL file produced
 * by a model on a rented GPU, so nothing in them is trusted.
 *
 * Kept in its own module so it can be unit-tested without the CLI.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/** Short fingerprint of the article text the summary was generated from. */
export function textHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface GeneratedRow {
	ok: boolean;
	norm_id: string;
	block_id: string;
	input_hash: string;
	model?: string;
	summary: string;
	tags: string[];
}

// Prompt v10 asks for 80-300 characters; very short articles legitimately
// produce shorter summaries, and the prompt tolerates ~20% over the target.
export const MIN_SUMMARY_CHARS = 20;
export const MAX_SUMMARY_CHARS = 320;
export const MIN_TAGS = 3;
export const MAX_TAGS = 5;
export const MAX_TAG_CHARS = 60;

// Latin script (incl. accents), plus digits, punctuation and symbols shared
// by all scripts. Anything else (CJK, Cyrillic...) is a model glitch.
const FOREIGN_SCRIPT =
	/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const SECOND_PERSON = /\b(tú|tienes|puedes|usted|ustedes|debes)\b/iu;
const ENGLISH = /\b(the|and|shall|which|must|summary)\b/u;
const REASONING = /<\/?think>|\bthinking\b/iu;

export function validateGeneratedRow(
	row: unknown,
):
	| { ok: true; summary: string; tags: string[] }
	| { ok: false; reason: string } {
	if (!row || typeof row !== "object")
		return { ok: false, reason: "not_object" };
	const r = row as Partial<GeneratedRow>;
	if (r.ok !== true) return { ok: false, reason: "generation_failed" };
	if (typeof r.norm_id !== "string" || !r.norm_id)
		return { ok: false, reason: "no_norm_id" };
	if (typeof r.block_id !== "string" || !r.block_id)
		return { ok: false, reason: "no_block_id" };
	if (typeof r.input_hash !== "string" || !/^[0-9a-f]{16}$/.test(r.input_hash))
		return { ok: false, reason: "no_input_hash" };

	const summary = typeof r.summary === "string" ? r.summary.trim() : "";
	if (summary.length < MIN_SUMMARY_CHARS)
		return { ok: false, reason: "too_short" };
	if (summary.length > MAX_SUMMARY_CHARS)
		return { ok: false, reason: "too_long" };

	if (!Array.isArray(r.tags)) return { ok: false, reason: "bad_tags" };
	const tags = [
		...new Set(
			r.tags
				.filter((t): t is string => typeof t === "string")
				.map((t) => t.trim())
				.filter(Boolean),
		),
	];
	if (tags.length < MIN_TAGS || tags.length > MAX_TAGS)
		return { ok: false, reason: "bad_tag_count" };
	if (tags.some((t) => t.length > MAX_TAG_CHARS))
		return { ok: false, reason: "tag_too_long" };

	const all = `${summary} ${tags.join(" ")}`;
	if (FOREIGN_SCRIPT.test(all)) return { ok: false, reason: "foreign_script" };
	if (REASONING.test(all)) return { ok: false, reason: "reasoning_leak" };
	if (SECOND_PERSON.test(summary))
		return { ok: false, reason: "second_person" };
	if (ENGLISH.test(summary)) return { ok: false, reason: "english" };

	return { ok: true, summary, tags };
}

export interface ImportReport {
	total: number;
	inserted: number;
	skipped: Record<string, number>;
}

/**
 * Inserts valid rows whose article still has the exact text the summary was
 * generated from and has no summary yet. Never overwrites: an existing summary
 * (even an empty one) or existing article tags are left untouched.
 * With `apply: false` nothing is written (the report is the same).
 */
export function importRows(
	db: Database,
	rows: unknown[],
	opts: { apply: boolean; batchSize?: number },
): ImportReport {
	const report: ImportReport = { total: rows.length, inserted: 0, skipped: {} };
	const skip = (reason: string) => {
		report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
	};

	const getText = db.prepare(
		"SELECT b.current_text AS text FROM blocks b JOIN norms n ON n.id = b.norm_id WHERE b.norm_id = ? AND b.block_id = ? AND n.status = 'vigente'",
	);
	const hasSummary = db.prepare(
		"SELECT 1 FROM citizen_article_summaries WHERE norm_id = ? AND block_id = ?",
	);
	const hasTags = db.prepare(
		"SELECT 1 FROM citizen_tags WHERE norm_id = ? AND block_id = ? LIMIT 1",
	);
	const insertSummary = db.prepare(
		"INSERT OR IGNORE INTO citizen_article_summaries (norm_id, block_id, summary) VALUES (?, ?, ?)",
	);
	const insertTag = db.prepare(
		"INSERT OR IGNORE INTO citizen_tags (norm_id, block_id, tag) VALUES (?, ?, ?)",
	);

	const seen = new Set<string>();
	type Accepted = {
		norm_id: string;
		block_id: string;
		summary: string;
		tags: string[];
	};
	const accepted: Accepted[] = [];

	for (const row of rows) {
		const v = validateGeneratedRow(row);
		if (!v.ok) {
			skip(v.reason);
			continue;
		}
		const r = row as GeneratedRow;
		const key = `${r.norm_id}|${r.block_id}`;
		if (seen.has(key)) {
			skip("duplicate_in_file");
			continue;
		}
		seen.add(key);

		const current = getText.get(r.norm_id, r.block_id) as {
			text: string;
		} | null;
		if (!current) {
			skip("article_missing_or_not_vigente");
			continue;
		}
		if (textHash(current.text) !== r.input_hash) {
			skip("source_text_changed");
			continue;
		}
		if (hasSummary.get(r.norm_id, r.block_id)) {
			skip("already_has_summary");
			continue;
		}
		accepted.push({
			norm_id: r.norm_id,
			block_id: r.block_id,
			summary: v.summary,
			tags: v.tags,
		});
	}

	const batchSize = opts.batchSize ?? 500;
	for (let i = 0; i < accepted.length; i += batchSize) {
		const chunk = accepted.slice(i, i + batchSize);
		const write = db.transaction((items: Accepted[]) => {
			for (const a of items) {
				// Re-check inside the transaction: the daily pipeline or the lazy
				// summary route may have filled it since the scan above.
				const res = insertSummary.run(a.norm_id, a.block_id, a.summary);
				if (res.changes === 0) {
					skip("already_has_summary");
					continue;
				}
				if (!hasTags.get(a.norm_id, a.block_id)) {
					for (const t of a.tags) insertTag.run(a.norm_id, a.block_id, t);
				}
				report.inserted++;
			}
		});
		if (opts.apply) {
			write(chunk);
		} else {
			for (const a of chunk)
				if (hasSummary.get(a.norm_id, a.block_id)) skip("already_has_summary");
				else report.inserted++;
		}
	}

	return report;
}
