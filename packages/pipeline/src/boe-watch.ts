/**
 * BOE change watcher: detects consolidated norms updated since the last
 * fully processed watermark, and tracks the push throttle state.
 *
 * The BOE list endpoint is ordered by `fecha_actualizacion` DESC, so a check
 * pages until it reaches the watermark. State lives in a small JSON file
 * (atomic writes). Only `commit` advances the watermark, after a successful
 * fast pass; `check` never does (except the first-run baseline).
 */

import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { BoeListItem } from "./spain/boe-client.ts";

const PAGE_SIZE = 100;
const STAMP_RE = /^\d{8}T\d{6}Z$/;

export interface WatchState {
	/** Highest fecha_actualizacion fully processed. */
	latest: string | null;
	/** Commits from fast passes not yet pushed. */
	pendingPush: boolean;
	/** ...and at least one of them is a brand-new law. */
	pendingHasNew: boolean;
	lastPushAt: string | null;
	lastCheckAt: string | null;
}

export interface CheckResult {
	changed: boolean;
	latest: string | null;
	ids: string[];
	newIds: string[];
}

export interface ListClient {
	list(limit: number, offset?: number): Promise<{ data: BoeListItem[] }>;
}

export function defaultState(): WatchState {
	return {
		latest: null,
		pendingPush: false,
		pendingHasNew: false,
		lastPushAt: null,
		lastCheckAt: null,
	};
}

export function defaultStatePath(
	dbPath = process.env.DB_PATH ?? "./data/leyabierta.db",
): string {
	return join(dirname(dbPath), "watch-state.json");
}

export function loadState(path: string): WatchState {
	if (!existsSync(path)) return defaultState();
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("not an object");
		}
		const d = defaultState();
		return {
			latest: typeof raw.latest === "string" ? raw.latest : d.latest,
			pendingPush: raw.pendingPush === true,
			pendingHasNew: raw.pendingHasNew === true,
			lastPushAt:
				typeof raw.lastPushAt === "string" ? raw.lastPushAt : d.lastPushAt,
			lastCheckAt:
				typeof raw.lastCheckAt === "string" ? raw.lastCheckAt : d.lastCheckAt,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(
			`[boe-watch] corrupt state file ${path} (${msg}); using defaults`,
		);
		return defaultState();
	}
}

/** Atomic write: temp file in the same directory, then rename. */
export function saveState(path: string, state: WatchState): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(tmp, path);
}

function existingIds(dbPath: string, ids: string[]): Set<string> {
	const found = new Set<string>();
	if (ids.length === 0) return found;
	const db = new Database(dbPath, { readonly: true });
	try {
		const stmt = db.prepare("SELECT 1 FROM norms WHERE id = ?");
		for (const id of ids) if (stmt.get(id)) found.add(id);
	} finally {
		db.close();
	}
	return found;
}

export async function check(opts: {
	statePath: string;
	dbPath: string;
	client: ListClient;
	maxPages?: number;
	now?: () => Date;
}): Promise<CheckResult> {
	const maxPages = opts.maxPages ?? 10;
	const now = opts.now ?? (() => new Date());
	const state = loadState(opts.statePath);
	const watermark = state.latest;

	let top: string | null = null;
	const ids: string[] = [];
	const seen = new Set<string>();
	let reachedWatermark = false;
	let exhausted = false;

	for (let page = 0; page < maxPages && !reachedWatermark; page++) {
		const { data } = await opts.client.list(PAGE_SIZE, page * PAGE_SIZE);
		for (const item of data) {
			const stamp = item.fecha_actualizacion;
			if (!stamp) continue;
			if (top === null || stamp > top) top = stamp;
			if (watermark !== null && stamp <= watermark) {
				reachedWatermark = true;
				break;
			}
			if (!seen.has(item.identificador)) {
				seen.add(item.identificador);
				ids.push(item.identificador);
			}
		}
		if (data.length < PAGE_SIZE) {
			exhausted = true;
			break;
		}
		if (watermark === null) break; // baseline needs only the first page
	}

	state.lastCheckAt = now().toISOString();

	if (watermark === null) {
		state.latest = top;
		saveState(opts.statePath, state);
		return { changed: false, latest: top, ids: [], newIds: [] };
	}

	if (!reachedWatermark && !exhausted) {
		console.error(
			`[boe-watch] max pages (${maxPages}) reached before the watermark ${watermark}; results may be incomplete`,
		);
	}
	saveState(opts.statePath, state);

	const known = existingIds(opts.dbPath, ids);
	return {
		changed: ids.length > 0,
		latest: top ?? watermark,
		ids,
		newIds: ids.filter((id) => !known.has(id)),
	};
}

export function commit(opts: {
	statePath: string;
	latest: string;
	isNew?: boolean;
}): WatchState {
	if (!STAMP_RE.test(opts.latest)) {
		throw new Error(
			`invalid --latest "${opts.latest}" (expected YYYYMMDDTHHMMSSZ)`,
		);
	}
	const state = loadState(opts.statePath);
	if (state.latest === null || opts.latest > state.latest) {
		state.latest = opts.latest;
	}
	state.pendingPush = true;
	state.pendingHasNew ||= opts.isNew === true;
	saveState(opts.statePath, state);
	return state;
}

export function shouldPush(opts: {
	statePath: string;
	minIntervalMin: number;
	now?: () => Date;
}): { push: boolean; reason: string } {
	const state = loadState(opts.statePath);
	const now = (opts.now ?? (() => new Date()))();
	if (!state.pendingPush) return { push: false, reason: "nothing pending" };
	if (state.pendingHasNew)
		return { push: true, reason: "brand-new law pending" };
	const last = state.lastPushAt ? Date.parse(state.lastPushAt) : Number.NaN;
	if (Number.isNaN(last)) return { push: true, reason: "never pushed" };
	const elapsedMin = (now.getTime() - last) / 60_000;
	if (elapsedMin >= opts.minIntervalMin) {
		return {
			push: true,
			reason: `${Math.floor(elapsedMin)} min since last push`,
		};
	}
	const remaining = Math.ceil(opts.minIntervalMin - elapsedMin);
	return {
		push: false,
		reason: `throttled: ${remaining} min remaining until next push`,
	};
}

export function markPushed(opts: {
	statePath: string;
	now?: () => Date;
}): WatchState {
	const state = loadState(opts.statePath);
	state.lastPushAt = (opts.now ?? (() => new Date()))().toISOString();
	state.pendingPush = false;
	state.pendingHasNew = false;
	saveState(opts.statePath, state);
	return state;
}
