/**
 * Unit tests for the AND/OR adaptive matcher in bm25ArticleSearch.
 *
 * The function should:
 *   a) Return AND results when they meet AND_FALLBACK_THRESHOLD (=20).
 *   b) Fall back to OR when AND is too sparse, so recall isn't hurt by
 *      a hyper-specific token combination.
 *   c) Run a single match for 1-token queries (AND ≡ OR).
 *
 * We seed an in-memory FTS5 table with synthetic blocks so the test
 * is hermetic.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	bm25ArticleSearch,
	ensureBlocksFtsVocab,
	resetBlocksFtsCaches,
} from "../services/rag/blocks-fts.ts";

let db: Database;

function seed(blocks: Array<{ id: string; norm: string; content: string }>) {
	db.exec(`CREATE VIRTUAL TABLE blocks_fts USING fts5(
		norm_id UNINDEXED,
		block_id UNINDEXED,
		title,
		norm_title,
		content,
		tokenize='unicode61 remove_diacritics 2'
	)`);
	const stmt = db.prepare(
		"INSERT INTO blocks_fts (norm_id, block_id, title, norm_title, content) VALUES (?, ?, ?, ?, ?)",
	);
	for (const b of blocks) {
		stmt.run(b.norm, b.id, "", "", b.content);
	}
}

beforeEach(() => {
	db = new Database(":memory:");
	// Cross-test isolation — module-level docfreq cache is keyed on token
	// string, not on DB instance, so a previous test's vocab counts could
	// leak into this one's pruning decisions.
	resetBlocksFtsCaches();
});

afterEach(() => {
	db.close();
});

describe("bm25ArticleSearch AND adaptive", () => {
	test("uses AND when results meet threshold (≥20)", () => {
		// 25 docs that all contain BOTH "vacaciones" and "trabajador".
		const blocks = Array.from({ length: 25 }, (_, i) => ({
			id: `b${i}`,
			norm: `N${i}`,
			content: "vacaciones del trabajador asalariado",
		}));
		// 30 noise docs that contain only "trabajador" (would inflate OR).
		for (let i = 0; i < 30; i++) {
			blocks.push({
				id: `n${i}`,
				norm: `M${i}`,
				content: "trabajador autónomo",
			});
		}
		seed(blocks);

		const results = bm25ArticleSearch(db, "vacaciones trabajador", 50);
		// AND match yields exactly 25 → should be returned (>=20).
		expect(results.length).toBe(25);
	});

	test("falls back to OR when AND is sparse (<20)", () => {
		// Only 3 docs match AND on both rare terms.
		const blocks = [
			{ id: "a1", norm: "N1", content: "criptomoneda blockchain regulada" },
			{ id: "a2", norm: "N2", content: "criptomoneda blockchain emisor" },
			{ id: "a3", norm: "N3", content: "criptomoneda blockchain custodia" },
		];
		// 50 noise docs with only "blockchain". OR should pick these up.
		for (let i = 0; i < 50; i++) {
			blocks.push({
				id: `n${i}`,
				norm: `M${i}`,
				content: "blockchain redes distribuidas",
			});
		}
		seed(blocks);

		const results = bm25ArticleSearch(db, "criptomoneda blockchain", 50);
		// AND alone would return 3 (<20) → fallback to OR → much more.
		expect(results.length).toBeGreaterThan(20);
		// The 3 AND-matching docs are still in there (OR is a superset).
		const ids = new Set(results.map((r) => r.blockId));
		expect(ids.has("a1")).toBe(true);
		expect(ids.has("a2")).toBe(true);
		expect(ids.has("a3")).toBe(true);
	});

	test("single-token query bypasses AND/OR branching", () => {
		const blocks = [
			{ id: "x1", norm: "N1", content: "salario mínimo interprofesional" },
			{ id: "x2", norm: "N2", content: "salario base del convenio" },
			{ id: "x3", norm: "N3", content: "ningún término relevante aquí" },
		];
		seed(blocks);

		const results = bm25ArticleSearch(db, "salario", 50);
		expect(results.length).toBe(2);
	});

	test("empty query returns []", () => {
		seed([{ id: "a", norm: "N", content: "foo bar" }]);
		expect(bm25ArticleSearch(db, "", 50)).toEqual([]);
		// All tokens filtered out (length <= 2)
		expect(bm25ArticleSearch(db, "el la de", 50)).toEqual([]);
	});

	test("OR fallback prunes high-docfreq tokens via fts5vocab", () => {
		// "comun" appears in 90% of documents → should be pruned in OR.
		// "raro" appears in only 5 → AND with both rarely hits, OR keeps "raro".
		const blocks: Array<{ id: string; norm: string; content: string }> = [];
		for (let i = 0; i < 90; i++) {
			blocks.push({ id: `c${i}`, norm: `N${i}`, content: "comun palabra" });
		}
		for (let i = 0; i < 5; i++) {
			// These have BOTH "raro" and "comun"
			blocks.push({
				id: `r${i}`,
				norm: `R${i}`,
				content: "raro palabra comun",
			});
		}
		seed(blocks);

		// Build the vocab table (main thread role).
		ensureBlocksFtsVocab(db);

		// AND of "raro" and "comun" yields 5 (<20) → triggers OR fallback.
		// Without pruning, OR matches 95 docs. With pruning ("comun" hits
		// >30% of the corpus → dropped), OR runs only on "raro" → 5 docs.
		const results = bm25ArticleSearch(db, "raro comun", 50);

		// Strong assertion: pruning actually fired. If the vocab table or
		// the lookup misbehaved, getDocfreq returns 0 → no pruning → full
		// OR returns ~95 results, and this assertion fails loudly.
		expect(results.length).toBeLessThanOrEqual(10);

		// Recall preserved: the 5 rare docs are still present.
		const ids = new Set(results.map((r) => r.blockId));
		for (let i = 0; i < 5; i++) expect(ids.has(`r${i}`)).toBe(true);
	});

	test("respects normFilter on both AND and OR paths", () => {
		const blocks = Array.from({ length: 30 }, (_, i) => ({
			id: `b${i}`,
			norm: i < 10 ? "TARGET" : "OTHER",
			content: "vacaciones trabajador asalariado",
		}));
		seed(blocks);

		const results = bm25ArticleSearch(db, "vacaciones trabajador", 50, [
			"TARGET",
		]);
		expect(results.length).toBe(10);
		expect(results.every((r) => r.normId === "TARGET")).toBe(true);
	});
});
