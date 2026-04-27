/**
 * Integration tests for the API routes.
 *
 * Builds an Elysia app with a real in-memory DbService and
 * a stubbed GitService, then tests endpoints via fetch.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import { Elysia } from "elysia";
import { lawRoutes, type SearchResponse } from "../routes/laws.ts";
import { omnibusRoutes } from "../routes/omnibus.ts";
import { LruCache } from "../services/cache.ts";
import type { CitizenSummaryService } from "../services/citizen-summary.ts";
import { DbService } from "../services/db.ts";
import type { GitService } from "../services/git.ts";

let db: Database;
let dbService: DbService;
let app: Elysia;

// Minimal GitService stub — route tests focus on DB-backed endpoints
const gitStub: GitService = {
	repoPath: "/tmp/fake",
	getFileAtDate: async () => null,
	getFileLatest: async () => null,
	diff: async () => null,
	log: async () => [],
} as unknown as GitService;

// Minimal CitizenSummaryService stub. The /laws/:id/summaries endpoint fires
// a background generate-and-cache call we don't want to trigger in tests.
// Returning undefined synchronously keeps the fire-and-forget path quiet.
const citizenSummaryStub: CitizenSummaryService = {
	getOrGenerate: async () => null,
} as unknown as CitizenSummaryService;

beforeEach(() => {
	db = new Database(":memory:");
	createSchema(db);
	dbService = new DbService(db);

	const diffCache = new LruCache<string>(100);
	const searchCache = new LruCache<SearchResponse>(100);

	app = new Elysia()
		.use(
			lawRoutes(dbService, gitStub, diffCache, citizenSummaryStub, searchCache),
		)
		.use(omnibusRoutes(dbService))
		.get("/health", () => ({
			status: "ok",
			laws: dbService.searchLaws(undefined, {}, 0, 0).total,
		}));
});

afterEach(() => {
	db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertNorm(overrides: Partial<Record<string, string>> = {}) {
	const defaults = {
		id: "BOE-A-1978-31229",
		title: "Constitucion Espanola",
		short_title: "CE",
		country: "es",
		rank: "constitucion",
		published_at: "1978-12-29",
		updated_at: "2024-02-17",
		status: "vigente",
		department: "Jefatura del Estado",
		source_url: "https://www.boe.es/eli/es/c/1978/12/27/(1)",
	};
	const d = { ...defaults, ...overrides };
	db.run(
		`INSERT INTO norms (id, title, short_title, country, rank, published_at, updated_at, status, department, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			d.id,
			d.title,
			d.short_title,
			d.country,
			d.rank,
			d.published_at,
			d.updated_at,
			d.status,
			d.department,
			d.source_url,
		],
	);
}

function insertBlock(
	normId: string,
	blockId: string,
	position: number,
	overrides: Partial<Record<string, string>> = {},
) {
	const defaults = {
		block_type: "articulo",
		title: `Article ${position}`,
		current_text: `Text of article ${position}`,
	};
	const d = { ...defaults, ...overrides };
	db.run(
		`INSERT INTO blocks (norm_id, block_id, block_type, title, position, current_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
		[normId, blockId, d.block_type, d.title, position, d.current_text],
	);
}

function insertReform(normId: string, date: string, sourceId: string) {
	db.run("INSERT INTO reforms (norm_id, date, source_id) VALUES (?, ?, ?)", [
		normId,
		date,
		sourceId,
	]);
}

function insertFts(normId: string, title: string, content: string) {
	db.run("INSERT INTO norms_fts (norm_id, title, content) VALUES (?, ?, ?)", [
		normId,
		title,
		content,
	]);
}

async function req(path: string): Promise<Response> {
	return app.handle(new Request(`http://localhost${path}`));
}

async function json(path: string) {
	const res = await req(path);
	return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
	it("returns status ok", async () => {
		const { status, body } = await json("/health");
		expect(status).toBe(200);
		expect(body.status).toBe("ok");
		expect(body.laws).toBe(0);
	});

	it("reports correct law count", async () => {
		insertNorm();
		const { body } = await json("/health");
		expect(body.laws).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// GET /v1/laws
// ---------------------------------------------------------------------------

describe("GET /v1/laws", () => {
	it("returns empty list when no laws exist", async () => {
		const { status, body } = await json("/v1/laws");
		expect(status).toBe(200);
		expect(body.data).toEqual([]);
		expect(body.total).toBe(0);
	});

	it("returns all laws", async () => {
		insertNorm({ id: "N1" });
		insertNorm({ id: "N2", title: "Ley X", rank: "ley" });

		const { body } = await json("/v1/laws");
		expect(body.total).toBe(2);
		expect(body.data).toHaveLength(2);
	});

	it("filters by country query param", async () => {
		insertNorm({ id: "N1", country: "es" });
		insertNorm({ id: "N2", country: "fr" });

		const { body } = await json("/v1/laws?country=es");
		expect(body.total).toBe(1);
		expect(body.data[0].id).toBe("N1");
	});

	it("filters by rank query param", async () => {
		insertNorm({ id: "N1", rank: "ley" });
		insertNorm({ id: "N2", rank: "constitucion" });

		const { body } = await json("/v1/laws?rank=ley");
		expect(body.total).toBe(1);
		expect(body.data[0].id).toBe("N1");
	});

	it("filters by status query param", async () => {
		insertNorm({ id: "N1", status: "vigente" });
		insertNorm({ id: "N2", status: "derogada" });

		const { body } = await json("/v1/laws?status=vigente");
		expect(body.data).toHaveLength(1);
		expect(body.data[0].id).toBe("N1");
	});

	it("supports pagination with limit and offset", async () => {
		for (let i = 1; i <= 5; i++) {
			insertNorm({ id: `N${i}`, published_at: `2020-0${i}-01` });
		}

		const page1 = (await json("/v1/laws?limit=2&offset=0")).body;
		expect(page1.data).toHaveLength(2);
		expect(page1.total).toBe(5);
		expect(page1.limit).toBe(2);
		expect(page1.offset).toBe(0);

		const page2 = (await json("/v1/laws?limit=2&offset=2")).body;
		expect(page2.data).toHaveLength(2);
		expect(page1.data[0].id).not.toBe(page2.data[0].id);
	});

	it("caps limit at 100", async () => {
		const { body } = await json("/v1/laws?limit=500");
		expect(body.limit).toBe(100);
	});

	it("defaults limit to 20 and offset to 0", async () => {
		const { body } = await json("/v1/laws");
		expect(body.limit).toBe(20);
		expect(body.offset).toBe(0);
	});

	it("searches with q query param via FTS", async () => {
		insertNorm({ id: "N1", title: "Constitucion Espanola" });
		insertNorm({ id: "N2", title: "Codigo Penal" });
		insertFts("N1", "Constitucion Espanola", "derechos");
		insertFts("N2", "Codigo Penal", "delitos");

		const { body } = await json("/v1/laws?q=Constitucion");
		expect(body.total).toBe(1);
		expect(body.data[0].id).toBe("N1");
	});
});

// ---------------------------------------------------------------------------
// GET /v1/laws/:id
// ---------------------------------------------------------------------------

describe("GET /v1/laws/:id", () => {
	it("returns 404 for non-existent law", async () => {
		const { status, body } = await json("/v1/laws/NOPE");
		expect(status).toBe(404);
		expect(body.error).toBe("Law not found");
	});

	it("returns law with blocks and reforms", async () => {
		insertNorm({ id: "N1", title: "Test Law" });
		insertBlock("N1", "art-1", 1);
		insertBlock("N1", "art-2", 2);
		insertReform("N1", "2024-01-01", "S1");

		const { status, body } = await json("/v1/laws/N1");
		expect(status).toBe(200);
		expect(body.title).toBe("Test Law");
		expect(body.blocks).toHaveLength(2);
		expect(body.blocks[0].block_id).toBe("art-1");
		expect(body.reforms).toHaveLength(1);
		expect(body.reforms[0].date).toBe("2024-01-01");
	});

	it("includes affected_blocks in reforms", async () => {
		insertNorm({ id: "N1" });
		insertBlock("N1", "art-1", 1);
		insertReform("N1", "2024-01-01", "S1");
		insertReformBlock("N1", "2024-01-01", "S1", "art-1");

		const { body } = await json("/v1/laws/N1");
		expect(body.reforms[0].affected_blocks).toContain("art-1");
	});
});

// ---------------------------------------------------------------------------
// GET /v1/laws/:id/analisis
// ---------------------------------------------------------------------------

describe("GET /v1/laws/:id/analisis", () => {
	it("returns 404 for non-existent law", async () => {
		const { status, body } = await json("/v1/laws/NOPE/analisis");
		expect(status).toBe(404);
		expect(body.error).toBe("Law not found");
	});

	it("returns local analisis data when available", async () => {
		insertNorm({ id: "N1" });
		db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
			"N1",
			"Derecho penal",
		]);
		db.run("INSERT INTO notas (norm_id, nota, position) VALUES (?, ?, ?)", [
			"N1",
			"A note",
			0,
		]);
		db.run(
			"INSERT INTO referencias (norm_id, direction, relation, target_id, text) VALUES (?, ?, ?, ?, ?)",
			["N1", "anterior", "SE MODIFICA", "BOE-X-1", "art. 1"],
		);
		db.run(
			"INSERT INTO referencias (norm_id, direction, relation, target_id, text) VALUES (?, ?, ?, ?, ?)",
			["N1", "posterior", "DEROGA", "BOE-X-2", "total"],
		);

		const { status, body } = await json("/v1/laws/N1/analisis");
		expect(status).toBe(200);
		expect(body.id).toBe("N1");
		expect(body.materias).toContain("Derecho penal");
		expect(body.notas).toContain("A note");
		expect(body.referencias.anteriores).toHaveLength(1);
		expect(body.referencias.anteriores[0].relation).toBe("SE MODIFICA");
		expect(body.referencias.posteriores).toHaveLength(1);
		expect(body.referencias.posteriores[0].relation).toBe("DEROGA");
	});

	it("returns analisis from local DB when only a materia exists", async () => {
		insertNorm({ id: "N1" });
		// Insert a materia so hasAnalisis returns true and the BOE fallback is skipped
		db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
			"N1",
			"Urbanismo",
		]);

		const { status, body } = await json("/v1/laws/N1/analisis");
		expect(status).toBe(200);
		expect(body.id).toBe("N1");
		expect(body.materias).toEqual(["Urbanismo"]);
		expect(body.notas).toEqual([]);
		expect(body.referencias.anteriores).toEqual([]);
		expect(body.referencias.posteriores).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// GET /v1/laws/:id/graph
// ---------------------------------------------------------------------------

describe("GET /v1/laws/:id/graph", () => {
	it("returns 404 for non-existent law", async () => {
		const { status, body } = await json("/v1/laws/NOPE/graph");
		expect(status).toBe(404);
		expect(body.error).toBe("Law not found");
	});

	it("returns graph with the law as a node", async () => {
		insertNorm({ id: "N1", title: "Test", rank: "ley" });
		const { status, body } = await json("/v1/laws/N1/graph");
		expect(status).toBe(200);
		expect(body.nodes).toHaveLength(1);
		expect(body.nodes[0].id).toBe("N1");
		expect(body.edges).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// GET /v1/materias
// ---------------------------------------------------------------------------

describe("GET /v1/ranks", () => {
	it("returns ranks with counts", async () => {
		insertNorm({ id: "N1", rank: "ley" });
		insertNorm({ id: "N2", rank: "ley" });
		insertNorm({ id: "N3", rank: "constitucion" });

		const { status, body } = await json("/v1/ranks");
		expect(status).toBe(200);
		expect(body.data).toHaveLength(2);
		expect(body.data[0].rank).toBe("ley");
		expect(body.data[0].count).toBe(2);
	});
});

describe("GET /v1/materias", () => {
	it("returns materia list with counts", async () => {
		insertNorm({ id: "N1", rank: "ley" });
		db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
			"N1",
			"Derecho penal",
		]);
		db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
			"N1",
			"Seguridad",
		]);

		const { status, body } = await json("/v1/materias");
		expect(status).toBe(200);
		expect(body.data).toHaveLength(2);
		expect(body.data[0].materia).toBeDefined();
		expect(body.data[0].count).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// GET /v1/laws/:id/versions/:date
// ---------------------------------------------------------------------------

describe("GET /v1/laws/:id/versions/:date", () => {
	it("returns 404 for non-existent law", async () => {
		const { status, body } = await json("/v1/laws/NOPE/versions/2024-01-01");
		expect(status).toBe(404);
		expect(body.error).toBe("Law not found");
	});

	it("returns 404 when git has no version at that date", async () => {
		insertNorm({ id: "N1" });
		const { status, body } = await json("/v1/laws/N1/versions/2024-01-01");
		expect(status).toBe(404);
		expect(body.error).toBe("Version not found at this date");
	});
});

// ---------------------------------------------------------------------------
// GET /v1/laws/:id/diff
// ---------------------------------------------------------------------------

describe("GET /v1/laws/:id/diff", () => {
	it("returns 404 for non-existent law", async () => {
		const { status, body } = await json(
			"/v1/laws/NOPE/diff?from=2020-01-01&to=2024-01-01",
		);
		expect(status).toBe(404);
		expect(body.error).toBe("Law not found");
	});

	it("returns 400 when from/to params are missing", async () => {
		insertNorm({ id: "N1" });
		const { status, body } = await json("/v1/laws/N1/diff");
		expect(status).toBe(400);
		expect(body.error).toContain("required");
	});
});

// ---------------------------------------------------------------------------
// GET /v1/feed.xml
// ---------------------------------------------------------------------------

describe("GET /v1/feed.xml", () => {
	it("returns valid RSS XML", async () => {
		insertNorm({ id: "N1", title: "Test Law" });
		insertReform("N1", "2024-01-15", "S1");

		const res = await req("/v1/feed.xml");
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("<?xml");
		expect(text).toContain("<rss");
		expect(text).toContain("Test Law");
	});

	it("escapes XML special characters in titles", async () => {
		insertNorm({ id: "N1", title: 'Law & "Order" <2024>' });
		insertReform("N1", "2024-01-15", "S1");

		const res = await req("/v1/feed.xml");
		const text = await res.text();
		expect(text).toContain("&amp;");
		expect(text).toContain("&lt;");
		expect(text).toContain("&gt;");
		expect(text).toContain("&quot;");
	});
});

// ---------------------------------------------------------------------------
// Helper for reform_blocks used in route tests
// ---------------------------------------------------------------------------

function insertReformBlock(
	normId: string,
	date: string,
	sourceId: string,
	blockId: string,
) {
	db.run(
		"INSERT INTO reform_blocks (norm_id, reform_date, reform_source_id, block_id) VALUES (?, ?, ?, ?)",
		[normId, date, sourceId, blockId],
	);
}

// ---------------------------------------------------------------------------
// Omnibus endpoints
// ---------------------------------------------------------------------------

describe("GET /v1/omnibus", () => {
	it("returns empty list when no omnibus topics exist", async () => {
		const { status, body } = await json("/v1/omnibus");
		expect(status).toBe(200);
		expect(body.data).toEqual([]);
	});

	it("returns omnibus norms with topics", async () => {
		insertNorm({ id: "OT1", title: "Ley Omnibus Test" });
		db.run("INSERT INTO reforms (norm_id, date, source_id) VALUES (?, ?, ?)", [
			"OT1",
			"2026-03-20",
			"OT1",
		]);
		for (let i = 0; i < 16; i++) {
			db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
				"OT1",
				`Materia${i}`,
			]);
		}
		dbService.upsertOmnibusTopic("OT1", 0, {
			topicLabel: "Fiscal",
			headline: "H",
			summary: "S",
			articleCount: 5,
			isSneaked: false,
			relatedMaterias: "[]",
			model: "t",
		});
		dbService.upsertOmnibusTopic("OT1", 1, {
			topicLabel: "Penal",
			headline: "H2",
			summary: "S2",
			articleCount: 1,
			isSneaked: true,
			relatedMaterias: "[]",
			model: "t",
		});

		const { status, body } = await json("/v1/omnibus");
		expect(status).toBe(200);
		expect(body.data).toHaveLength(1);
		expect(body.data[0].id).toBe("OT1");
		expect(body.data[0].topic_count).toBe(2);
		expect(body.data[0].sneaked_count).toBe(1);
	});
});

describe("GET /v1/omnibus/:normId", () => {
	it("returns 404 for unknown norm", async () => {
		const { status, body } = await json("/v1/omnibus/NONEXISTENT");
		expect(status).toBe(404);
		expect(body.error).toBeDefined();
	});

	it("returns detail with topics", async () => {
		insertNorm({ id: "OT2", title: "Detail Test" });
		db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
			"OT2",
			"Energia",
		]);
		dbService.upsertOmnibusTopic("OT2", 0, {
			topicLabel: "Energía",
			headline: "Cambios energéticos",
			summary: "Se modifica la ley eléctrica",
			articleCount: 8,
			isSneaked: false,
			relatedMaterias: "[]",
			model: "t",
		});

		const { status, body } = await json("/v1/omnibus/OT2");
		expect(status).toBe(200);
		expect(body.title).toBe("Detail Test");
		expect(body.topics).toHaveLength(1);
		expect(body.topics[0].topic_label).toBe("Energía");
		expect(body.sneaked_count).toBe(0);
	});
});

describe("GET /v1/feed-omnibus.xml", () => {
	it("returns valid RSS XML", async () => {
		insertNorm({ id: "OT3", title: "RSS & Test <Law>" });
		db.run("INSERT INTO reforms (norm_id, date, source_id) VALUES (?, ?, ?)", [
			"OT3",
			"2026-03-25",
			"OT3",
		]);
		for (let i = 0; i < 16; i++) {
			db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
				"OT3",
				`M${i}`,
			]);
		}
		dbService.upsertOmnibusTopic("OT3", 0, {
			topicLabel: "Fiscal",
			headline: "H",
			summary: "S",
			articleCount: 3,
			isSneaked: false,
			relatedMaterias: "[]",
			model: "t",
		});

		const res = await app.handle(
			new Request("http://localhost/v1/feed-omnibus.xml"),
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("<?xml");
		expect(text).toContain("<rss");
		// Verify XML escaping
		expect(text).toContain("RSS &amp; Test &lt;Law&gt;");
		expect(text).toContain("Fiscal");
	});
});
