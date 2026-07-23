/**
 * Unit tests for StatusService (issue #129 — corpus freshness).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import { StatusService } from "../services/status.ts";

let db: Database;
let dataDir: string;

function insertNorm(id: string, publishedAt: string) {
	db.run(
		`INSERT INTO norms (id, title, short_title, country, rank, published_at, updated_at, status, department, source_url)
		 VALUES (?, ?, ?, 'es', 'ley', ?, ?, 'vigente', '', '')`,
		[id, `Ley ${id}`, `Ley ${id}`, publishedAt, publishedAt],
	);
}

function insertReform(normId: string, date: string, sourceId: string) {
	db.run("INSERT INTO reforms (norm_id, date, source_id) VALUES (?, ?, ?)", [
		normId,
		date,
		sourceId,
	]);
}

beforeEach(() => {
	db = new Database(":memory:");
	createSchema(db);
	dataDir = mkdtempSync(join(tmpdir(), "status-service-test-"));
});

afterEach(() => {
	db.close();
	rmSync(dataDir, { recursive: true, force: true });
});

describe("StatusService.getStatus", () => {
	test("reports counts and dates for a normal corpus", () => {
		insertNorm("BOE-A-2024-1000", "2024-01-01");
		insertNorm("BOE-A-2024-2000", "2024-06-01");
		insertReform("BOE-A-2024-1000", "2026-07-18", "BOE-A-2026-9001");
		insertReform("BOE-A-2024-2000", "2026-07-10", "BOE-A-2026-9002");

		const status = new StatusService(db, dataDir);
		const now = new Date("2026-07-23T12:00:00Z");
		const result = status.getStatus(now);

		expect(result.norms_count).toBe(2);
		expect(result.reforms_count).toBe(2);
		expect(result.corpus_max_published_at).toBe("2024-06-01");
		expect(result.last_reform_date).toBe("2026-07-18");
		expect(result.days_since_last_reform).toBe(5);
	});

	test("excludes the known corrupt date 2929-11-19 from last_reform_date", () => {
		insertNorm("BOE-A-2024-1000", "2024-01-01");
		insertReform("BOE-A-2024-1000", "2026-07-18", "BOE-A-2026-9001");
		// Simulates a corrupt row already sitting in the DB (pre-fix data,
		// or a row inserted before the ingest-time guard existed).
		insertReform("BOE-A-2024-1000", "2929-11-19", "BOE-A-2929-99999");

		const status = new StatusService(db, dataDir);
		const now = new Date("2026-07-23T12:00:00Z");
		const result = status.getStatus(now);

		expect(result.reforms_count).toBe(2);
		expect(result.last_reform_date).toBe("2026-07-18");
	});

	test("returns null last_reform_date when there are no reforms", () => {
		insertNorm("BOE-A-2024-1000", "2024-01-01");

		const status = new StatusService(db, dataDir);
		const result = status.getStatus(new Date("2026-07-23T12:00:00Z"));

		expect(result.last_reform_date).toBeNull();
		expect(result.days_since_last_reform).toBeNull();
	});

	test("reads last_sync from state.json watermark when present", () => {
		writeFileSync(
			join(dataDir, "state.json"),
			JSON.stringify({
				version: 1,
				country: "es",
				lastBoeUpdate: "20260722T061153Z",
				norms: {},
			}),
		);

		const status = new StatusService(db, dataDir);
		const result = status.getStatus();

		expect(result.last_sync).toBe("20260722T061153Z");
		expect(result.last_sync_source).toBe("state_watermark");
	});

	test("falls back to state.json mtime when no watermark is set", () => {
		writeFileSync(
			join(dataDir, "state.json"),
			JSON.stringify({ version: 1, country: "es", norms: {} }),
		);

		const status = new StatusService(db, dataDir);
		const result = status.getStatus();

		expect(result.last_sync).not.toBeNull();
		expect(result.last_sync_source).toBe("state_file_mtime");
	});

	test("reports unavailable when state.json does not exist", () => {
		const status = new StatusService(db, join(dataDir, "does-not-exist"));
		const result = status.getStatus();

		expect(result.last_sync).toBeNull();
		expect(result.last_sync_source).toBe("unavailable");
	});
});
