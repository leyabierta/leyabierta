/**
 * Validation and import logic for reform summaries generated offline
 * (reform-summaries-offline.ts). Rows come from a JSONL file produced by a
 * model on a rented GPU, so nothing in them is trusted.
 *
 * Kept in its own module so it can be unit-tested without the CLI.
 */

import type { Database } from "bun:sqlite";
import { generatedTextProblem, normalizeModelId } from "@leyabierta/pipeline";
import { textHash } from "./article-summary-import.ts";
import {
	buildReformPrompt,
	PROMPT_VERSION,
	type ReformRow,
} from "./reform-summary-prompt.ts";
import {
	type SummaryResponse,
	validateReformSummary,
} from "./reform-summary-validation.ts";

/** Hash of an existing summary, so a replacement never overwrites a newer one. */
export function summaryHash(headline: string, summary: string): string {
	return textHash(`${headline}\n${summary}`);
}

/** Hash of exactly what the model saw; import rebuilds it from the DB. */
export function promptHash(prompt: { system: string; user: string }): string {
	return textHash(`${prompt.system}\n\n${prompt.user}`);
}

export interface GeneratedReformRow {
	ok: boolean;
	norm_id: string;
	source_id: string;
	reform_date: string;
	input_hash: string;
	prompt_version?: string;
	model?: string;
	result: unknown;
}

// The model id as stored: see normalizeModelId in @leyabierta/pipeline
// (shared with the per-article summaries import).
export { normalizeModelId } from "@leyabierta/pipeline";

// The prompt asks for at most 15 words; a little slack before rejecting.
export const MAX_HEADLINE_WORDS = 20;
const SECOND_PERSON =
	/(?<![\p{L}\p{N}])(tú|tienes|puedes|usted|ustedes|debes)(?![\p{L}\p{N}])/iu;

export function validateGeneratedReform(
	row: unknown,
): { ok: true; summary: SummaryResponse } | { ok: false; reason: string } {
	if (!row || typeof row !== "object")
		return { ok: false, reason: "not_object" };
	const r = row as Partial<GeneratedReformRow>;
	if (r.ok !== true) return { ok: false, reason: "generation_failed" };
	if (!r.norm_id || !r.source_id || !r.reform_date)
		return { ok: false, reason: "no_key" };
	if (typeof r.input_hash !== "string" || !/^[0-9a-f]{16}$/.test(r.input_hash))
		return { ok: false, reason: "no_input_hash" };

	const { result, reason } = validateReformSummary(r.result);
	if (!result) return { ok: false, reason: `invalid: ${reason}` };
	if (result.headline.split(/\s+/).length > MAX_HEADLINE_WORDS)
		return { ok: false, reason: "headline_too_long" };
	const problem = generatedTextProblem(`${result.headline} ${result.summary}`);
	if (problem) return { ok: false, reason: problem };
	if (SECOND_PERSON.test(`${result.headline} ${result.summary}`))
		return { ok: false, reason: "second_person" };
	return { ok: true, summary: result };
}

export interface ReformImportReport {
	total: number;
	inserted: number;
	replaced: number;
	/** Rows also marked in notified_reforms, so they trigger no alert email. */
	markedNotified: number;
	skipped: Record<string, number>;
}

/**
 * Alerts are for new reforms. An offline import is a backfill: a summary it
 * writes (inserted or replaced) for a reform older than this is marked as
 * notified, otherwise send-notifications.ts would email it (a replacement
 * too, when its importance changes from "skip"). Recent reforms keep the
 * normal alert flow, as if the daily cron had written them.
 */
export const ALERT_WINDOW_DAYS = 30;

/**
 * Inserts valid rows for reforms that still exist, belong to an in-force law,
 * have no summary yet and whose prompt, rebuilt from the DB now, is exactly
 * the one the model saw. By default never overwrites an existing summary.
 *
 * `replace` (regeneration of old summaries) maps `norm_id|source_id|date` to
 * the `summaryHash` seen at export time: that summary, and only if it is
 * still exactly the same, is replaced.
 * With `apply: false` nothing is written (the report is the same).
 */
export function importReformRows(
	db: Database,
	rows: unknown[],
	opts: {
		apply: boolean;
		batchSize?: number;
		pauseMs?: number;
		replace?: Map<string, string>;
		/** "YYYY-MM-DD"; defaults to today minus ALERT_WINDOW_DAYS. */
		alertCutoff?: string;
	},
): ReformImportReport {
	const report: ReformImportReport = {
		total: rows.length,
		inserted: 0,
		replaced: 0,
		markedNotified: 0,
		skipped: {},
	};
	const skip = (reason: string) => {
		report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
	};
	const keyOf = (r: Partial<GeneratedReformRow> | null) =>
		`${r?.norm_id}|${r?.source_id}|${r?.reform_date}`;

	const getReform = db.prepare(
		`SELECT r.norm_id, n.title, n.rank, r.date, r.source_id
		 FROM reforms r JOIN norms n ON n.id = r.norm_id
		 WHERE r.norm_id = ? AND r.source_id = ? AND r.date = ? AND n.status = 'vigente'`,
	);
	const hasSummary = db.prepare(
		"SELECT 1 FROM reform_summaries WHERE norm_id = ? AND source_id = ? AND reform_date = ?",
	);
	const insert = db.prepare(
		`INSERT OR IGNORE INTO reform_summaries
		   (norm_id, source_id, reform_date, reform_type, headline, summary, importance, generated_at, model, prompt_version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
	);
	const alertCutoff =
		opts.alertCutoff ??
		new Date(Date.now() - ALERT_WINDOW_DAYS * 86_400_000)
			.toISOString()
			.slice(0, 10);
	const needsNoAlert = (r: GeneratedReformRow) => r.reform_date < alertCutoff;
	const isNotified = db.prepare(
		"SELECT 1 FROM notified_reforms WHERE norm_id = ? AND source_id = ? AND reform_date = ?",
	);
	const markNotified = db.prepare(
		`INSERT OR IGNORE INTO notified_reforms (norm_id, source_id, reform_date, notified_at)
		 VALUES (?, ?, ?, datetime('now'))`,
	);
	const getSummary = db.prepare(
		"SELECT headline, summary FROM reform_summaries WHERE norm_id = ? AND source_id = ? AND reform_date = ?",
	);
	const update = db.prepare(
		`UPDATE reform_summaries
		 SET reform_type = ?, headline = ?, summary = ?, importance = ?, generated_at = datetime('now'), model = ?, prompt_version = ?
		 WHERE norm_id = ? AND source_id = ? AND reform_date = ?`,
	);
	const currentHash = (r: GeneratedReformRow) => {
		const cur = getSummary.get(r.norm_id, r.source_id, r.reform_date) as {
			headline: string;
			summary: string;
		} | null;
		return cur ? summaryHash(cur.headline, cur.summary) : null;
	};
	// The summary is still the one seen at export time.
	const unchangedSinceExport = (r: GeneratedReformRow) => {
		const expected = opts.replace?.get(keyOf(r));
		return expected !== undefined && currentHash(r) === expected;
	};

	const okKeys = new Set<string>();
	for (const row of rows) {
		const r = row as Partial<GeneratedReformRow> | null;
		if (r?.ok === true) okKeys.add(keyOf(r));
	}

	type Accepted = {
		row: GeneratedReformRow;
		summary: SummaryResponse;
		replace: boolean;
	};
	const accepted: Accepted[] = [];
	const seen = new Set<string>();

	for (const row of rows) {
		const v = validateGeneratedReform(row);
		const r = row as GeneratedReformRow;
		if (!v.ok) {
			if (v.reason === "generation_failed" && okKeys.has(keyOf(r)))
				skip("failed_then_retried_ok");
			else skip(v.reason);
			continue;
		}
		const key = keyOf(r);
		// Only accepted rows count as seen: a rejected row must not block a
		// later, valid retry of the same reform in the same file.
		if (seen.has(key)) {
			skip("duplicate_in_file");
			continue;
		}

		const reform = getReform.get(
			r.norm_id,
			r.source_id,
			r.reform_date,
		) as ReformRow | null;
		if (!reform) {
			skip("reform_missing_or_not_vigente");
			continue;
		}
		let replace = false;
		if (hasSummary.get(r.norm_id, r.source_id, r.reform_date)) {
			if (!opts.replace?.has(key)) {
				skip("already_has_summary");
				continue;
			}
			if (!unchangedSinceExport(r)) {
				skip(
					currentHash(r) === summaryHash(v.summary.headline, v.summary.summary)
						? "already_replaced"
						: "summary_changed_since_export",
				);
				continue;
			}
			replace = true;
		}
		if (r.prompt_version !== PROMPT_VERSION) {
			skip("prompt_version_changed");
			continue;
		}
		const prompt = buildReformPrompt(db, reform);
		if (promptHash(prompt) !== r.input_hash) {
			skip("source_data_changed");
			continue;
		}
		// Same rule as the daily generator: an original publication is a new law.
		if (prompt.isNewLaw) v.summary.reform_type = "new_law";
		seen.add(key);
		accepted.push({ row: r, summary: v.summary, replace });
	}

	// Small transactions with a pause: the API keeps serving while this runs.
	const batchSize = opts.batchSize ?? 100;
	const pauseMs = opts.pauseMs ?? 50;
	for (let i = 0; i < accepted.length; i += batchSize) {
		const chunk = accepted.slice(i, i + batchSize);
		if (!opts.apply) {
			for (const { row, replace } of chunk) {
				if (replace)
					if (unchangedSinceExport(row)) report.replaced++;
					else {
						skip("summary_changed_since_export");
						continue;
					}
				else if (hasSummary.get(row.norm_id, row.source_id, row.reform_date)) {
					skip("already_has_summary");
					continue;
				} else report.inserted++;
				if (
					needsNoAlert(row) &&
					!isNotified.get(row.norm_id, row.source_id, row.reform_date)
				)
					report.markedNotified++;
			}
			continue;
		}
		db.transaction((items: Accepted[]) => {
			for (const { row, summary, replace } of items) {
				if (replace) {
					// Re-check inside the transaction, like the insert below.
					if (!unchangedSinceExport(row)) {
						skip("summary_changed_since_export");
						continue;
					}
					update.run(
						summary.reform_type,
						summary.headline,
						summary.summary,
						summary.importance,
						normalizeModelId(row.model),
						PROMPT_VERSION,
						row.norm_id,
						row.source_id,
						row.reform_date,
					);
					report.replaced++;
				} else {
					const res = insert.run(
						row.norm_id,
						row.source_id,
						row.reform_date,
						summary.reform_type,
						summary.headline,
						summary.summary,
						summary.importance,
						normalizeModelId(row.model),
						PROMPT_VERSION,
					);
					if (res.changes === 0) {
						skip("already_has_summary");
						continue;
					}
					report.inserted++;
				}
				if (
					needsNoAlert(row) &&
					markNotified.run(row.norm_id, row.source_id, row.reform_date)
						.changes > 0
				)
					report.markedNotified++;
			}
		}).immediate(chunk);
		if (pauseMs > 0) Bun.sleepSync(pauseMs);
	}

	return report;
}
