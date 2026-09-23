import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import { Elysia } from "elysia";
import { reformRoutes } from "../routes/reforms.ts";
import { DbService } from "../services/db.ts";

function buildApp(dbService: DbService) {
	return new Elysia().use(reformRoutes(dbService));
}

let db: Database;
let app: ReturnType<typeof buildApp>;

function seedTestData(database: Database) {
	// Insert a norm with a national ELI source URL
	database.run(
		`INSERT INTO norms (id, title, short_title, country, rank, published_at, updated_at, status, department, source_url)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			"BOE-A-2024-1000",
			"Ley de Pruebas",
			"Ley Pruebas",
			"es",
			"ley",
			"2024-01-01",
			"2024-03-15",
			"vigente",
			"Ministerio de Justicia",
			"https://www.boe.es/eli/es/l/2024/01/01/1",
		],
	);

	// Insert a norm with a regional ELI source URL
	database.run(
		`INSERT INTO norms (id, title, short_title, country, rank, published_at, updated_at, status, department, source_url)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			"BOE-A-2024-2000",
			"Ley Vasca",
			"Ley Vasca",
			"es",
			"ley",
			"2024-02-01",
			"2024-03-20",
			"vigente",
			"Gobierno Vasco",
			"https://www.boe.es/eli/es-pv/l/2024/02/01/1",
		],
	);

	// Insert recent reforms (use dates relative to now to ensure they're "recent")
	const today = new Date();
	const recentDate = new Date(today);
	recentDate.setDate(today.getDate() - 7);
	const recentStr = recentDate.toISOString().slice(0, 10);

	const oldDate = new Date(today);
	oldDate.setDate(today.getDate() - 90);
	const oldStr = oldDate.toISOString().slice(0, 10);

	database.run(
		"INSERT INTO reforms (norm_id, date, source_id) VALUES (?, ?, ?)",
		["BOE-A-2024-1000", recentStr, "BOE-A-2024-9001"],
	);
	database.run(
		"INSERT INTO reforms (norm_id, date, source_id) VALUES (?, ?, ?)",
		["BOE-A-2024-1000", oldStr, "BOE-A-2024-9002"],
	);
	database.run(
		"INSERT INTO reforms (norm_id, date, source_id) VALUES (?, ?, ?)",
		["BOE-A-2024-2000", recentStr, "BOE-A-2024-9003"],
	);

	// Insert materias
	database.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
		"BOE-A-2024-1000",
		"Seguridad Social",
	]);
	database.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
		"BOE-A-2024-1000",
		"Trabajadores",
	]);
	database.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
		"BOE-A-2024-2000",
		"Educación",
	]);
}

beforeEach(() => {
	db = new Database(":memory:");
	createSchema(db);
	seedTestData(db);

	const dbService = new DbService(db);
	app = buildApp(dbService);
});

afterEach(() => {
	db.close();
});

function request(path: string) {
	return app.handle(new Request(`http://localhost${path}`));
}

interface PersonalReformsResponse {
	error?: string;
	reforms: Array<{ id: string; [key: string]: unknown }>;
	materias: string[];
	limit: number;
	offset: number;
}

describe("GET /v1/reforms/personal", () => {
	test("missing materias param returns 400", async () => {
		const res = await request("/v1/reforms/personal");
		expect(res.status).toBe(400);
		const body = (await res.json()) as PersonalReformsResponse;
		expect(body.error).toContain("materias");
	});

	test("empty materias param returns 400", async () => {
		const res = await request("/v1/reforms/personal?materias=");
		expect(res.status).toBe(400);
		const body = (await res.json()) as PersonalReformsResponse;
		expect(body.error).toContain("materias");
	});

	test("valid materias returns 200 with correct shape", async () => {
		const res = await request(
			"/v1/reforms/personal?materias=Seguridad%20Social",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as PersonalReformsResponse;
		expect(body).toHaveProperty("reforms");
		expect(body).toHaveProperty("materias");
		expect(body).toHaveProperty("limit");
		expect(body).toHaveProperty("offset");
		expect(Array.isArray(body.reforms)).toBe(true);
		expect(body.materias).toEqual(["Seguridad Social"]);
		expect(body.limit).toBe(20);
		expect(body.offset).toBe(0);
	});

	test("limit and offset params work", async () => {
		const res = await request(
			"/v1/reforms/personal?materias=Seguridad%20Social&limit=1&offset=0",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as PersonalReformsResponse;
		expect(body.reforms.length).toBeLessThanOrEqual(1);
		expect(body.limit).toBe(1);
		expect(body.offset).toBe(0);
	});

	test("returns all reforms (recent and old) without time limit", async () => {
		const res = await request(
			"/v1/reforms/personal?materias=Seguridad%20Social&limit=100",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as PersonalReformsResponse;
		// Should include both the recent (7 days ago) and old (90 days ago) reforms
		expect(body.reforms.length).toBe(2);
	});

	test("jurisdiction filtering works", async () => {
		// Query for es-pv jurisdiction with Educacion materia
		const res = await request(
			"/v1/reforms/personal?materias=Educaci%C3%B3n&jurisdiccion=es-pv&limit=100",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as PersonalReformsResponse;
		// Should find the Basque norm
		expect(body.reforms.length).toBeGreaterThanOrEqual(1);
		expect(body.reforms[0]?.id).toBe("BOE-A-2024-2000");
	});

	test("returns empty reforms array when no matches", async () => {
		const res = await request(
			"/v1/reforms/personal?materias=NonexistentMateria&weeks=4",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as PersonalReformsResponse;
		expect(body.reforms).toEqual([]);
	});

	test("national jurisdiction excludes regional norms", async () => {
		// Educacion materia is only on the Basque norm (es-pv)
		// With jurisdiction=es it should not appear
		const res = await request(
			"/v1/reforms/personal?materias=Educaci%C3%B3n&jurisdiccion=es&limit=100",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as PersonalReformsResponse;
		expect(body.reforms).toEqual([]);
	});
});

interface ChangelogResponse {
	error?: string;
	reforms: Array<{ id: string; date: string; source_id: string }>;
	date_range: string;
	weeks: number;
	weeks_requested: number;
	weeks_clamped: boolean;
	limit: number;
	offset: number;
	has_more: boolean;
}

describe("GET /v1/changelog", () => {
	// 25 extra reforms, several sharing a date, so paging depends on a
	// total order (date alone would let SQLite return ties in any order).
	function seedManyReforms(count: number) {
		for (let i = 0; i < count; i++) {
			const d = new Date();
			d.setDate(d.getDate() - 1 - Math.floor(i / 5));
			insertReform(
				"BOE-A-2024-1000",
				d.toISOString().slice(0, 10),
				`BOE-A-2026-${String(10000 + i)}`,
			);
		}
	}
	function insertReform(normId: string, date: string, sourceId: string) {
		db.run("INSERT INTO reforms (norm_id, date, source_id) VALUES (?, ?, ?)", [
			normId,
			date,
			sourceId,
		]);
	}
	const key = (r: { id: string; date: string; source_id: string }) =>
		`${r.id}|${r.date}|${r.source_id}`;

	test("defaults are unchanged and applied parameters are reported", async () => {
		const res = await request("/v1/changelog");
		expect(res.status).toBe(200);
		const body = (await res.json()) as ChangelogResponse;
		expect(body.weeks).toBe(4);
		expect(body.weeks_requested).toBe(4);
		expect(body.weeks_clamped).toBe(false);
		expect(body.limit).toBe(50);
		expect(body.offset).toBe(0);
		expect(body.has_more).toBe(false);
		// Seed: two reforms 7 days ago; the 90-day-old one is outside 4 weeks.
		expect(body.reforms).toHaveLength(2);
		expect(body.date_range).toMatch(/^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
	});

	test("weeks above the cap is clamped and the clamp is visible", async () => {
		const res = await request("/v1/changelog?weeks=26");
		const body = (await res.json()) as ChangelogResponse;
		expect(res.status).toBe(200);
		expect(body.weeks).toBe(12);
		expect(body.weeks_requested).toBe(26);
		expect(body.weeks_clamped).toBe(true);
		const since = new Date();
		since.setDate(since.getDate() - 12 * 7);
		expect(body.date_range.startsWith(since.toISOString().slice(0, 10))).toBe(
			true,
		);
	});

	test("limit above 100 is capped and reported", async () => {
		const res = await request("/v1/changelog?limit=500");
		const body = (await res.json()) as ChangelogResponse;
		expect(body.limit).toBe(100);
	});

	test("offset pages are disjoint, consecutive and cover every row", async () => {
		seedManyReforms(25);
		const all = (await (
			await request("/v1/changelog?limit=100")
		).json()) as ChangelogResponse;
		expect(all.reforms).toHaveLength(27);
		expect(all.has_more).toBe(false);

		const pages: ChangelogResponse[] = [];
		for (const offset of [0, 10, 20]) {
			const res = await request(`/v1/changelog?limit=10&offset=${offset}`);
			expect(res.status).toBe(200);
			pages.push((await res.json()) as ChangelogResponse);
		}
		expect(pages.map((p) => p.reforms.length)).toEqual([10, 10, 7]);
		expect(pages.map((p) => p.has_more)).toEqual([true, true, false]);
		expect(pages.map((p) => p.offset)).toEqual([0, 10, 20]);

		const paged = pages.flatMap((p) => p.reforms.map(key));
		expect(new Set(paged).size).toBe(paged.length);
		expect(paged).toEqual(all.reforms.map(key));
	});

	test("offset past the end returns an empty page", async () => {
		const res = await request("/v1/changelog?offset=500");
		const body = (await res.json()) as ChangelogResponse;
		expect(res.status).toBe(200);
		expect(body.reforms).toEqual([]);
		expect(body.has_more).toBe(false);
	});

	test.each([
		"offset=-1",
		"offset=abc",
		"offset=1.5",
		"offset=10001",
		"limit=0",
		"limit=abc",
		"weeks=0",
		"weeks=abc",
		"jurisdiccion=xx",
	])("invalid %s returns 400", async (qs) => {
		const res = await request(`/v1/changelog?${qs}`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ChangelogResponse;
		expect(typeof body.error).toBe("string");
	});

	test("jurisdiction is accepted as an alias of jurisdiccion", async () => {
		const a = (await (
			await request("/v1/changelog?jurisdiccion=es")
		).json()) as ChangelogResponse;
		const b = (await (
			await request("/v1/changelog?jurisdiction=es")
		).json()) as ChangelogResponse;
		expect(a.reforms.map((r) => r.id)).toEqual(["BOE-A-2024-1000"]);
		expect(b.reforms).toEqual(a.reforms);
	});
});
