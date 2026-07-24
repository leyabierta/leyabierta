/**
 * Integration tests for the BOE diario surface added in #130 stage 4:
 *   - origin/consolidated/section exposed on /v1/laws and /v1/laws/:id
 *   - ?consolidated=0|1 filter on /v1/laws
 *   - GET /v1/boe/:fecha
 *
 * Mirrors the setup in routes.test.ts (real in-memory DbService, stubbed
 * GitService/CitizenSummaryService/HybridSearcher).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import { Elysia } from "elysia";
import { lawRoutes, type SearchResponse } from "../routes/laws.ts";
import { LruCache } from "../services/cache.ts";
import type { CitizenSummaryService } from "../services/citizen-summary.ts";
import { DbService } from "../services/db.ts";
import type { GitService } from "../services/git.ts";
import type { HybridSearcher } from "../services/hybrid-search.ts";

let db: Database;
let dbService: DbService;
// `let app: Elysia` + reassigning `.use(lawRoutes(...))` in beforeEach makes
// tsgo complain the route-specific type isn't assignable to the bare
// `Elysia` annotation — inferring the type from the builder function instead
// (rather than widening to Elysia, which every other route test file does
// and which is why they carry the same pre-existing error) keeps this file
// clean.
function buildApp(dbg: DbService) {
	return new Elysia().use(
		lawRoutes(
			dbg,
			gitStub,
			new LruCache<string>(100),
			citizenSummaryStub,
			new LruCache<SearchResponse>(100),
			hybridStub,
		),
	);
}
let app: ReturnType<typeof buildApp>;

const gitStub: GitService = {
	repoPath: "/tmp/fake",
	getFileAtDate: async () => null,
	getFileLatest: async () => null,
	diff: async () => null,
	log: async () => [],
} as unknown as GitService;

const citizenSummaryStub: CitizenSummaryService = {
	getOrGenerate: async () => null,
} as unknown as CitizenSummaryService;

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

beforeEach(() => {
	db = new Database(":memory:");
	createSchema(db);
	dbService = new DbService(db);
	app = buildApp(dbService);
});

afterEach(() => {
	db.close();
});

function insertNorm(overrides: Partial<Record<string, string | number>> = {}) {
	const defaults = {
		id: "BOE-A-2026-1",
		title: "Ley de prueba",
		short_title: "LP",
		country: "es",
		jurisdiction: "es",
		rank: "ley",
		published_at: "2026-07-23",
		updated_at: "2026-07-23",
		status: "vigente",
		department: "Ministerio de Prueba",
		source_url: "https://www.boe.es/eli/es/l/2026/07/23/1",
		origin: "consolidado",
		consolidated: 1,
		section: "",
	};
	const d = { ...defaults, ...overrides };
	db.run(
		`INSERT INTO norms
			(id, title, short_title, country, jurisdiction, rank, published_at, updated_at, status, department, source_url, origin, consolidated, section)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			d.id,
			d.title,
			d.short_title,
			d.country,
			d.jurisdiction,
			d.rank,
			d.published_at,
			d.updated_at,
			d.status,
			d.department,
			d.source_url,
			d.origin,
			d.consolidated,
			d.section,
		],
	);
}

// Elysia's `.handle()` response typing narrows `.json()` to `unknown`
// (unlike the DOM/Bun `Response.json(): Promise<any>`), so callers must
// supply the shape they expect — see the response interfaces below.
async function json<T>(path: string): Promise<{ status: number; body: T }> {
	const res = await app.handle(new Request(`http://localhost${path}`));
	return { status: res.status, body: (await res.json()) as T };
}

interface LawListItem {
	id: string;
	origin: string;
	consolidated: number;
	section: string;
}
interface LawsListResponse {
	data: LawListItem[];
	total: number;
}
interface LawDetailResponse {
	origin: string;
	consolidated: number;
	section: string;
}
interface BoeItemResponse {
	id: string;
	shortTitle: string;
	consolidated: boolean;
}
interface BoeSectionResponse {
	section: string;
	items: BoeItemResponse[];
}
interface BoeDayResponse {
	error?: string;
	date?: string;
	total?: number;
	sections?: BoeSectionResponse[];
}

// ---------------------------------------------------------------------------
// origin/consolidated/section on GET /v1/laws and /v1/laws/:id
// ---------------------------------------------------------------------------

describe("GET /v1/laws — origin/consolidated/section fields", () => {
	it("exposes origin, consolidated, section on list items", async () => {
		insertNorm({
			id: "DIARIO-1",
			origin: "diario",
			consolidated: 0,
			section: "1",
		});

		const { body } = await json<LawsListResponse>("/v1/laws");
		expect(body.data).toHaveLength(1);
		expect(body.data[0]?.origin).toBe("diario");
		expect(body.data[0]?.consolidated).toBe(0);
		expect(body.data[0]?.section).toBe("1");
	});

	it("defaults to consolidado/consolidated=1 for normal norms", async () => {
		insertNorm({ id: "N1" });
		const { body } = await json<LawsListResponse>("/v1/laws");
		expect(body.data[0]?.origin).toBe("consolidado");
		expect(body.data[0]?.consolidated).toBe(1);
	});
});

describe("GET /v1/laws/:id — origin/consolidated/section fields", () => {
	it("exposes the fields on the detail response", async () => {
		insertNorm({
			id: "DIARIO-2",
			origin: "diario",
			consolidated: 0,
			section: "2A",
		});

		const { status, body } = await json<LawDetailResponse>("/v1/laws/DIARIO-2");
		expect(status).toBe(200);
		expect(body.origin).toBe("diario");
		expect(body.consolidated).toBe(0);
		expect(body.section).toBe("2A");
	});
});

// ---------------------------------------------------------------------------
// ?consolidated=0|1 filter
// ---------------------------------------------------------------------------

describe("GET /v1/laws?consolidated=", () => {
	it("does not filter anything by default", async () => {
		insertNorm({ id: "N1", consolidated: 1 });
		insertNorm({ id: "N2", consolidated: 0, origin: "diario" });

		const { body } = await json<LawsListResponse>("/v1/laws");
		expect(body.total).toBe(2);
	});

	it("filters to only diario (unconsolidated) norms with consolidated=0", async () => {
		insertNorm({ id: "N1", consolidated: 1 });
		insertNorm({ id: "N2", consolidated: 0, origin: "diario" });

		const { body } = await json<LawsListResponse>("/v1/laws?consolidated=0");
		expect(body.total).toBe(1);
		expect(body.data[0]?.id).toBe("N2");
	});

	it("filters to only consolidated norms with consolidated=1", async () => {
		insertNorm({ id: "N1", consolidated: 1 });
		insertNorm({ id: "N2", consolidated: 0, origin: "diario" });

		const { body } = await json<LawsListResponse>("/v1/laws?consolidated=1");
		expect(body.total).toBe(1);
		expect(body.data[0]?.id).toBe("N1");
	});

	it("ignores an invalid consolidated value (falls back to no filter)", async () => {
		insertNorm({ id: "N1", consolidated: 1 });
		insertNorm({ id: "N2", consolidated: 0, origin: "diario" });

		const { body } = await json<LawsListResponse>("/v1/laws?consolidated=nope");
		expect(body.total).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// GET /v1/boe/:fecha
// ---------------------------------------------------------------------------

describe("GET /v1/boe/:fecha", () => {
	it("returns 400 for a malformed date", async () => {
		const { status, body } = await json<BoeDayResponse>("/v1/boe/not-a-date");
		expect(status).toBe(400);
		expect(body.error).toContain("Invalid date");
	});

	it("returns an empty day gracefully", async () => {
		const { status, body } = await json<BoeDayResponse>("/v1/boe/2026-07-23");
		expect(status).toBe(200);
		expect(body.date).toBe("2026-07-23");
		expect(body.total).toBe(0);
		expect(body.sections).toEqual([]);
	});

	it("groups items by section in natural order", async () => {
		insertNorm({
			id: "A",
			published_at: "2026-07-23",
			origin: "diario",
			consolidated: 0,
			section: "1",
			title: "Norma seccion 1",
		});
		insertNorm({
			id: "B",
			published_at: "2026-07-23",
			origin: "diario",
			consolidated: 0,
			section: "2A",
			title: "Norma seccion 2A",
		});
		insertNorm({
			id: "C",
			published_at: "2026-07-23",
			origin: "diario",
			consolidated: 0,
			section: "2B",
			title: "Norma seccion 2B",
		});
		// Section "3" and "5A" are the regression guard: a length-first sort
		// (the bug this test protects against) would put single-char "3" before
		// two-char "2A". True BOE order is by numeric prefix, so "3" comes AFTER
		// "2A"/"2B" and "5A" last.
		insertNorm({
			id: "E",
			published_at: "2026-07-23",
			origin: "diario",
			consolidated: 0,
			section: "3",
			title: "Norma seccion 3",
		});
		insertNorm({
			id: "F",
			published_at: "2026-07-23",
			origin: "diario",
			consolidated: 0,
			section: "5A",
			title: "Norma seccion 5A",
		});
		// A norm published a different day must not leak in.
		insertNorm({
			id: "D",
			published_at: "2026-07-22",
			origin: "diario",
			consolidated: 0,
			section: "1",
			title: "Norma de ayer",
		});

		const { status, body } = await json<BoeDayResponse>("/v1/boe/2026-07-23");
		expect(status).toBe(200);
		expect(body.total).toBe(5);
		expect(body.sections?.map((s) => s.section)).toEqual([
			"1",
			"2A",
			"2B",
			"3",
			"5A",
		]);
		expect(body.sections?.[0]?.items[0]?.id).toBe("A");
		expect(body.sections?.[0]?.items[0]?.shortTitle).toBe("LP");
		expect(body.sections?.[0]?.items[0]?.consolidated).toBe(false);
	});

	it("includes already-consolidated norms published that day too", async () => {
		insertNorm({
			id: "E",
			published_at: "2026-07-23",
			origin: "consolidado",
			consolidated: 1,
			section: "1",
		});

		const { body } = await json<BoeDayResponse>("/v1/boe/2026-07-23");
		expect(body.total).toBe(1);
		expect(body.sections?.[0]?.items[0]?.consolidated).toBe(true);
	});
});
