/**
 * Tests for GET /v1/status (issue #129 — corpus freshness).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import { Elysia } from "elysia";
import { statusRoutes } from "../routes/status.ts";
import { StatusService } from "../services/status.ts";

let db: Database;
let app: Elysia;
let dataDir: string;

beforeEach(() => {
	db = new Database(":memory:");
	createSchema(db);
	dataDir = mkdtempSync(join(tmpdir(), "status-route-test-"));

	db.run(
		`INSERT INTO norms (id, title, short_title, country, rank, published_at, updated_at, status, department, source_url)
		 VALUES ('BOE-A-2024-1000', 'Ley de Pruebas', 'Ley Pruebas', 'es', 'ley', '2024-01-01', '2024-06-01', 'vigente', '', '')`,
	);
	db.run(
		"INSERT INTO reforms (norm_id, date, source_id) VALUES ('BOE-A-2024-1000', '2026-07-18', 'BOE-A-2026-9001')",
	);
	// Corrupt row — must never leak into the response.
	db.run(
		"INSERT INTO reforms (norm_id, date, source_id) VALUES ('BOE-A-2024-1000', '2929-11-19', 'BOE-A-2929-99999')",
	);

	const statusService = new StatusService(db, dataDir);
	app = new Elysia().use(statusRoutes(statusService));
});

afterEach(() => {
	db.close();
	rmSync(dataDir, { recursive: true, force: true });
});

function request(path: string) {
	return app.handle(new Request(`http://localhost${path}`));
}

describe("GET /v1/status", () => {
	test("returns 200 with freshness fields", async () => {
		const res = await request("/v1/status");
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.norms_count).toBe(1);
		expect(body.reforms_count).toBe(2);
		expect(body.corpus_max_published_at).toBe("2024-01-01");
		expect(body.last_reform_date).toBe("2026-07-18");
		expect(typeof body.days_since_last_reform).toBe("number");
		expect(body).toHaveProperty("last_sync");
		expect(body).toHaveProperty("last_sync_source");
	});

	test("never leaks the corrupt 2929-11-19 date as last_reform_date", async () => {
		const res = await request("/v1/status");
		const body = await res.json();
		expect(body.last_reform_date).not.toBe("2929-11-19");
	});

	test("sets a 5-minute edge cache header", async () => {
		const res = await request("/v1/status");
		expect(res.headers.get("cache-control")).toContain("s-maxage=300");
	});
});
