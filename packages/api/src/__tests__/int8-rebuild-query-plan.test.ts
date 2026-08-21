/**
 * The int8 rebuild reads every embedding for one model in (norm_id, block_id)
 * order. Each row carries a 16 KB vector blob, so how SQLite reaches that order
 * is the difference between a ~20 MB streaming build and materialising ~8 GB.
 *
 * On 2026-08-21 there was no index covering the filter *and* the sort. SQLite
 * satisfied `model = ?` with idx_embeddings_model and sorted the rest through a
 * TEMP B-TREE. The API was killed mid-rebuild on every boot and sat in a restart
 * loop; production served 502s until an index was added. The build code was
 * never the problem — the query plan was.
 *
 * A unit test on buildInt8IndexFromDb cannot catch this: with a handful of test
 * rows a TEMP B-TREE is instant and correct. Only the plan reveals it, so the
 * plan is what this test asserts.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createSchema } from "../../../pipeline/src/db/schema.ts";

function planFor(db: Database, sql: string): string {
	const rows = db
		.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
		.all();
	return rows.map((r) => r.detail).join(" | ");
}

describe("int8 rebuild query plan", () => {
	const REBUILD_SQL =
		"SELECT norm_id, block_id, vector FROM embeddings WHERE model = 'qwen3-nan' ORDER BY norm_id, block_id";

	test("the rebuild scan never sorts through a temp b-tree", () => {
		const db = new Database(":memory:");
		createSchema(db);

		const plan = planFor(db, REBUILD_SQL);

		// The failure mode, stated the way SQLite states it.
		expect(plan).not.toInclude("TEMP B-TREE");
		expect(plan).toInclude("idx_embeddings_model_order");
	});

	test("the index stays usable when the filter is a bound parameter", () => {
		// The production call site binds the model instead of inlining it, and
		// a bound parameter is exactly where a planner can pick differently.
		const db = new Database(":memory:");
		createSchema(db);

		const plan = planFor(
			db,
			"SELECT norm_id, block_id, vector FROM embeddings WHERE model = ? ORDER BY norm_id, block_id",
		);

		expect(plan).not.toInclude("TEMP B-TREE");
	});
});
