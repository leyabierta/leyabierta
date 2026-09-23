/**
 * Question quota for the RAG Q&A endpoints (`/v1/ask`, `/v1/ask/stream`).
 *
 * Every question costs OpenRouter credit (embeddings + analyzer + rerank +
 * synthesis), and that credit is shared with the daily AI jobs. The generic
 * per-IP rate limiter (services/rate-limiter.ts) only bounds bursts; this
 * module caps the *spend*:
 *
 *   - per person: `perMinute` questions per minute and `perDay` per day
 *   - global:     `globalPerDay` questions per day across everyone
 *
 * "Day" is the Europe/Madrid calendar day, so "vuelve mañana" means what a
 * Spanish citizen expects.
 *
 * Privacy: raw IPs are never stored. The client key is
 * HMAC-SHA256(dailySalt, normalizedIp), where `dailySalt` is 32 random bytes
 * generated for each day. When the day changes, every counter and the
 * previous salt are deleted (zeroed on disk, WAL checkpointed), so
 * yesterday's keys can no longer be linked to an IP by anyone.
 *
 * Honest limit: *during* the day the salt sits in the same file as the
 * hashes, and the IPv4 space is only 2^32, so whoever can read this file
 * (i.e. the server operator, or an intruder on the server) could recompute
 * every IPv4's hash in minutes and re-identify today's rows. Within the day
 * the keys are pseudonymous, not anonymous; the privacy policy must say so.
 *
 * Storage: a small dedicated SQLite file (not the main leyabierta.db).
 *   - Counters survive the several deploys/restarts per day; an in-memory
 *     map would hand everyone a fresh quota on every Watchtower rollout.
 *   - A separate file means the daily pipeline's long write transactions on
 *     leyabierta.db can never make a quota write wait (bun:sqlite is
 *     synchronous: a busy wait would block the whole event loop). The only
 *     other writer is a second API container during a rolling restart, and
 *     each quota transaction is a couple of point reads/writes, so a short
 *     busy_timeout is enough.
 *   - If the file cannot be used (disk full, locked, corrupt), the quota
 *     falls back to an in-memory SQLite database instead of failing open.
 */

import { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";

export type AskQuotaReason = "per_minute" | "per_day" | "global_day";

export interface AskQuotaLimits {
	perMinute: number;
	perDay: number;
	globalPerDay: number;
}

export interface AskQuotaAllowed {
	allowed: true;
	remainingToday: number;
	limitPerDay: number;
}

export interface AskQuotaDenied {
	allowed: false;
	reason: AskQuotaReason;
	message: string;
	retryAfterSeconds: number;
	remainingToday: number;
	limitPerDay: number;
}

export type AskQuotaDecision = AskQuotaAllowed | AskQuotaDenied;

export interface AskQuotaOptions {
	limits: AskQuotaLimits;
	/** Path to the SQLite file, or ":memory:". */
	path: string;
	/** Injectable clock (ms since epoch). */
	now?: () => number;
	/** Injectable salt generator (tests). */
	generateSalt?: () => Buffer;
	/** IANA time zone that defines "a day". */
	timeZone?: string;
}

const MINUTE_MS = 60_000;
/** Row key for the global counter. Client keys are hex, so they never collide. */
const GLOBAL_KEY = "*";

export const DEFAULT_ASK_LIMITS: AskQuotaLimits = {
	perMinute: 2,
	perDay: 10,
	globalPerDay: 200,
};

function positiveIntEnv(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Read limits from ASK_PER_MINUTE_LIMIT / ASK_PER_DAY_LIMIT / ASK_GLOBAL_DAILY_LIMIT. */
export function askLimitsFromEnv(
	env: Record<string, string | undefined> = process.env,
): AskQuotaLimits {
	return {
		perMinute: positiveIntEnv(
			env.ASK_PER_MINUTE_LIMIT,
			DEFAULT_ASK_LIMITS.perMinute,
		),
		perDay: positiveIntEnv(env.ASK_PER_DAY_LIMIT, DEFAULT_ASK_LIMITS.perDay),
		globalPerDay: positiveIntEnv(
			env.ASK_GLOBAL_DAILY_LIMIT,
			DEFAULT_ASK_LIMITS.globalPerDay,
		),
	};
}

export function quotaMessage(
	reason: AskQuotaReason,
	limits: AskQuotaLimits,
): string {
	switch (reason) {
		case "per_minute":
			return "Has hecho muchas preguntas seguidas. Espera un minuto.";
		case "per_day":
			return `Has alcanzado el límite de ${limits.perDay} preguntas al día. Vuelve mañana.`;
		case "global_day":
			return "El servicio de preguntas ha alcanzado su límite diario. Vuelve mañana.";
	}
}

/**
 * Normalize an IP so trivially different spellings of the same client share
 * one quota. IPv6 is truncated to its /64: a single home connection usually
 * gets a whole /64 and can rotate addresses inside it at will.
 */
export function normalizeIp(ip: string): string {
	let value = ip.trim().toLowerCase();
	if (value.startsWith("[") && value.includes("]")) {
		value = value.slice(1, value.indexOf("]"));
	}
	const zone = value.indexOf("%");
	if (zone !== -1) value = value.slice(0, zone);
	if (!value.includes(":")) return value;

	// IPv4-mapped IPv6 (::ffff:1.2.3.4) → plain IPv4
	const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped?.[1]) return mapped[1];

	const [head = "", tail = ""] = value.split("::", 2);
	const headParts = head ? head.split(":") : [];
	const tailParts = value.includes("::") && tail ? tail.split(":") : [];
	const missing = 8 - headParts.length - tailParts.length;
	const groups = value.includes("::")
		? [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts]
		: headParts;
	if (groups.length !== 8) return value; // not a parseable IPv6, keep as is
	const prefix = groups
		.slice(0, 4)
		.map((g) => (Number.parseInt(g, 16) || 0).toString(16));
	return `${prefix.join(":")}::/64`;
}

interface DayClock {
	day: string;
	secondsUntilNextDay: number;
}

function makeDayClock(timeZone: string) {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	return (ms: number): DayClock => {
		const parts: Record<string, string> = {};
		for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
		const elapsed =
			Number(parts.hour) * 3600 +
			Number(parts.minute) * 60 +
			Number(parts.second);
		return {
			day: `${parts.year}-${parts.month}-${parts.day}`,
			// Approximate on DST-change days (±1 h); Retry-After is only a hint.
			secondsUntilNextDay: Math.max(1, 86_400 - elapsed),
		};
	};
}

interface QuotaRow {
	day_count: number;
	minute_start: number;
	minute_count: number;
}

export class AskQuota {
	readonly limits: AskQuotaLimits;
	private db: Database;
	private readonly now: () => number;
	private readonly generateSalt: () => Buffer;
	private readonly dayClock: (ms: number) => DayClock;
	private saltDay: string | null = null;
	private salt: Buffer | null = null;
	private usingFallback = false;

	constructor(opts: AskQuotaOptions) {
		this.limits = opts.limits;
		this.now = opts.now ?? Date.now;
		this.generateSalt = opts.generateSalt ?? (() => randomBytes(32));
		this.dayClock = makeDayClock(opts.timeZone ?? "Europe/Madrid");
		try {
			this.db = AskQuota.open(opts.path);
		} catch (err) {
			console.error(
				`[ask-quota] cannot open ${opts.path}, using in-memory counters:`,
				err instanceof Error ? err.message : err,
			);
			this.db = AskQuota.open(":memory:");
			this.usingFallback = true;
		}
		this.purgeStale();
	}

	private static open(path: string): Database {
		const db = new Database(path, { create: true });
		// Overwrite deleted rows with zeros instead of leaving them in free
		// pages: yesterday's salt and hashes must really be gone from disk.
		db.exec("PRAGMA secure_delete = ON");
		if (path !== ":memory:") {
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA busy_timeout = 250");
		}
		db.exec(`
			CREATE TABLE IF NOT EXISTS ask_quota_salt (
				day TEXT PRIMARY KEY,
				salt BLOB NOT NULL
			);
			CREATE TABLE IF NOT EXISTS ask_quota (
				day TEXT NOT NULL,
				client TEXT NOT NULL,
				day_count INTEGER NOT NULL,
				minute_start INTEGER NOT NULL,
				minute_count INTEGER NOT NULL,
				PRIMARY KEY (day, client)
			) WITHOUT ROWID;
		`);
		return db;
	}

	/** Delete every counter and salt that does not belong to the current day. */
	purgeStale(): void {
		this.withFallback(() => {
			const { day } = this.dayClock(this.now());
			const deleted =
				this.db.run("DELETE FROM ask_quota WHERE day != ?", [day]).changes +
				this.db.run("DELETE FROM ask_quota_salt WHERE day != ?", [day]).changes;
			if (deleted > 0) {
				// In WAL mode the zeroed pages only reach the main file on a
				// checkpoint, and old page images linger in the -wal file until
				// it is reset. Without this, yesterday's salt and hashes stay
				// readable on disk (and brute-forceable) until SQLite happens
				// to checkpoint, which at this write volume can take days.
				this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			}
			if (this.saltDay !== day) {
				this.saltDay = null;
				this.salt = null;
			}
		});
	}

	/** Hash of `ip` under today's salt. Exposed for tests. */
	clientKey(ip: string): string {
		const { day } = this.dayClock(this.now());
		return this.hashFor(day, ip);
	}

	/**
	 * Check the quota for `ip` and, if the question is allowed, count it.
	 * Check + increment run in one IMMEDIATE transaction so two concurrent
	 * requests (or two containers during a rolling restart) cannot both take
	 * the last slot.
	 */
	consume(ip: string): AskQuotaDecision {
		return this.withFallback(() => this.consumeOnce(ip));
	}

	private consumeOnce(ip: string): AskQuotaDecision {
		const nowMs = this.now();
		const { day, secondsUntilNextDay } = this.dayClock(nowMs);
		if (this.saltDay !== null && this.saltDay !== day) this.purgeStale();
		const { perMinute, perDay, globalPerDay } = this.limits;

		const txn = this.db.transaction((): AskQuotaDecision => {
			const client = this.hashFor(day, ip);
			const select = this.db.query<QuotaRow, [string, string]>(
				"SELECT day_count, minute_start, minute_count FROM ask_quota WHERE day = ? AND client = ?",
			);
			const row = select.get(day, client);
			const global = select.get(day, GLOBAL_KEY);
			const dayCount = row?.day_count ?? 0;
			const globalCount = global?.day_count ?? 0;
			const minuteOpen = row ? nowMs - row.minute_start < MINUTE_MS : false;
			const minuteCount = row && minuteOpen ? row.minute_count : 0;

			const deny = (
				reason: AskQuotaReason,
				retryAfterSeconds: number,
			): AskQuotaDenied => ({
				allowed: false,
				reason,
				message: quotaMessage(reason, this.limits),
				retryAfterSeconds,
				// With the service closed for the day, nobody can ask again
				// today, whatever their own count says.
				remainingToday:
					reason === "global_day" ? 0 : Math.max(0, perDay - dayCount),
				limitPerDay: perDay,
			});

			// Order matters for the message: if the day is spent, waiting a
			// minute will not help, so the daily reasons win over per-minute.
			if (dayCount >= perDay) return deny("per_day", secondsUntilNextDay);
			if (globalCount >= globalPerDay)
				return deny("global_day", secondsUntilNextDay);
			if (row && minuteOpen && minuteCount >= perMinute) {
				const retry = Math.ceil((row.minute_start + MINUTE_MS - nowMs) / 1000);
				return deny("per_minute", Math.max(1, retry));
			}

			this.db.run(
				`INSERT INTO ask_quota (day, client, day_count, minute_start, minute_count)
				 VALUES (?, ?, 1, ?, 1)
				 ON CONFLICT (day, client) DO UPDATE SET
				   day_count = day_count + 1,
				   minute_start = ?,
				   minute_count = ?`,
				[
					day,
					client,
					nowMs,
					minuteOpen && row ? row.minute_start : nowMs,
					minuteCount + 1,
				],
			);
			this.db.run(
				`INSERT INTO ask_quota (day, client, day_count, minute_start, minute_count)
				 VALUES (?, ?, 1, 0, 0)
				 ON CONFLICT (day, client) DO UPDATE SET day_count = day_count + 1`,
				[day, GLOBAL_KEY],
			);
			return {
				allowed: true,
				remainingToday: Math.max(0, perDay - dayCount - 1),
				limitPerDay: perDay,
			};
		});
		return txn.immediate();
	}

	private hashFor(day: string, ip: string): string {
		return createHmac("sha256", this.saltFor(day))
			.update(normalizeIp(ip))
			.digest("hex")
			.slice(0, 32);
	}

	private saltFor(day: string): Buffer {
		if (this.saltDay === day && this.salt) return this.salt;
		// INSERT OR IGNORE + SELECT so two processes agree on one salt per day.
		this.db.run(
			"INSERT OR IGNORE INTO ask_quota_salt (day, salt) VALUES (?, ?)",
			[day, this.generateSalt()],
		);
		const row = this.db
			.query<{ salt: Uint8Array }, [string]>(
				"SELECT salt FROM ask_quota_salt WHERE day = ?",
			)
			.get(day);
		if (!row) throw new Error("ask-quota: salt row missing after insert");
		this.saltDay = day;
		this.salt = Buffer.from(row.salt);
		return this.salt;
	}

	/**
	 * Run `fn`; if the on-disk database fails, switch to an in-memory one and
	 * retry once. Counters restart from zero in that case, which is better
	 * than failing open (unlimited spend) or failing closed (no service).
	 */
	private withFallback<T>(fn: () => T): T {
		try {
			return fn();
		} catch (err) {
			if (this.usingFallback) throw err;
			console.error(
				"[ask-quota] database error, switching to in-memory counters:",
				err instanceof Error ? err.message : err,
			);
			try {
				this.db.close();
			} catch {
				/* ignore */
			}
			this.db = AskQuota.open(":memory:");
			this.usingFallback = true;
			this.saltDay = null;
			this.salt = null;
			return fn();
		}
	}

	close(): void {
		try {
			this.db.close();
		} catch {
			/* already closed */
		}
	}
}
