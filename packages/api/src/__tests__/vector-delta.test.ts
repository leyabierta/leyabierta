import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	_resetVectorDeltaForTests,
	getDeltaNormIds,
	maxEmbeddingRowid,
	mergeVectorResults,
	refreshVectorDelta,
	registerVectorIndexBase,
	withVectorDelta,
} from "../services/rag/vector-delta.ts";
import {
	_resetSharedVectorIndexForTests,
	getSharedVectorIndex,
} from "../services/rag/vector-index-singleton.ts";

const DIMS = 4;
const MODEL = "qwen3-nan";

let db: Database;

function insert(normId: string, blockId: string, vec: number[], model = MODEL) {
	db.run(
		"INSERT OR REPLACE INTO embeddings (norm_id, block_id, model, vector) VALUES (?, ?, ?, ?)",
		[normId, blockId, model, new Uint8Array(new Float32Array(vec).buffer)],
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	db.run(`CREATE TABLE embeddings (
		norm_id TEXT NOT NULL, block_id TEXT NOT NULL, model TEXT NOT NULL,
		vector BLOB NOT NULL, PRIMARY KEY (norm_id, block_id, model))`);
	_resetVectorDeltaForTests();
	_resetSharedVectorIndexForTests();
});

afterEach(() => db.close());

const indexed = [{ normId: "OLD", blockId: "a1", score: 0.5 }];
const mainSearch = async () => indexed;

describe("vector delta", () => {
	it("finds embeddings written after the index was loaded", async () => {
		insert("OLD", "a1", [1, 0, 0, 0]);
		const index = {};
		registerVectorIndexBase(index, MODEL, DIMS, maxEmbeddingRowid(db) ?? 0);

		insert("NEW", "a1", [0, 1, 0, 0]);
		insert("OTHER-MODEL", "a1", [0, 1, 0, 0], "gemini");

		const results = await withVectorDelta(
			db,
			index,
			new Float32Array([0, 1, 0, 0]),
			10,
			mainSearch,
		);
		expect(results[0]).toEqual({ normId: "NEW", blockId: "a1", score: 1 });
		expect(results.map((r) => r.normId)).toEqual(["NEW", "OLD"]);
		expect([...getDeltaNormIds()]).toEqual(["NEW"]);
	});

	it("reads SQLite at most once per interval", () => {
		registerVectorIndexBase({}, MODEL, DIMS, 0);
		refreshVectorDelta(db, 1_000_000);
		insert("NEW", "a1", [0, 1, 0, 0]);
		refreshVectorDelta(db, 1_000_000 + 30_000);
		expect(getDeltaNormIds().size).toBe(0);
		refreshVectorDelta(db, 1_000_000 + 61_000);
		expect([...getDeltaNormIds()]).toEqual(["NEW"]);
	});

	it("does not touch indexes that were not registered (eval harnesses)", async () => {
		registerVectorIndexBase({}, MODEL, DIMS, 0);
		insert("NEW", "a1", [0, 1, 0, 0]);
		const results = await withVectorDelta(
			db,
			{},
			new Float32Array([0, 1, 0, 0]),
			10,
			mainSearch,
		);
		expect(results).toBe(indexed);
	});

	it("a re-embedded article replaces its stale copy from the index", () => {
		const merged = mergeVectorResults(
			[
				{ normId: "L", blockId: "a1", score: 0.9 },
				{ normId: "L", blockId: "a2", score: 0.4 },
			],
			[{ normId: "L", blockId: "a1", score: 0.3 }],
			10,
		);
		expect(merged).toEqual([
			{ normId: "L", blockId: "a2", score: 0.4 },
			{ normId: "L", blockId: "a1", score: 0.3 },
		]);
	});

	it("the shared singleton registers the rowid read before loading", async () => {
		insert("OLD", "a1", [1, 0, 0, 0]);
		const fakeIndex = { meta: [], vectors: {} as never, dims: DIMS };
		const idx = await getSharedVectorIndex(db, MODEL, "./data", async () => {
			// Written while the index loads: may be in both; must not be lost.
			insert("DURING", "a1", [0, 0, 1, 0]);
			return fakeIndex;
		});
		expect(idx).toBe(fakeIndex);
		const results = await withVectorDelta(
			db,
			fakeIndex,
			new Float32Array([0, 0, 1, 0]),
			10,
			async () => [],
		);
		expect(results.map((r) => r.normId)).toEqual(["DURING"]);
	});
});
