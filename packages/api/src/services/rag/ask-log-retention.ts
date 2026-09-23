/**
 * Retention limit for the `ask_log` table.
 *
 * `ask_log` stores the citizen's question and the generated answer so we can
 * measure quality and build evaluation sets. Questions are free text and can
 * contain personal data (even health or immigration details), so they must not
 * be kept forever. The privacy policy (/privacidad/) promises a fixed limit;
 * this module enforces it.
 *
 * ASK_LOG_RETENTION_DAYS (default 90). "0" or a negative value disables the
 * purge (local development / research DBs only — never in production, or the
 * privacy policy stops being true).
 */

import type { Database } from "bun:sqlite";

export const DEFAULT_ASK_LOG_RETENTION_DAYS = 90;

/** Parse ASK_LOG_RETENTION_DAYS. Pure (env passed in) for tests. */
export function resolveAskLogRetentionDays(
	env: Record<string, string | undefined>,
): number {
	const raw = env.ASK_LOG_RETENTION_DAYS?.trim();
	if (!raw) return DEFAULT_ASK_LOG_RETENTION_DAYS;
	const n = Number(raw);
	if (!Number.isFinite(n)) {
		console.warn(
			`[ask_log] Invalid ASK_LOG_RETENTION_DAYS="${raw}" — using ${DEFAULT_ASK_LOG_RETENTION_DAYS}`,
		);
		return DEFAULT_ASK_LOG_RETENTION_DAYS;
	}
	return Math.floor(n);
}

/**
 * Delete ask_log rows older than `days`. Returns the number of rows deleted.
 * No-op when days <= 0. `created_at` is SQLite `datetime('now')` (UTC text),
 * so the comparison is lexicographic on the same format.
 */
export function purgeOldAskLog(db: Database, days: number): number {
	if (days <= 0) return 0;
	const res = db
		.query(`DELETE FROM ask_log WHERE created_at < datetime('now', ?)`)
		.run(`-${days} days`);
	return res.changes;
}

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Returns a function that purges at most once per 24h. Call it after each
 * insert: cheap (a timestamp comparison) on every call but the first of the day.
 * Never throws — a failed purge must not break a citizen's answer.
 */
export function createAskLogPurger(
	db: Database,
	days: number,
	now: () => number = Date.now,
): () => void {
	let lastRun = Number.NEGATIVE_INFINITY;
	return () => {
		const t = now();
		if (t - lastRun < PURGE_INTERVAL_MS) return;
		lastRun = t;
		try {
			const deleted = purgeOldAskLog(db, days);
			if (deleted > 0) {
				console.log(`[ask_log] purged ${deleted} rows older than ${days} days`);
			}
		} catch (err) {
			console.warn(
				"[ask_log] purge failed:",
				err instanceof Error ? err.message : "unknown",
			);
		}
	};
}
