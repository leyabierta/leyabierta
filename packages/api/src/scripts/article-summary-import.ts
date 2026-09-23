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
/** Absolute cap, for the longest articles; see maxSummaryChars. */
export const MAX_SUMMARY_CHARS = 600;

/**
 * Longest acceptable summary for an article of `articleChars` characters. A
 * fixed 320-character cap rejected 29% of the summaries of the main codes
 * (long articles with several apartados, where the essentials don't fit), and
 * forcing them shorter drops data. A summary close to the length of a short
 * article is still rejected.
 */
export function maxSummaryChars(articleChars: number): number {
	if (articleChars < 1000) return 320;
	if (articleChars < 2000) return 400;
	if (articleChars < 5000) return 500;
	return MAX_SUMMARY_CHARS;
}
export const MIN_TAGS = 3;
export const MAX_TAGS = 5;
export const MAX_TAG_CHARS = 60;

// Latin script (incl. accents), plus digits, punctuation and symbols shared
// by all scripts, and Greek (formulas: "el parámetro α"). Anything else (CJK,
// Cyrillic...) is a model glitch.
const FOREIGN_SCRIPT =
	/[^\p{Script=Latin}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]/u;
// Control and invisible format characters (NUL, zero-width space...) and
// HTML-like tags. Bare < and > stay: "municipios <10.000 hab" is legitimate.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}]|<\/?[a-z][^>]*>/iu;
// `\b` only knows ASCII letters (even with the `u` flag): "túneles" would
// match "tú" and "andén" would match "and". Use Unicode letter lookarounds.
const word = (alternatives: string) =>
	new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives})(?![\\p{L}\\p{N}])`, "iu");
const SECOND_PERSON = word("tú|tienes|puedes|usted|ustedes|debes");
const ENGLISH = word("the|and|shall|which|must|summary");
const REASONING = /<\/?think>|(?<![\p{L}])thinking(?![\p{L}])/iu;

/** Script, control-character and reasoning problems in generated text. */
export function generatedTextProblem(text: string): string | null {
	if (REASONING.test(text)) return "reasoning_leak";
	if (UNSAFE_CHARS.test(text)) return "unsafe_chars";
	if (FOREIGN_SCRIPT.test(text)) return "foreign_script";
	if (ENGLISH.test(text)) return "english";
	return null;
}

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
	// Dedupe case-insensitively (the tag PK is case-sensitive), keeping the
	// first spelling: tags can be proper nouns ("País Vasco").
	const byLower = new Map<string, string>();
	for (const t of r.tags) {
		if (typeof t !== "string") continue;
		const tag = t.trim();
		if (tag && !byLower.has(tag.toLowerCase()))
			byLower.set(tag.toLowerCase(), tag);
	}
	const tags = [...byLower.values()];
	if (tags.length < MIN_TAGS || tags.length > MAX_TAGS)
		return { ok: false, reason: "bad_tag_count" };
	if (tags.some((t) => t.length > MAX_TAG_CHARS))
		return { ok: false, reason: "tag_too_long" };

	const all = `${summary} ${tags.join(" ")}`;
	if (REASONING.test(all)) return { ok: false, reason: "reasoning_leak" };
	if (UNSAFE_CHARS.test(all)) return { ok: false, reason: "unsafe_chars" };
	if (FOREIGN_SCRIPT.test(all)) return { ok: false, reason: "foreign_script" };
	if (SECOND_PERSON.test(summary))
		return { ok: false, reason: "second_person" };
	if (ENGLISH.test(summary)) return { ok: false, reason: "english" };

	return { ok: true, summary, tags };
}

export interface ImportReport {
	total: number;
	inserted: number;
	replaced: number;
	skipped: Record<string, number>;
}

/**
 * Inserts valid rows whose article still has the exact text the summary was
 * generated from and has no summary yet. By default never overwrites: an
 * existing summary (even an empty one) or existing article tags are left
 * untouched.
 *
 * `replace` (regeneration of old summaries) maps `norm_id|block_id` to the
 * hash of the summary seen at export time: that summary, and only if it is
 * still exactly the same, is replaced together with its article tags.
 * With `apply: false` nothing is written (the report is the same).
 */
export function importRows(
	db: Database,
	rows: unknown[],
	opts: {
		apply: boolean;
		batchSize?: number;
		pauseMs?: number;
		replace?: Map<string, string>;
	},
): ImportReport {
	const report: ImportReport = {
		total: rows.length,
		inserted: 0,
		replaced: 0,
		skipped: {},
	};
	const skip = (reason: string) => {
		report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
	};

	const getText = db.prepare(
		"SELECT b.current_text AS text, n.citizen_summary AS normSummary FROM blocks b JOIN norms n ON n.id = b.norm_id WHERE b.norm_id = ? AND b.block_id = ? AND n.status = 'vigente'",
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
	const getSummary = db.prepare(
		"SELECT summary FROM citizen_article_summaries WHERE norm_id = ? AND block_id = ?",
	);
	const updateSummary = db.prepare(
		"UPDATE citizen_article_summaries SET summary = ? WHERE norm_id = ? AND block_id = ?",
	);
	const deleteTags = db.prepare(
		"DELETE FROM citizen_tags WHERE norm_id = ? AND block_id = ?",
	);
	// The summary is still the one seen at export time.
	const unchangedSinceExport = (normId: string, blockId: string) => {
		const expected = opts.replace?.get(`${normId}|${blockId}`);
		const current = getSummary.get(normId, blockId) as {
			summary: string;
		} | null;
		return (
			expected !== undefined &&
			current !== null &&
			textHash(current.summary) === expected
		);
	};

	// generate appends an ok:false row for an attempt and an ok:true row when a
	// later run succeeds; the failure is then not a real skip.
	const okKeys = new Set<string>();
	for (const row of rows) {
		const r = row as Partial<GeneratedRow> | null;
		if (r?.ok === true) okKeys.add(`${r.norm_id}|${r.block_id}`);
	}

	const seen = new Set<string>();
	type Accepted = {
		norm_id: string;
		block_id: string;
		summary: string;
		tags: string[];
		replace: boolean;
	};
	const accepted: Accepted[] = [];

	for (const row of rows) {
		const v = validateGeneratedRow(row);
		if (!v.ok) {
			const r = row as Partial<GeneratedRow> | null;
			if (
				v.reason === "generation_failed" &&
				okKeys.has(`${r?.norm_id}|${r?.block_id}`)
			)
				skip("failed_then_retried_ok");
			else skip(v.reason);
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
			normSummary: string | null;
		} | null;
		if (!current) {
			skip("article_missing_or_not_vigente");
			continue;
		}
		// generate-citizen-tags.ts (daily cron) regenerates laws with an empty
		// law-level summary and first deletes all their article summaries.
		if (!current.normSummary) {
			skip("law_summary_pending");
			continue;
		}
		if (textHash(current.text) !== r.input_hash) {
			skip("source_text_changed");
			continue;
		}
		if (v.summary.length > maxSummaryChars(current.text.length)) {
			skip("too_long");
			continue;
		}
		let replace = false;
		if (hasSummary.get(r.norm_id, r.block_id)) {
			if (!opts.replace?.has(key)) {
				skip("already_has_summary");
				continue;
			}
			if (!unchangedSinceExport(r.norm_id, r.block_id)) {
				const now = getSummary.get(r.norm_id, r.block_id) as {
					summary: string;
				} | null;
				skip(
					now?.summary === v.summary
						? "already_replaced"
						: "summary_changed_since_export",
				);
				continue;
			}
			replace = true;
		}
		accepted.push({
			norm_id: r.norm_id,
			block_id: r.block_id,
			summary: v.summary,
			tags: v.tags,
			replace,
		});
	}

	// Small transactions with a pause in between: the API keeps serving (and
	// writing) while this runs, and its connection has no busy_timeout.
	const batchSize = opts.batchSize ?? 100;
	const pauseMs = opts.pauseMs ?? 50;
	for (let i = 0; i < accepted.length; i += batchSize) {
		const chunk = accepted.slice(i, i + batchSize);
		const write = db.transaction((items: Accepted[]) => {
			for (const a of items) {
				if (a.replace) {
					// Re-check inside the transaction, like the insert below.
					if (!unchangedSinceExport(a.norm_id, a.block_id)) {
						skip("summary_changed_since_export");
						continue;
					}
					updateSummary.run(a.summary, a.norm_id, a.block_id);
					deleteTags.run(a.norm_id, a.block_id);
					for (const t of a.tags) insertTag.run(a.norm_id, a.block_id, t);
					report.replaced++;
					continue;
				}
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
			// IMMEDIATE: take the write lock before reading. A deferred transaction
			// that reads first (replace mode) gets SQLITE_BUSY with no retry if
			// the API commits a write in between.
			write.immediate(chunk);
			if (pauseMs > 0) Bun.sleepSync(pauseMs);
		} else {
			for (const a of chunk)
				if (a.replace)
					if (unchangedSinceExport(a.norm_id, a.block_id)) report.replaced++;
					else skip("summary_changed_since_export");
				else if (hasSummary.get(a.norm_id, a.block_id))
					skip("already_has_summary");
				else report.inserted++;
		}
	}

	return report;
}
