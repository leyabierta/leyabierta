/**
 * Corpus freshness status (issue #129).
 *
 * Ley Abierta only ingests CONSOLIDATED legislation from the BOE, which
 * lags the daily official bulletin by 1-2 weeks. That's expected and not
 * a bug — but a citizen seeing "Cambios recientes -> 18 de julio" on the
 * 23rd reasonably assumes the site is broken. This service backs the
 * public `GET /v1/status` endpoint that lets the frontend communicate
 * that lag honestly instead of looking abandoned.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
	isPlausibleReformDate,
	MIN_PLAUSIBLE_REFORM_DATE,
} from "@leyabierta/pipeline";

export type LastSyncSource =
	| "state_watermark"
	| "state_file_mtime"
	| "unavailable";

export interface StatusData {
	norms_count: number;
	reforms_count: number;
	/** MAX(norms.published_at) across the whole corpus. */
	corpus_max_published_at: string | null;
	/**
	 * MAX(reforms.date), excluding implausible dates (see
	 * isPlausibleReformDate) so a corrupt row like the known `2929-11-19`
	 * incident can never contaminate this even before the DB is cleaned up.
	 */
	last_reform_date: string | null;
	days_since_last_reform: number | null;
	/**
	 * Best-effort "when did the ingest pipeline last run" signal. See
	 * `last_sync_source` for how reliable it is — today there is NO fully
	 * reliable signal for this (see the class doc + open_issues in the PR
	 * that introduced this field).
	 */
	last_sync: string | null;
	last_sync_source: LastSyncSource;
}

export class StatusService {
	constructor(
		private db: Database,
		private dataDir: string = process.env.RAG_DATA_DIR ?? "./data",
	) {}

	getStatus(now: Date = new Date()): StatusData {
		const norms_count = this.db
			.query<{ c: number }, []>("SELECT count(*) as c FROM norms")
			.get()!.c;
		const reforms_count = this.db
			.query<{ c: number }, []>("SELECT count(*) as c FROM reforms")
			.get()!.c;
		const corpus_max_published_at =
			this.db
				.query<{ d: string | null }, []>(
					"SELECT max(published_at) as d FROM norms",
				)
				.get()?.d ?? null;

		const nowIso = now.toISOString().slice(0, 10);
		const maxRow = this.db
			.query<{ date: string }, [string, string]>(
				"SELECT date FROM reforms WHERE date >= ? AND date <= ? ORDER BY date DESC LIMIT 1",
			)
			.get(MIN_PLAUSIBLE_REFORM_DATE, nowIso);
		// Belt and suspenders: the range query above already excludes dates
		// outside [1800-01-01, today], but re-check plausibility in case of
		// any other kind of garbage that slipped past the SQL bounds.
		const last_reform_date =
			maxRow && isPlausibleReformDate(maxRow.date, now) ? maxRow.date : null;

		let days_since_last_reform: number | null = null;
		if (last_reform_date) {
			const ms =
				now.getTime() - new Date(`${last_reform_date}T00:00:00Z`).getTime();
			days_since_last_reform = Math.floor(ms / 86_400_000);
		}

		const { last_sync, last_sync_source } = this.readLastSync();

		return {
			norms_count,
			reforms_count,
			corpus_max_published_at,
			last_reform_date,
			days_since_last_reform,
			last_sync,
			last_sync_source,
		};
	}

	/**
	 * Read the best available "last sync" signal from data/state.json.
	 *
	 * KNOWN GAP (see open_issues): `state.save()` in the pipeline CLI is
	 * only called when there is something new to persist — a genuine
	 * "0 changed" run returns early and never touches state.json. That
	 * means neither `lastBoeUpdate` nor the file's mtime is a reliable
	 * "the cron ran and is healthy" heartbeat; both can go stale on quiet
	 * nights exactly like the freshness signal they're meant to
	 * corroborate. Reported honestly via `last_sync_source` rather than
	 * silently treating a stale watermark as if it were fresh.
	 */
	private readLastSync(): {
		last_sync: string | null;
		last_sync_source: LastSyncSource;
	} {
		const path = `${this.dataDir}/state.json`;
		if (!existsSync(path)) {
			return { last_sync: null, last_sync_source: "unavailable" };
		}
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8")) as {
				lastBoeUpdate?: unknown;
			};
			if (typeof raw.lastBoeUpdate === "string" && raw.lastBoeUpdate) {
				return {
					last_sync: raw.lastBoeUpdate,
					last_sync_source: "state_watermark",
				};
			}
		} catch {
			// Fall through to mtime below
		}
		try {
			const mtime = statSync(path).mtime.toISOString();
			return { last_sync: mtime, last_sync_source: "state_file_mtime" };
		} catch {
			return { last_sync: null, last_sync_source: "unavailable" };
		}
	}
}
