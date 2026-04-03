/**
 * Unit tests for DbService.
 *
 * Uses an in-memory SQLite database with the real schema
 * so queries run against actual tables and indexes.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import { DbService } from "../services/db.ts";

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

function insertVersion(
	normId: string,
	blockId: string,
	date: string,
	sourceId: string,
	text: string,
) {
	db.run(
		"INSERT INTO versions (norm_id, block_id, date, source_id, text) VALUES (?, ?, ?, ?, ?)",
		[normId, blockId, date, sourceId, text],
	);
}

function insertFts(normId: string, title: string, content: string) {
	db.run("INSERT INTO norms_fts (norm_id, title, content) VALUES (?, ?, ?)", [
		normId,
		title,
		content,
	]);
}

// ---------------------------------------------------------------------------
// searchLaws
// ---------------------------------------------------------------------------

describe("searchLaws", () => {
	it("returns empty when no norms exist", () => {
		const { laws, total } = svc.searchLaws(undefined, {}, 20, 0);
		expect(laws).toEqual([]);
		expect(total).toBe(0);
	});

	it("returns all norms without filters", () => {
		insertNorm();
		insertNorm({ id: "BOE-A-2000-1", title: "Ley X", rank: "ley" });

		const { laws, total } = svc.searchLaws(undefined, {}, 20, 0);
		expect(total).toBe(2);
		expect(laws).toHaveLength(2);
	});

	it("filters by country", () => {
		insertNorm({ id: "N1", country: "es" });
		insertNorm({ id: "N2", country: "fr" });

		const { laws, total } = svc.searchLaws(undefined, { country: "es" }, 20, 0);
		expect(total).toBe(1);
		expect(laws[0].id).toBe("N1");
	});

	it("filters by rank", () => {
		insertNorm({ id: "N1", rank: "ley" });
		insertNorm({ id: "N2", rank: "constitucion" });

		const { laws } = svc.searchLaws(undefined, { rank: "ley" }, 20, 0);
		expect(laws).toHaveLength(1);
		expect(laws[0].id).toBe("N1");
	});

	it("filters by status", () => {
		insertNorm({ id: "N1", status: "vigente" });
		insertNorm({ id: "N2", status: "derogada" });

		const { laws } = svc.searchLaws(undefined, { status: "vigente" }, 20, 0);
		expect(laws).toHaveLength(1);
		expect(laws[0].id).toBe("N1");
	});

	it("combines multiple filters", () => {
		insertNorm({ id: "N1", country: "es", rank: "ley", status: "vigente" });
		insertNorm({
			id: "N2",
			country: "es",
			rank: "ley",
			status: "derogada",
		});
		insertNorm({
			id: "N3",
			country: "fr",
			rank: "ley",
			status: "vigente",
		});

		const { laws } = svc.searchLaws(
			undefined,
			{ country: "es", rank: "ley", status: "vigente" },
			20,
			0,
		);
		expect(laws).toHaveLength(1);
		expect(laws[0].id).toBe("N1");
	});

	it("respects limit and offset for pagination", () => {
		for (let i = 1; i <= 5; i++) {
			insertNorm({
				id: `N${i}`,
				published_at: `2020-0${i}-01`,
			});
		}

		const page1 = svc.searchLaws(undefined, {}, 2, 0);
		expect(page1.total).toBe(5);
		expect(page1.laws).toHaveLength(2);

		const page2 = svc.searchLaws(undefined, {}, 2, 2);
		expect(page2.laws).toHaveLength(2);
		// Pages should not overlap
		expect(page1.laws[0].id).not.toBe(page2.laws[0].id);
	});

	it("searches via FTS5 when query is provided", () => {
		insertNorm({ id: "N1", title: "Constitucion Espanola" });
		insertNorm({ id: "N2", title: "Codigo Penal" });
		insertFts("N1", "Constitucion Espanola", "derechos fundamentales");
		insertFts("N2", "Codigo Penal", "delitos y penas");

		const { laws } = svc.searchLaws("Constitucion", {}, 20, 0);
		expect(laws).toHaveLength(1);
		expect(laws[0].id).toBe("N1");
	});

	it("ranks title matches higher than content-only matches", () => {
		// The actual "Codigo Penal" law has the term in its title
		insertNorm({ id: "CP", title: "Codigo Penal" });
		insertFts("CP", "Codigo Penal", "delitos y penas");

		// A law that *modifies* the Codigo Penal mentions it many times in content
		insertNorm({ id: "MOD1", title: "Ley Organica de reforma" });
		insertFts(
			"MOD1",
			"Ley Organica de reforma",
			"modifica el codigo penal. codigo penal articulo 1. codigo penal articulo 2. codigo penal articulo 3.",
		);

		insertNorm({ id: "MOD2", title: "Ley de modificacion" });
		insertFts(
			"MOD2",
			"Ley de modificacion",
			"se reforma el codigo penal. codigo penal disposicion. codigo penal titulo.",
		);

		const { laws } = svc.searchLaws("codigo penal", {}, 20, 0);
		expect(laws).toHaveLength(3);
		// The law with "codigo penal" in the title should come first
		expect(laws[0].id).toBe("CP");
	});

	it("returns empty when FTS query has no matches", () => {
		insertNorm({ id: "N1" });
		insertFts("N1", "Constitucion", "text");

		const { laws, total } = svc.searchLaws("nonexistent", {}, 20, 0);
		expect(laws).toEqual([]);
		expect(total).toBe(0);
	});

	it("applies filters on top of FTS results", () => {
		insertNorm({ id: "N1", status: "vigente" });
		insertNorm({ id: "N2", status: "derogada" });
		insertFts("N1", "Codigo", "penal");
		insertFts("N2", "Codigo", "civil");

		const { laws } = svc.searchLaws("Codigo", { status: "vigente" }, 20, 0);
		expect(laws).toHaveLength(1);
		expect(laws[0].id).toBe("N1");
	});
});

// ---------------------------------------------------------------------------
// getLaw
// ---------------------------------------------------------------------------

describe("getLaw", () => {
	it("returns null for non-existent id", () => {
		expect(svc.getLaw("NOPE")).toBeNull();
	});

	it("returns the norm row", () => {
		insertNorm({ id: "N1", title: "Test Law" });
		const law = svc.getLaw("N1");
		expect(law).not.toBeNull();
		expect(law!.title).toBe("Test Law");
		expect(law!.country).toBe("es");
	});
});

// ---------------------------------------------------------------------------
// getBlocks
// ---------------------------------------------------------------------------

describe("getBlocks", () => {
	it("returns empty array when no blocks exist", () => {
		expect(svc.getBlocks("N1")).toEqual([]);
	});

	it("returns blocks ordered by position", () => {
		insertNorm({ id: "N1" });
		insertBlock("N1", "art-3", 3);
		insertBlock("N1", "art-1", 1);
		insertBlock("N1", "art-2", 2);

		const blocks = svc.getBlocks("N1");
		expect(blocks).toHaveLength(3);
		expect(blocks[0].block_id).toBe("art-1");
		expect(blocks[1].block_id).toBe("art-2");
		expect(blocks[2].block_id).toBe("art-3");
	});
});

// ---------------------------------------------------------------------------
// getBlockByPosition
// ---------------------------------------------------------------------------

describe("getBlockByPosition", () => {
	it("returns null for non-existent position", () => {
		expect(svc.getBlockByPosition("N1", 99)).toBeNull();
	});

	it("returns the correct block", () => {
		insertNorm({ id: "N1" });
		insertBlock("N1", "art-1", 1);
		insertBlock("N1", "art-2", 2);

		const block = svc.getBlockByPosition("N1", 2);
		expect(block).not.toBeNull();
		expect(block!.block_id).toBe("art-2");
	});
});

// ---------------------------------------------------------------------------
// getReforms
// ---------------------------------------------------------------------------

describe("getReforms", () => {
	it("returns empty array when no reforms exist", () => {
		expect(svc.getReforms("N1")).toEqual([]);
	});

	it("returns reforms ordered by date", () => {
		insertNorm({ id: "N1" });
		insertReform("N1", "2024-01-01", "BOE-2024-1");
		insertReform("N1", "2020-06-15", "BOE-2020-1");

		const reforms = svc.getReforms("N1");
		expect(reforms).toHaveLength(2);
		expect(reforms[0].date).toBe("2020-06-15");
		expect(reforms[1].date).toBe("2024-01-01");
	});
});

// ---------------------------------------------------------------------------
// getReformBlocks
// ---------------------------------------------------------------------------

describe("getReformBlocks", () => {
	it("returns block ids affected by a reform", () => {
		insertNorm({ id: "N1" });
		insertBlock("N1", "art-1", 1);
		insertBlock("N1", "art-2", 2);
		insertReform("N1", "2024-01-01", "S1");
		insertReformBlock("N1", "2024-01-01", "S1", "art-1");
		insertReformBlock("N1", "2024-01-01", "S1", "art-2");

		const blockIds = svc.getReformBlocks("N1", "2024-01-01", "S1");
		expect(blockIds).toHaveLength(2);
		expect(blockIds).toContain("art-1");
		expect(blockIds).toContain("art-2");
	});

	it("returns empty array when no blocks were affected", () => {
		insertNorm({ id: "N1" });
		insertReform("N1", "2024-01-01", "S1");

		const blockIds = svc.getReformBlocks("N1", "2024-01-01", "S1");
		expect(blockIds).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// getVersions
// ---------------------------------------------------------------------------

describe("getVersions", () => {
	it("returns versions ordered by date", () => {
		insertNorm({ id: "N1" });
		insertBlock("N1", "art-1", 1);
		insertVersion("N1", "art-1", "2024-01-01", "S1", "Version 2");
		insertVersion("N1", "art-1", "1978-12-29", "S0", "Version 1");

		const versions = svc.getVersions("N1", "art-1");
		expect(versions).toHaveLength(2);
		expect(versions[0].date).toBe("1978-12-29");
		expect(versions[1].text).toBe("Version 2");
	});
});

// ---------------------------------------------------------------------------
// getRanks
// ---------------------------------------------------------------------------

describe("getRanks", () => {
	it("returns empty array when no norms exist", () => {
		expect(svc.getRanks()).toEqual([]);
	});

	it("returns ranks grouped by count descending", () => {
		insertNorm({ id: "N1", rank: "ley" });
		insertNorm({ id: "N2", rank: "ley" });
		insertNorm({ id: "N3", rank: "constitucion" });

		const ranks = svc.getRanks();
		expect(ranks).toHaveLength(2);
		expect(ranks[0].rank).toBe("ley");
		expect(ranks[0].count).toBe(2);
		expect(ranks[1].rank).toBe("constitucion");
		expect(ranks[1].count).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// getRecentReforms
// ---------------------------------------------------------------------------

describe("getRecentReforms", () => {
	it("returns recent reforms with norm title", () => {
		insertNorm({ id: "N1", title: "Law A" });
		insertReform("N1", "2024-01-01", "S1");
		insertReform("N1", "2023-06-01", "S2");

		const recent = svc.getRecentReforms(1);
		expect(recent).toHaveLength(1);
		expect(recent[0].title).toBe("Law A");
		expect(recent[0].date).toBe("2024-01-01");
	});
});

// ---------------------------------------------------------------------------
// getMaterias
// ---------------------------------------------------------------------------

describe("getMaterias", () => {
	it("returns empty array when no materias exist", () => {
		expect(svc.getMaterias("N1")).toEqual([]);
	});

	it("returns materias sorted alphabetically", () => {
		insertNorm({ id: "N1" });
		db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
			"N1",
			"Derecho penal",
		]);
		db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
			"N1",
			"Constitucion",
		]);

		const materias = svc.getMaterias("N1");
		expect(materias).toEqual(["Constitucion", "Derecho penal"]);
	});
});

// ---------------------------------------------------------------------------
// getNotas
// ---------------------------------------------------------------------------

describe("getNotas", () => {
	it("returns empty array when no notas exist", () => {
		expect(svc.getNotas("N1")).toEqual([]);
	});

	it("returns notas ordered by position", () => {
		insertNorm({ id: "N1" });
		db.run("INSERT INTO notas (norm_id, nota, position) VALUES (?, ?, ?)", [
			"N1",
			"Second note",
			2,
		]);
		db.run("INSERT INTO notas (norm_id, nota, position) VALUES (?, ?, ?)", [
			"N1",
			"First note",
			1,
		]);

		const notas = svc.getNotas("N1");
		expect(notas).toEqual(["First note", "Second note"]);
	});
});

// ---------------------------------------------------------------------------
// getReferencias
// ---------------------------------------------------------------------------

describe("getReferencias", () => {
	it("returns empty array when no references exist", () => {
		expect(svc.getReferencias("N1", "anterior")).toEqual([]);
	});

	it("returns anterior references", () => {
		insertNorm({ id: "N1" });
		db.run(
			"INSERT INTO referencias (norm_id, direction, relation, target_id, text) VALUES (?, ?, ?, ?, ?)",
			["N1", "anterior", "SE MODIFICA", "BOE-X-123", "art. 1"],
		);
		db.run(
			"INSERT INTO referencias (norm_id, direction, relation, target_id, text) VALUES (?, ?, ?, ?, ?)",
			["N1", "posterior", "DEROGA", "BOE-X-456", "disposicion final"],
		);

		const anterior = svc.getReferencias("N1", "anterior");
		expect(anterior).toHaveLength(1);
		expect(anterior[0].relation).toBe("SE MODIFICA");
		expect(anterior[0].target_id).toBe("BOE-X-123");

		const posterior = svc.getReferencias("N1", "posterior");
		expect(posterior).toHaveLength(1);
		expect(posterior[0].relation).toBe("DEROGA");
	});
});

// ---------------------------------------------------------------------------
// hasAnalisis
// ---------------------------------------------------------------------------

describe("hasAnalisis", () => {
	it("returns false when no materias or referencias exist", () => {
		expect(svc.hasAnalisis("N1")).toBe(false);
	});

	it("returns true when materias exist", () => {
		insertNorm({ id: "N1" });
		db.run("INSERT INTO materias (norm_id, materia) VALUES (?, ?)", [
			"N1",
			"Derecho penal",
		]);
		expect(svc.hasAnalisis("N1")).toBe(true);
	});

	it("returns true when referencias exist", () => {
		insertNorm({ id: "N1" });
		db.run(
			"INSERT INTO referencias (norm_id, direction, relation, target_id, text) VALUES (?, ?, ?, ?, ?)",
			["N1", "anterior", "MODIFICA", "BOE-X-1", ""],
		);
		expect(svc.hasAnalisis("N1")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getRecentDigests
// ---------------------------------------------------------------------------

describe("getRecentDigests", () => {
	it("returns correct number of recent digests", () => {
		svc.upsertDigest(
			"autonomos",
			"2026-W10",
			"es",
			"Summary W10",
			"2026-03-09T00:00:00Z",
			'{"reforms":[]}',
		);
		svc.upsertDigest(
			"autonomos",
			"2026-W11",
			"es",
			"Summary W11",
			"2026-03-16T00:00:00Z",
			'{"reforms":[]}',
		);
		svc.upsertDigest(
			"autonomos",
			"2026-W12",
			"es",
			"Summary W12",
			"2026-03-23T00:00:00Z",
			'{"reforms":[]}',
		);

		const results = svc.getRecentDigests("autonomos", 2);
		expect(results).toHaveLength(2);
	});

	it("handles missing profile gracefully", () => {
		const results = svc.getRecentDigests("nonexistent", 5);
		expect(results).toEqual([]);
	});

	it("returns results ordered by week DESC", () => {
		svc.upsertDigest(
			"fiscal",
			"2026-W08",
			"es",
			"S1",
			"2026-02-23T00:00:00Z",
			'{"reforms":[]}',
		);
		svc.upsertDigest(
			"fiscal",
			"2026-W10",
			"es",
			"S2",
			"2026-03-09T00:00:00Z",
			'{"reforms":[]}',
		);
		svc.upsertDigest(
			"fiscal",
			"2026-W09",
			"es",
			"S3",
			"2026-03-02T00:00:00Z",
			'{"reforms":[]}',
		);

		const results = svc.getRecentDigests("fiscal", 10);
		expect(results).toHaveLength(3);
		expect(results[0].week).toBe("2026-W10");
		expect(results[1].week).toBe("2026-W09");
		expect(results[2].week).toBe("2026-W08");
	});
});
