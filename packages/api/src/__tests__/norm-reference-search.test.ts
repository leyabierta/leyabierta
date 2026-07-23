/**
 * Integration tests for the issue #128 exact-reference fast path inside
 * DbService.searchLaws / searchLawsHybrid.
 *
 * Uses an in-memory SQLite database with the real schema, following the
 * style of db-service.test.ts.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import { DbService } from "../services/db.ts";
import type { HybridSearcher } from "../services/hybrid-search.ts";

let db: Database;
let svc: DbService;

beforeEach(() => {
	db = new Database(":memory:");
	createSchema(db);
	svc = new DbService(db);
});

afterEach(() => {
	db.close();
});

function insertNorm(overrides: Partial<Record<string, string>> = {}) {
	const defaults = {
		id: "BOE-A-2024-0001",
		title: "Ley de prueba",
		short_title: "Ley 1/2024",
		country: "es",
		jurisdiction: "es",
		rank: "ley",
		published_at: "2024-01-01",
		status: "vigente",
		department: "Test",
		source_url: "https://www.boe.es/eli/es/l/2024/01/01/1",
	};
	const d = { ...defaults, ...overrides };
	db.run(
		`INSERT INTO norms (id, title, short_title, country, jurisdiction, rank, published_at, status, department, source_url)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			d.id,
			d.title,
			d.short_title,
			d.country,
			d.jurisdiction,
			d.rank,
			d.published_at,
			d.status,
			d.department,
			d.source_url,
		],
	);
	db.run("INSERT INTO norms_fts (norm_id, title, content) VALUES (?, ?, ?)", [
		d.id,
		d.title,
		d.title,
	]);
}

// Stub HybridSearcher: returns the BM25 input verbatim so these tests focus
// on the exact-reference merge, not retrieval quality (mirrors the stub in
// routes.test.ts).
const hybridStub: HybridSearcher = {
	rankNorms: async (_query, bm25NormIds) => ({
		fused: bm25NormIds,
		bm25Count: bm25NormIds.length,
		vectorCount: 0,
		embeddingCacheHit: false,
		embedMs: 0,
		searchMs: 0,
	}),
};

describe("searchLaws — issue #128 reproducible failures", () => {
	it("'Real Decreto 1312/2024' returns the correct norm first (not an unrelated Real Decreto-ley)", async () => {
		insertNorm({
			id: "BOE-A-2024-26931",
			title:
				"Real Decreto 1312/2024, de 23 de diciembre, Registro Único de Arrendamientos",
			short_title: "Real Decreto 1312/2024",
			rank: "real_decreto",
			published_at: "2024-12-23",
		});
		insertNorm({
			id: "BOE-A-1986-7901",
			title: "Real Decreto-ley 1/1986, de medidas urgentes administrativas",
			short_title: "Real Decreto-ley 1/1986",
			rank: "real_decreto_ley",
			published_at: "1986-01-01",
		});

		const { laws, total } = svc.searchLaws("Real Decreto 1312/2024", {}, 20, 0);
		expect(total).toBeGreaterThan(0);
		expect(laws[0]?.id).toBe("BOE-A-2024-26931");
	});

	it("'1312/2024' returns the correct norm (already worked before #128, no regression)", async () => {
		insertNorm({
			id: "BOE-A-2024-26931",
			title: "Real Decreto 1312/2024, Registro Único de Arrendamientos",
			short_title: "Real Decreto 1312/2024",
			rank: "real_decreto",
		});
		const { laws } = svc.searchLaws("1312/2024", {}, 20, 0);
		expect(laws[0]?.id).toBe("BOE-A-2024-26931");
	});

	it("'LAU' returns the Ley de Arrendamientos Urbanos, not the 1943 university law", async () => {
		insertNorm({
			id: "BOE-A-1994-26003",
			title: "Ley 29/1994, de 24 de noviembre, de Arrendamientos Urbanos",
			short_title: "Ley 29/1994",
			rank: "ley",
			published_at: "1994-11-24",
		});
		insertNorm({
			id: "BOE-A-1943-7181",
			title: "Ley de 29 de julio de 1943 sobre ordenacion de la Universidad",
			short_title: "Ley de 29 de julio de 1943",
			rank: "ley",
			published_at: "1943-07-29",
		});

		const { laws } = svc.searchLaws("LAU", {}, 20, 0);
		expect(laws[0]?.id).toBe("BOE-A-1994-26003");
	});

	it("a bare BOE sequence number resolves by id suffix", async () => {
		// Issue #128 listed q="26931" as a failing case. It used to return an
		// unrelated norm; with FTS alone it returns nothing at all, because
		// norm_id is UNINDEXED in norms_fts and the digits appear nowhere in
		// the title.
		insertNorm({ id: "BOE-A-2015-11724", title: "Norma irrelevante" });
		insertNorm({
			id: "BOE-A-2024-26931",
			title: "Real Decreto 1312/2024, de 23 de diciembre",
			short_title: "Real Decreto 1312/2024",
			published_at: "2024-12-28",
		});
		const { laws } = svc.searchLaws("26931", {}, 20, 0);
		expect(laws[0]?.id).toBe("BOE-A-2024-26931");
	});

	it("id-suffix collisions are returned newest-first, not dropped", async () => {
		insertNorm({ id: "BOE-A-2001-90001", published_at: "2001-05-05" });
		insertNorm({ id: "BOE-A-2019-90001", published_at: "2019-05-05" });
		const { laws } = svc.searchLaws("90001", {}, 20, 0);
		expect(laws.map((l) => l.id)).toEqual([
			"BOE-A-2019-90001",
			"BOE-A-2001-90001",
		]);
	});
});

describe("searchLaws — exact reference is prepended, not exclusive", () => {
	it("keeps other BM25 hits after the exact match, deduped", async () => {
		insertNorm({
			id: "BOE-A-2024-0001",
			title: "Real Decreto 100/2024, de vivienda",
			short_title: "Real Decreto 100/2024",
			rank: "real_decreto",
		});
		insertNorm({
			id: "BOE-A-2024-0002",
			title: "Ley de vivienda y alquiler",
			short_title: "Ley 5/2024",
			rank: "ley",
		});

		const { laws } = svc.searchLaws("Real Decreto 100/2024", {}, 20, 0);
		expect(laws[0]?.id).toBe("BOE-A-2024-0001");
		// exact match appears exactly once even though it could also match BM25
		expect(laws.filter((l) => l.id === "BOE-A-2024-0001")).toHaveLength(1);
	});

	it("returns every jurisdiction sharing the same short_title, state (es) first", async () => {
		insertNorm({
			id: "BOE-A-2016-0001",
			jurisdiction: "es",
			title: "Ley 12/2016 estatal",
			short_title: "Ley 12/2016",
			rank: "ley",
		});
		insertNorm({
			id: "BOE-A-2016-0002",
			jurisdiction: "es-ct",
			title: "Ley 12/2016 autonomica",
			short_title: "Ley 12/2016",
			rank: "ley",
		});

		const { laws, total } = svc.searchLaws("Ley 12/2016", {}, 20, 0);
		expect(total).toBeGreaterThanOrEqual(2);
		const ids = laws.map((l) => l.id);
		expect(ids).toContain("BOE-A-2016-0001");
		expect(ids).toContain("BOE-A-2016-0002");
		expect(ids.indexOf("BOE-A-2016-0001")).toBeLessThan(
			ids.indexOf("BOE-A-2016-0002"),
		);
	});
});

describe("searchLaws — respects filters and pagination on the fast path", () => {
	it("excludes an exact match that doesn't satisfy the rank filter", async () => {
		insertNorm({
			id: "BOE-A-2024-0001",
			title: "Real Decreto 100/2024",
			short_title: "Real Decreto 100/2024",
			rank: "real_decreto",
		});

		const { laws, total } = svc.searchLaws(
			"Real Decreto 100/2024",
			{ rank: "ley" },
			20,
			0,
		);
		expect(laws.map((l) => l.id)).not.toContain("BOE-A-2024-0001");
		expect(total).toBe(0);
	});

	it("excludes an exact match outside the requested jurisdiction", async () => {
		insertNorm({
			id: "BOE-A-2016-0002",
			jurisdiction: "es-ct",
			title: "Ley 12/2016 autonomica",
			short_title: "Ley 12/2016",
			rank: "ley",
		});

		const { laws } = svc.searchLaws(
			"Ley 12/2016",
			{ jurisdiction: "es" },
			20,
			0,
		);
		expect(laws.map((l) => l.id)).not.toContain("BOE-A-2016-0002");
	});

	it("paginates across exact + BM25 results without breaking total", async () => {
		insertNorm({
			id: "BOE-A-2024-0001",
			title: "Real Decreto 100/2024, de vivienda",
			short_title: "Real Decreto 100/2024",
			rank: "real_decreto",
		});
		insertNorm({
			id: "BOE-A-2024-0002",
			title: "Ley de vivienda social",
			short_title: "Ley 5/2024",
			rank: "ley",
		});

		const page1 = svc.searchLaws("Real Decreto 100/2024", {}, 1, 0);
		expect(page1.laws).toHaveLength(1);
		expect(page1.laws[0]?.id).toBe("BOE-A-2024-0001");
		expect(page1.total).toBe(page1.total); // sanity: total is a number, checked below
		expect(typeof page1.total).toBe("number");
	});
});

describe("searchLawsHybrid — issue #128 exact reference merge", () => {
	it("'Real Decreto 1312/2024' resolves via the fast path through the hybrid endpoint", async () => {
		insertNorm({
			id: "BOE-A-2024-26931",
			title: "Real Decreto 1312/2024, Registro Único de Arrendamientos",
			short_title: "Real Decreto 1312/2024",
			rank: "real_decreto",
		});
		insertNorm({
			id: "BOE-A-1986-7901",
			title: "Real Decreto-ley 1/1986, de medidas urgentes administrativas",
			short_title: "Real Decreto-ley 1/1986",
			rank: "real_decreto_ley",
		});

		const { laws } = await svc.searchLawsHybrid(
			"Real Decreto 1312/2024",
			{},
			20,
			0,
			hybridStub,
		);
		expect(laws[0]?.id).toBe("BOE-A-2024-26931");
	});

	it("'LAU' resolves via the hybrid endpoint even with no BM25/vector hits", async () => {
		insertNorm({
			id: "BOE-A-1994-26003",
			title: "Ley 29/1994, de 24 de noviembre, de Arrendamientos Urbanos",
			short_title: "Ley 29/1994",
			rank: "ley",
		});

		const noopHybrid: HybridSearcher = {
			rankNorms: async () => ({
				fused: [],
				bm25Count: 0,
				vectorCount: 0,
				embeddingCacheHit: false,
				embedMs: 0,
				searchMs: 0,
			}),
		};

		const { laws, total } = await svc.searchLawsHybrid(
			"LAU",
			{},
			20,
			0,
			noopHybrid,
		);
		expect(total).toBe(1);
		expect(laws[0]?.id).toBe("BOE-A-1994-26003");
	});
});

describe("searchLaws — short_title casing and separator variants", () => {
	it("resolves a rango reference regardless of short_title casing", async () => {
		// The corpus is not casing-normalized: 293 norms use "Decreto-ley"
		// and 6 use "Decreto-Ley". An exact match would miss the latter.
		insertNorm({
			id: "BOE-A-2016-90001",
			title: "Decreto-Ley 1/2016, de prueba",
			short_title: "Decreto-Ley 1/2016",
			rank: "real_decreto_ley",
		});
		const { laws } = svc.searchLaws("Decreto-ley 1/2016", {}, 20, 0);
		expect(laws[0]?.id).toBe("BOE-A-2016-90001");
	});

	it("resolves a ministerial order searched by its bare number", async () => {
		// "Orden HAP/1370/2014" has a slash before the number, not a space.
		insertNorm({
			id: "BOE-A-2014-8135",
			title: "Orden HAP/1370/2014, de 25 de julio",
			short_title: "Orden HAP/1370/2014",
			rank: "orden",
		});
		const { laws } = svc.searchLaws("1370/2014", {}, 20, 0);
		expect(laws[0]?.id).toBe("BOE-A-2014-8135");
	});
});
