/**
 * Privacy minimization guards for the Q&A service (see /privacidad/):
 *   - ask_log rows expire after ASK_LOG_RETENTION_DAYS (default 90)
 *   - every OpenRouter request asks for Zero Data Retention routing
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { openRouterProviderField } from "../services/openrouter.ts";
import {
	createAskLogPurger,
	DEFAULT_ASK_LOG_RETENTION_DAYS,
	purgeOldAskLog,
	resolveAskLogRetentionDays,
} from "../services/rag/ask-log-retention.ts";

function makeDb(): Database {
	const db = new Database(":memory:");
	db.run(`CREATE TABLE ask_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		question TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);
	return db;
}

function insertAt(db: Database, question: string, modifier: string) {
	db.query(
		`INSERT INTO ask_log (question, created_at) VALUES (?, datetime('now', ?))`,
	).run(question, modifier);
}

function questions(db: Database): string[] {
	return db
		.query<{ question: string }, []>("SELECT question FROM ask_log ORDER BY id")
		.all()
		.map((r) => r.question);
}

describe("resolveAskLogRetentionDays", () => {
	it("defaults to 90 days", () => {
		expect(resolveAskLogRetentionDays({})).toBe(90);
		expect(DEFAULT_ASK_LOG_RETENTION_DAYS).toBe(90);
	});
	it("reads the env var", () => {
		expect(resolveAskLogRetentionDays({ ASK_LOG_RETENTION_DAYS: "30" })).toBe(
			30,
		);
	});
	it("falls back to the default on garbage", () => {
		expect(
			resolveAskLogRetentionDays({ ASK_LOG_RETENTION_DAYS: "noventa" }),
		).toBe(90);
	});
});

describe("purgeOldAskLog", () => {
	it("deletes only rows older than the limit", () => {
		const db = makeDb();
		insertAt(db, "vieja", "-100 days");
		insertAt(db, "limite", "-89 days");
		insertAt(db, "nueva", "-1 hours");
		expect(purgeOldAskLog(db, 90)).toBe(1);
		expect(questions(db)).toEqual(["limite", "nueva"]);
	});
	it("is a no-op when disabled", () => {
		const db = makeDb();
		insertAt(db, "vieja", "-1000 days");
		expect(purgeOldAskLog(db, 0)).toBe(0);
		expect(questions(db)).toEqual(["vieja"]);
	});
});

describe("createAskLogPurger", () => {
	it("purges at most once per 24h", () => {
		const db = makeDb();
		let now = 1_000_000;
		const purge = createAskLogPurger(db, 90, () => now);
		insertAt(db, "a", "-100 days");
		purge();
		expect(questions(db)).toEqual([]);
		insertAt(db, "b", "-100 days");
		now += 60 * 60 * 1000; // +1h: skipped
		purge();
		expect(questions(db)).toEqual(["b"]);
		now += 24 * 60 * 60 * 1000; // +25h: runs
		purge();
		expect(questions(db)).toEqual([]);
	});
	it("never throws", () => {
		const db = new Database(":memory:"); // no ask_log table
		const purge = createAskLogPurger(db, 90);
		expect(() => purge()).not.toThrow();
	});
});

describe("openRouterProviderField", () => {
	it("requests ZDR, denies data collection and skips SiliconFlow by default", () => {
		expect(openRouterProviderField({})).toEqual({
			provider: {
				zdr: true,
				data_collection: "deny",
				ignore: ["siliconflow"],
			},
		});
	});
	it("can be disabled explicitly for research", () => {
		expect(openRouterProviderField({ OPENROUTER_ZDR: "false" })).toEqual({});
	});
});
