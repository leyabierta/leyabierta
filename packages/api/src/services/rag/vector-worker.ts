/**
 * RAG worker — runs the two CPU-bound stages on behalf of the main thread:
 *
 *   1. SIMD cosine top-K over the shared vector index (5.6 GB SAB).
 *   2. BM25 article search via SQLite FTS5 against a readonly DB handle.
 *
 * Spawned by `vector-pool.ts` via `new Worker(new URL("./vector-worker.ts",
 * import.meta.url))`. Receives one `init` message at boot with the SAB
 * refs, the .so path and the SQLite path; opens its own DB handle in
 * readonly mode (SQLite WAL supports concurrent readers without lock
 * contention). Then any number of `vector` or `bm25` messages, each
 * tagged with an id; replies as `{ type: 'result' | 'error', id, ... }`.
 *
 * Memory: the SharedArrayBuffer is referenced (not copied) into the
 * worker's address space. With N workers all viewing the same SABs, the
 * physical RAM cost stays at the single 5.6 GB index. Each worker holds
 * its own SQLite statement cache (small).
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { Database } from "bun:sqlite";
import { bm25HybridSearch, ensureBlocksFts } from "./blocks-fts.ts";

declare const self: {
	postMessage: (message: unknown) => void;
	onmessage: ((event: MessageEvent) => void) | null;
};

interface InitMessage {
	type: "init";
	sharedChunks: SharedArrayBuffer[];
	sharedNorms: SharedArrayBuffer[];
	vectorsPerChunk: number[];
	dim: number;
	libPath: string;
	dbPath: string;
}

interface VectorQueryMessage {
	type: "vector";
	id: number;
	query: Float32Array;
	topK: number;
}

interface Bm25QueryMessage {
	type: "bm25";
	id: number;
	originalQuery: string;
	expandedKeywords: string[];
	topK: number;
	normFilter?: string[];
}

type InMessage = InitMessage | VectorQueryMessage | Bm25QueryMessage;

// biome-ignore lint/suspicious/noExplicitAny: bun:ffi symbol types are dynamic.
type CosineTopk = (...args: any[]) => number;

interface State {
	chunks: Float32Array[];
	norms: Float32Array[];
	vpc: number[];
	dim: number;
	cosine_topk: CosineTopk;
	db: Database;
}

let state: State | null = null;

self.onmessage = (event: MessageEvent) => {
	const msg = event.data as InMessage;

	if (msg.type === "init") {
		// Init failures (missing .so, wrong ABI, SAB constructor surprises)
		// must reach the pool as an `error` message — otherwise the pool's
		// `ready` promise would never settle and the worker slot would leak.
		try {
			const chunks = msg.sharedChunks.map((sab) => new Float32Array(sab));
			const norms = msg.sharedNorms.map((sab) => new Float32Array(sab));
			const lib = dlopen(msg.libPath, {
				cosine_topk: {
					args: [
						FFIType.ptr,
						FFIType.f32,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.i32,
						FFIType.i32,
						FFIType.i32,
						FFIType.ptr,
						FFIType.ptr,
					],
					returns: FFIType.i32,
				},
			});
			// SQLite WAL supports concurrent readers — every worker opens its
			// own readonly handle so each has an independent statement cache.
			const db = new Database(msg.dbPath, { readonly: true });
			ensureBlocksFts(db); // no-op when already populated
			state = {
				chunks,
				norms,
				vpc: msg.vectorsPerChunk,
				dim: msg.dim,
				cosine_topk: lib.symbols.cosine_topk as unknown as CosineTopk,
				db,
			};
			self.postMessage({ type: "ready" });
		} catch (err) {
			self.postMessage({
				type: "error",
				message: `worker init failed: ${(err as Error).message}`,
			});
		}
		return;
	}

	if (msg.type === "vector") {
		if (!state) {
			self.postMessage({
				type: "error",
				id: msg.id,
				message: "not initialized",
			});
			return;
		}

		// Any throw inside the SIMD path or its prologue must come back as
		// an `error` reply tagged with the request id. Otherwise the
		// pending Promise on the main thread hangs forever and the pool
		// permanently loses one worker slot.
		try {
			// Precompute query norm.
			let qNorm = 0;
			const q = msg.query;
			for (let i = 0; i < state.dim; i++) qNorm += q[i]! * q[i]!;
			qNorm = Math.sqrt(qNorm);

			const merged: Array<{ globalIdx: number; score: number }> = [];
			let globalOffset = 0;

			for (let c = 0; c < state.chunks.length; c++) {
				const vectors = state.chunks[c]!;
				const norms = state.norms[c]!;
				const numVecs = state.vpc[c]!;
				if (numVecs === 0) continue;

				const k = Math.min(msg.topK, numVecs);
				const outIndices = new Int32Array(k);
				const outScores = new Float32Array(k);

				const written = state.cosine_topk(
					ptr(q),
					qNorm,
					ptr(vectors),
					ptr(norms),
					numVecs,
					state.dim,
					k,
					ptr(outIndices),
					ptr(outScores),
				);

				for (let i = 0; i < written; i++) {
					merged.push({
						globalIdx: globalOffset + outIndices[i]!,
						score: outScores[i]!,
					});
				}
				globalOffset += numVecs;
			}

			merged.sort((a, b) => b.score - a.score);
			const top = merged.slice(0, msg.topK);
			self.postMessage({ type: "result", id: msg.id, results: top });
		} catch (err) {
			self.postMessage({
				type: "error",
				id: msg.id,
				message: `vector query failed: ${(err as Error).message}`,
			});
		}
		return;
	}

	if (msg.type === "bm25") {
		if (!state) {
			self.postMessage({
				type: "error",
				id: msg.id,
				message: "not initialized",
			});
			return;
		}
		try {
			const results = bm25HybridSearch(
				state.db,
				msg.originalQuery,
				msg.expandedKeywords,
				msg.topK,
				msg.normFilter,
			);
			self.postMessage({ type: "result", id: msg.id, results });
		} catch (err) {
			self.postMessage({
				type: "error",
				id: msg.id,
				message: `bm25 query failed: ${(err as Error).message}`,
			});
		}
	}
};
