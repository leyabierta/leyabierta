import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import { Elysia } from "elysia";
import { reformRoutes } from "../routes/reforms.ts";
import { DbService } from "../services/db.ts";

let db: Database;
let app: Elysia;

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
	app = new Elysia().use(reformRoutes(dbService));
});

afterEach(() => {
	db.close();
});

function request(path: string) {
	return app.handle(new Request(`http://localhost${path}`));
}

describe("GET /v1/reforms/personal", () => {
	test("missing materias param returns 400", async () => {
		const res = await request("/v1/reforms/personal");
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("materias");
	});

	test("empty materias param returns 400", async () => {
		const res = await request("/v1/reforms/personal?materias=");
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("materias");
	});

	test("valid materias returns 200 with correct shape", async () => {
		const res = await request(
			"/v1/reforms/personal?materias=Seguridad%20Social&weeks=12",
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("reforms");
		expect(body).toHaveProperty("materias");
		expect(body).toHaveProperty("date_range");
		expect(Array.isArray(body.reforms)).toBe(true);
		expect(body.materias).toEqual(["Seguridad Social"]);
	});

	test("weeks=0 returns 400", async () => {
		const res = await request(
			"/v1/reforms/personal?materias=Seguridad%20Social&weeks=0",
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("weeks");
	});

	test("weeks param limits results to recent", async () => {
		// weeks=2 should only return recent reform, not old one
		const res = await request(
			"/v1/reforms/personal?materias=Seguridad%20Social&weeks=2",
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		// Recent reform should be included
		expect(body.reforms.length).toBeGreaterThanOrEqual(1);

		// All returned reforms should be within 2 weeks
		const twoWeeksAgo = new Date();
		twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
		const sinceStr = twoWeeksAgo.toISOString().slice(0, 10);
		for (const r of body.reforms) {
			expect(r.date >= sinceStr).toBe(true);
		}
	});

	test("jurisdiction filtering works", async () => {
		// Query for es-pv jurisdiction with Educacion materia
		const res = await request(
			"/v1/reforms/personal?materias=Educaci%C3%B3n&jurisdiccion=es-pv&weeks=12",
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		// Should find the Basque norm
		expect(body.reforms.length).toBeGreaterThanOrEqual(1);
		expect(body.reforms[0].id).toBe("BOE-A-2024-2000");
	});

	test("returns empty reforms array when no matches", async () => {
		const res = await request(
			"/v1/reforms/personal?materias=NonexistentMateria&weeks=4",
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reforms).toEqual([]);
	});

	test("national jurisdiction excludes regional norms", async () => {
		// Educacion materia is only on the Basque norm (es-pv)
		// With jurisdiction=es it should not appear
		const res = await request(
			"/v1/reforms/personal?materias=Educaci%C3%B3n&jurisdiccion=es&weeks=12",
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reforms).toEqual([]);
	});
});
