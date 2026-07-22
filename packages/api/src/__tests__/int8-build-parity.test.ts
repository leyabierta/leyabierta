/**
 * Byte-equality parity between the two int8 index producers:
 *
 *   1. The offline reference `quantizeVectorsFile` (float32 vectors.bin → int8),
 *      which the production int8 index was originally built with.
 *   2. `buildInt8IndexFromDb`, the in-app path that quantizes straight from the
 *      SQLite `embeddings` table with no intermediate 8 GB float32 file.
 *
 * Given the same vectors in the same order, both must emit byte-identical
 * `vectors-int8.bin` and `vectors-int8.norms.bin`. This pins the DB path to the
 * proven encoding so a future refactor of either can't silently drift.
 */

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The reference quantizer lives (deliberately) in research/archive — it is the
// frozen, proven offline encoder that the production int8 index was first built
// with. Keeping it there, and importing it here, is what makes this an
// *independent* parity check rather than a tautology against shared code. If
// the archive is ever reorganized, update this path.
import { quantizeVectorsFile } from "../../research/archive/2026-05/experiments/quantize-vectors.ts";
import { buildInt8IndexFromDb } from "../services/rag/embeddings.ts";

const DIMS = 64;
const MODEL = "parity-model";

// Deterministic LCG so the fixture is stable across runs.
function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0xffffffff;
	};
}

const tmpDirs: string[] = [];
afterAll(async () => {
	for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

test("buildInt8IndexFromDb matches quantizeVectorsFile byte-for-byte", async () => {
	const dir = await mkdtemp(join(tmpdir(), "int8-parity-"));
	tmpDirs.push(dir);

	// Build a fixture of float32 vectors with varied magnitudes, plus one
	// all-zero vector to exercise the scale === 0 branch in both encoders.
	const rng = makeRng(42);
	const N = 40;
	const vectors: Float32Array[] = [];
	for (let i = 0; i < N; i++) {
		const v = new Float32Array(DIMS);
		if (i !== 7) {
			const scale = 0.01 + rng() * 5; // vary absMax across vectors
			for (let j = 0; j < DIMS; j++) v[j] = (rng() * 2 - 1) * scale;
		}
		vectors.push(v);
	}

	// Insert into an on-disk SQLite DB (matches production schema shape).
	const dbPath = join(dir, "test.db");
	const db = new Database(dbPath);
	db.run(
		"CREATE TABLE embeddings (norm_id TEXT, block_id TEXT, model TEXT, vector BLOB)",
	);
	const insert = db.query(
		"INSERT INTO embeddings (norm_id, block_id, model, vector) VALUES (?, ?, ?, ?)",
	);
	for (let i = 0; i < N; i++) {
		// Zero-padded ids so lexical ORDER BY matches insertion order.
		const normId = `NORM-${String(Math.floor(i / 4)).padStart(3, "0")}`;
		const blockId = `art-${String(i).padStart(4, "0")}`;
		const buf = Buffer.from(
			vectors[i]!.buffer,
			vectors[i]!.byteOffset,
			DIMS * 4,
		);
		insert.run(normId, blockId, MODEL, buf);
	}

	// Reference: write vectors.bin in the *same* canonical order the DB builder
	// iterates (ORDER BY norm_id, block_id), then quantize offline.
	const rows = db
		.query<{ vector: Buffer }, [string]>(
			"SELECT vector FROM embeddings WHERE model = ? ORDER BY norm_id, block_id",
		)
		.all(MODEL);
	const f32Path = join(dir, "vectors.bin");
	const w = Bun.file(f32Path).writer();
	for (const r of rows) {
		w.write(new Uint8Array(r.vector.buffer, r.vector.byteOffset, DIMS * 4));
	}
	await w.end();

	const refInt8 = join(dir, "ref-int8.bin");
	await quantizeVectorsFile({
		inPath: f32Path,
		outPath: refInt8,
		dims: DIMS,
	});
	const refNorms = join(dir, "ref-int8.norms.bin");

	// DB path.
	const dbInt8 = join(dir, "db-int8.bin");
	const dbNorms = join(dir, "db-int8.norms.bin");
	const dbMeta = join(dir, "db.meta.jsonl");
	const { meta, exported } = await buildInt8IndexFromDb(
		db,
		MODEL,
		DIMS,
		dbInt8,
		dbNorms,
		dbMeta,
	);
	db.close();

	expect(exported).toBe(N);
	expect(meta.length).toBe(N);

	// Byte-for-byte equality of both artifacts.
	const [refBin, gotBin] = await Promise.all([
		readFile(refInt8),
		readFile(dbInt8),
	]);
	expect(gotBin.byteLength).toBe(refBin.byteLength);
	expect(Buffer.compare(gotBin, refBin)).toBe(0);

	const [refN, gotN] = await Promise.all([
		readFile(refNorms),
		readFile(dbNorms),
	]);
	expect(gotN.byteLength).toBe(refN.byteLength);
	expect(Buffer.compare(gotN, refN)).toBe(0);
});
