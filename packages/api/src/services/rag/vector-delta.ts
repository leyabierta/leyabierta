/**
 * Vector "delta": embeddings written to SQLite after the in-memory index was
 * loaded.
 *
 * The int8 index (`vectors-int8.bin`) is loaded once per process and only
 * rebuilt by the nightly pipeline, which then restarts the API. Laws embedded
 * in between (an extra pipeline run, a same-day publication) would stay
 * invisible to vector search until that restart. Instead, when the shared
 * index loads we remember the highest `embeddings.rowid`; every rowid above it
 * is new (INSERT OR REPLACE also assigns a fresh rowid, so re-embedded
 * articles show up too). Those rows are read incrementally, kept as float32
 * and searched brute force next to the pooled index — a day of new law is a
 * few thousand vectors, a few ms per query.
 */
import type { Database } from "bun:sqlite";
import type { VectorSearchResult } from "./embeddings.ts";

/** How often a query may re-read SQLite for new embeddings. */
const REFRESH_INTERVAL_MS = 60_000;
/** ~330 MB of float32 at 4096 dims. The nightly rebuild resets the delta. */
const MAX_DELTA_VECTORS = 20_000;

interface DeltaState {
	modelKey: string;
	dims: number;
	baseRowid: number;
	lastRowid: number;
	lastRefresh: number;
	keys: Array<{ normId: string; blockId: string }>;
	vectors: Float32Array[];
	norms: Float32Array;
	normIds: Set<string>;
	capped: boolean;
}

let state: DeltaState | null = null;
const indexBase = new WeakMap<object, number>();

export function maxEmbeddingRowid(db: Database): number | null {
	try {
		const row = db
			.query<{ m: number | null }, []>("SELECT max(rowid) AS m FROM embeddings")
			.get();
		return row?.m ?? 0;
	} catch {
		return null;
	}
}

/**
 * Called by the shared index singleton once the index is loaded. `baseRowid`
 * must be read before the load starts: rows written during the load may end
 * up both in the index and in the delta, which the merge dedupes.
 */
export function registerVectorIndexBase(
	index: object,
	modelKey: string,
	dims: number,
	baseRowid: number,
): void {
	indexBase.set(index, baseRowid);
	state = {
		modelKey,
		dims,
		baseRowid,
		lastRowid: baseRowid,
		lastRefresh: 0,
		keys: [],
		vectors: [],
		norms: new Float32Array(0),
		normIds: new Set(),
		capped: false,
	};
}

/** Pull embeddings written since the last refresh (at most once a minute). */
export function refreshVectorDelta(db: Database, now = Date.now()): void {
	const s = state;
	if (!s || s.capped || now - s.lastRefresh < REFRESH_INTERVAL_MS) return;
	s.lastRefresh = now;
	let rows: Array<{
		rowid: number;
		norm_id: string;
		block_id: string;
		vector: Uint8Array;
	}>;
	try {
		rows = db
			.query<
				{
					rowid: number;
					norm_id: string;
					block_id: string;
					vector: Uint8Array;
				},
				[number, string, number]
			>(
				`SELECT rowid, norm_id, block_id, vector FROM embeddings
				 WHERE rowid > ? AND model = ? ORDER BY rowid LIMIT ?`,
			)
			.all(s.lastRowid, s.modelKey, MAX_DELTA_VECTORS - s.keys.length + 1);
	} catch (err) {
		console.warn(
			`[vector-delta] refresh failed: ${err instanceof Error ? err.message : err}`,
		);
		return;
	}
	if (rows.length === 0) return;

	const room = MAX_DELTA_VECTORS - s.keys.length;
	if (rows.length > room) {
		rows = rows.slice(0, room);
		s.capped = true;
		console.warn(
			`[vector-delta] ${MAX_DELTA_VECTORS} new vectors since the index was loaded — delta full until the next index rebuild`,
		);
	}

	const newNorms: number[] = [];
	for (const row of rows) {
		if (row.vector.byteLength !== s.dims * 4) continue;
		// Copy: the row buffer is not guaranteed 4-byte aligned or long-lived.
		const vec = new Float32Array(
			row.vector.buffer.slice(
				row.vector.byteOffset,
				row.vector.byteOffset + row.vector.byteLength,
			),
		);
		let sq = 0;
		for (let i = 0; i < vec.length; i++) sq += vec[i]! * vec[i]!;
		s.keys.push({ normId: row.norm_id, blockId: row.block_id });
		s.vectors.push(vec);
		newNorms.push(Math.sqrt(sq));
		s.normIds.add(row.norm_id);
	}
	const norms = new Float32Array(s.norms.length + newNorms.length);
	norms.set(s.norms);
	norms.set(newNorms, s.norms.length);
	s.norms = norms;
	s.lastRowid = rows[rows.length - 1]!.rowid;
	console.log(
		`[vector-delta] +${newNorms.length} vectors (${s.keys.length} since index load, ${s.normIds.size} norms)`,
	);
}

/** Norm ids that only the delta knows about (for BM25 scoping). */
export function getDeltaNormIds(): ReadonlySet<string> {
	return state?.normIds ?? new Set();
}

function searchDelta(query: Float32Array, topK: number): VectorSearchResult[] {
	const s = state;
	if (!s || s.keys.length === 0 || query.length !== s.dims) return [];
	let qNorm = 0;
	for (let i = 0; i < query.length; i++) qNorm += query[i]! * query[i]!;
	qNorm = Math.sqrt(qNorm);
	if (qNorm === 0) return [];
	const scored: VectorSearchResult[] = [];
	for (let k = 0; k < s.keys.length; k++) {
		const docNorm = s.norms[k]!;
		if (docNorm === 0) continue;
		const vec = s.vectors[k]!;
		let dot = 0;
		for (let i = 0; i < vec.length; i++) dot += query[i]! * vec[i]!;
		const key = s.keys[k]!;
		scored.push({
			normId: key.normId,
			blockId: key.blockId,
			score: dot / (qNorm * docNorm),
		});
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topK);
}

/**
 * Merge pooled-index hits with delta hits. A delta vector is newer than any
 * copy of the same article in the index (re-embedded after a reform), so it
 * wins; otherwise results are ordered by score.
 */
export function mergeVectorResults(
	main: VectorSearchResult[],
	delta: VectorSearchResult[],
	topK: number,
): VectorSearchResult[] {
	if (delta.length === 0) return main;
	const byKey = new Map<string, VectorSearchResult>();
	for (const r of main) byKey.set(`${r.normId}:${r.blockId}`, r);
	for (const r of delta) byKey.set(`${r.normId}:${r.blockId}`, r);
	return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

/**
 * Wrap a search over the shared index with the delta. Indexes that did not
 * come from the shared singleton (eval harnesses) are searched as is.
 */
export async function withVectorDelta(
	db: Database,
	index: object,
	query: Float32Array,
	topK: number,
	search: () => Promise<VectorSearchResult[]>,
): Promise<VectorSearchResult[]> {
	if (!state || indexBase.get(index) !== state.baseRowid) return search();
	refreshVectorDelta(db);
	const main = await search();
	return mergeVectorResults(main, searchDelta(query, topK), topK);
}

/** Test-only. */
export function _resetVectorDeltaForTests(): void {
	state = null;
}
