/**
 * Tests for the norm-level FTS5 search helpers (services/norms-fts-search.ts).
 *
 * Builds an in-memory FTS5 index with a known token distribution and
 * exercises the adaptive AND→OR fallback. The corpus is small but the
 * relative document frequencies match the prod shape (one ubiquitous
 * particle, one moderately common term, one rare term).
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	adaptiveSearch,
	buildAndExpr,
	buildOrFallback,
	ensureNormsFtsVocab,
	resetNormsFtsCaches,
	tokenizeQuery,
} from "../services/norms-fts-search.ts";

function buildCorpus(): Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE VIRTUAL TABLE norms_fts USING fts5(
			norm_id UNINDEXED,
			title,
			content,
			tokenize='unicode61 remove_diacritics 2'
		);
	`);
	// 100 norms total with the following document-frequency shape:
	//   "de"          → 100 docs (DF=1.0)   ubiquitous
	//   "ley"         → 100 docs (DF=1.0)   ubiquitous
	//   "vivienda"    → 25 docs  (DF=0.25)  below 0.3 cutoff → kept
	//   "casa"        → 12 docs  (DF=0.12)  rare → kept
	//   "blockchain"  → 1 doc                very rare → kept
	const insert = db.prepare(
		"INSERT INTO norms_fts (norm_id, title, content) VALUES (?, ?, ?)",
	);
	for (let i = 0; i < 100; i++) {
		const id = `BOE-A-2024-${i.toString().padStart(4, "0")}`;
		const parts = ["de", "ley"];
		if (i < 25) parts.push("vivienda");
		if (i < 12) parts.push("casa");
		if (i === 0) parts.push("blockchain");
		insert.run(id, `Norma ${i}`, parts.join(" "));
	}
	ensureNormsFtsVocab(db);
	return db;
}

afterEach(() => {
	resetNormsFtsCaches();
});

describe("tokenizeQuery", () => {
	test("strips short particles", () => {
		expect(tokenizeQuery("ley de vivienda")).toEqual([`"ley"`, `"vivienda"`]);
	});

	test("drops punctuation and quotes", () => {
		expect(tokenizeQuery(`"vivienda" ¿digna?`)).toEqual([
			`"vivienda"`,
			`"digna"`,
		]);
	});

	test("caps token count at 12", () => {
		const q = Array.from({ length: 20 }, (_, i) => `palabra${i}`).join(" ");
		expect(tokenizeQuery(q).length).toBe(12);
	});
});

describe("buildAndExpr / buildOrFallback", () => {
	test("AND expression scopes to a column", () => {
		expect(buildAndExpr([`"a"`, `"b"`], "title")).toBe(`title:("a" AND "b")`);
	});
	test("OR expression prunes high-DF tokens via vocab", () => {
		const db = buildCorpus();
		// "de" appears in 100/100 ⇒ above cutoff (0.3 × 100 = 30), pruned.
		// "vivienda" in 25/100 ⇒ below cutoff, kept.
		const result = buildOrFallback(db, [`"de"`, `"vivienda"`], "");
		expect(result).toContain(`"vivienda"`);
		expect(result).not.toContain(`"de"`);
	});

	test("OR expression keeps original tokens when pruning would empty list", () => {
		const db = buildCorpus();
		// Both "de" and "ley" are above the cutoff. Pruning would leave
		// nothing — recall trumps speed, so we keep both unchanged.
		const result = buildOrFallback(db, [`"de"`, `"ley"`], "");
		expect(result).toContain(`"de"`);
		expect(result).toContain(`"ley"`);
	});
});

describe("adaptiveSearch", () => {
	test("returns [] for empty token list", () => {
		const db = buildCorpus();
		expect(
			adaptiveSearch(db, {
				tokens: [],
				matchExprBuilder: (t) => t.join(" "),
				runMatch: () => ["x"],
			}),
		).toEqual([]);
	});

	test("single token: runs once with no AND/OR ceremony", () => {
		const db = buildCorpus();
		const calls: string[] = [];
		const out = adaptiveSearch(db, {
			tokens: [`"vivienda"`],
			matchExprBuilder: (t, j) => `${j}:${t.join(",")}`,
			runMatch: (expr) => {
				calls.push(expr);
				return ["a", "b"];
			},
		});
		expect(out).toEqual(["a", "b"]);
		expect(calls.length).toBe(1);
		// Builder shouldn't have been used for a single token.
		expect(calls[0]).toBe(`"vivienda"`);
	});

	test("multi-token AND path when results are plenty", () => {
		const db = buildCorpus();
		const calls: string[] = [];
		const out = adaptiveSearch(db, {
			tokens: [`"vivienda"`, `"casa"`],
			matchExprBuilder: (t, j) => t.join(` ${j} `),
			runMatch: (expr) => {
				calls.push(expr);
				// Pretend AND returned 50 hits (>= threshold of 20).
				return Array.from({ length: 50 }, (_, i) => `id-${i}`);
			},
		});
		expect(out.length).toBe(50);
		expect(calls.length).toBe(1);
		expect(calls[0]).toContain("AND");
	});

	test("multi-token OR fallback when AND is sparse", () => {
		const db = buildCorpus();
		const calls: string[] = [];
		let nthCall = 0;
		// Use two rare tokens so neither gets pruned and the OR expression
		// retains both — the test checks that the second pass switched joiner.
		const out = adaptiveSearch(db, {
			tokens: [`"casa"`, `"blockchain"`],
			matchExprBuilder: (t, j) => t.join(` ${j} `),
			runMatch: (expr) => {
				calls.push(expr);
				nthCall++;
				if (nthCall === 1) return ["BOE-A-2024-0000"];
				return Array.from({ length: 12 }, (_, i) => `id-${i}`);
			},
		});
		expect(calls.length).toBe(2);
		expect(calls[0]).toContain("AND");
		expect(calls[1]).toContain("OR");
		expect(out.length).toBe(12);
	});

	test("OR fallback prunes ubiquitous tokens", () => {
		const db = buildCorpus();
		// Force AND to fail by returning 0 hits — OR fallback runs.
		// "de" appears in 100/100 ⇒ pruned out of OR expression. We assert the
		// expression sent to runMatch on the OR call has NO "de" token.
		const seen: string[] = [];
		let nthCall = 0;
		adaptiveSearch(db, {
			tokens: [`"de"`, `"blockchain"`],
			matchExprBuilder: (t, j) => t.join(` ${j} `),
			runMatch: (expr) => {
				seen.push(expr);
				nthCall++;
				return nthCall === 1 ? [] : ["BOE-A-2024-0000"];
			},
		});
		expect(seen[1]).not.toContain(`"de"`);
		expect(seen[1]).toContain(`"blockchain"`);
	});
});

describe("integration: against real norms_fts", () => {
	test("BM25-ordered MATCH returns top-k for common term without scanning all", () => {
		const db = buildCorpus();
		const ids = db
			.query<{ norm_id: string }, [string]>(
				`SELECT norm_id FROM norms_fts
				 WHERE norms_fts MATCH ?
				 ORDER BY bm25(norms_fts)
				 LIMIT 5`,
			)
			.all(`"vivienda"`)
			.map((r) => r.norm_id);
		expect(ids.length).toBe(5);
	});
});
