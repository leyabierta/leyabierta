/**
 * Vector worker pool — owns N Bun Workers that share a single in-memory
 * vector index via SharedArrayBuffer.
 *
 *   main thread                          workers
 *   ┌────────────┐    init (SAB refs)    ┌──────────────┐
 *   │ pool       │ ────────────────────▶ │ vector-worker│  N copies
 *   │  queue     │                       │  + simd.so   │
 *   │  promises  │ ◀─── result(id, k) ── │              │
 *   └────────────┘    query(id, q, K)    └──────────────┘
 *
 * Each query is dispatched round-robin to an idle worker; if all are
 * busy, the request is queued (FIFO) up to MAX_PENDING. Beyond that we
 * reject so the API layer can return 503 Busy instead of memory-bombing
 * under sustained load.
 *
 * Memory: vectors.bin (~5.6 GB) lives once in SABs allocated by the
 * pool's create() and viewed read-only by every worker. Per-worker
 * heap is small (the .so handle, the message buffers, no JS-side
 * vector storage).
 */

import { join } from "node:path";
import type { InMemoryVectorIndex, VectorSearchResult } from "./embeddings.ts";

interface PoolConfig {
	workerCount: number;
	libPath: string;
	dbPath: string;
	maxPending: number;
}

type VectorJob = {
	type: "vector";
	id: number;
	query: Float32Array;
	topK: number;
};
type Bm25Job = {
	type: "bm25";
	id: number;
	originalQuery: string;
	expandedKeywords: string[];
	topK: number;
	normFilter?: string[];
};
type JobMessage = VectorJob | Bm25Job;

interface Pending {
	// biome-ignore lint/suspicious/noExplicitAny: pool is type-erased at the boundary
	resolve: (r: any) => void;
	reject: (e: Error) => void;
	message: JobMessage;
}

interface SharedIndex {
	kind: "f32" | "int8";
	sharedChunks: SharedArrayBuffer[];
	sharedNorms: SharedArrayBuffer[];
	/** Only set when kind === "int8". One scale SAB per chunk. */
	sharedScales: SharedArrayBuffer[];
	vectorsPerChunk: number[];
	dim: number;
	totalVectors: number;
}

/**
 * Singleton state. We track the in-flight init promise separately so two
 * concurrent callers race to neither create two pools nor see a half-built
 * one. If init rejects we clear `initPromise` so the next caller retries
 * (vs. permanently caching the failed instance).
 */
let pool: VectorPool | null = null;
let initPromise: Promise<VectorPool | null> | null = null;

class VectorPool {
	private workers: Worker[] = [];
	private idle: Worker[] = [];
	private workerReady = new Set<Worker>();
	private pending = new Map<number, Pending>();
	private queue: number[] = [];
	private nextId = 1;
	private readonly maxPending: number;
	private initPromise: Promise<void>;

	constructor(
		private readonly shared: SharedIndex,
		config: PoolConfig,
	) {
		this.maxPending = config.maxPending;
		const workerUrl = new URL("./vector-worker.ts", import.meta.url);

		const readyPromises: Promise<void>[] = [];
		for (let i = 0; i < config.workerCount; i++) {
			const w = new Worker(workerUrl);
			this.workers.push(w);

			const ready = new Promise<void>((resolve, reject) => {
				const onMsg = (e: MessageEvent) => {
					const msg = e.data;
					if (msg?.type === "ready") {
						this.workerReady.add(w);
						this.idle.push(w);
						w.removeEventListener("message", onMsg);
						w.addEventListener("message", (ev) => this.onWorkerMessage(w, ev));
						resolve();
					} else if (msg?.type === "error") {
						reject(new Error(msg.message));
					}
				};
				w.addEventListener("message", onMsg);
				w.addEventListener("error", (e) => reject(new Error(String(e))));
			});
			readyPromises.push(ready);

			w.postMessage({
				type: "init",
				kind: this.shared.kind,
				sharedChunks: this.shared.sharedChunks,
				sharedNorms: this.shared.sharedNorms,
				sharedScales: this.shared.sharedScales,
				vectorsPerChunk: this.shared.vectorsPerChunk,
				dim: this.shared.dim,
				libPath: config.libPath,
				dbPath: config.dbPath,
			});
		}

		this.initPromise = Promise.all(readyPromises).then(() => {
			console.log(
				`[vector-pool] ${this.workers.length} workers ready (shared index: ${this.shared.totalVectors} vectors, ${this.shared.sharedChunks.length} chunks)`,
			);
		});
	}

	async ready(): Promise<void> {
		await this.initPromise;
	}

	private onWorkerMessage(worker: Worker, event: MessageEvent) {
		const msg = event.data;
		if (msg?.type === "result") {
			const p = this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				p.resolve(msg.results);
			}
		} else if (msg?.type === "error") {
			const p = this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				p.reject(new Error(msg.message ?? "worker error"));
			}
		}
		// Worker is now idle; pick up the next queued job if any.
		this.idle.push(worker);
		this.drain();
	}

	private drain() {
		while (this.idle.length > 0 && this.queue.length > 0) {
			const id = this.queue.shift()!;
			const p = this.pending.get(id);
			if (!p) continue;
			const w = this.idle.shift()!;
			w.postMessage(p.message);
		}
	}

	private enqueue<T>(buildMessage: (id: number) => JobMessage): Promise<T> {
		if (this.pending.size >= this.maxPending) {
			return Promise.reject(new Error("VECTOR_POOL_BUSY"));
		}
		const id = this.nextId++;
		const message = buildMessage(id);
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: resolve as Pending["resolve"],
				reject,
				message,
			});
			this.queue.push(id);
			this.drain();
		});
	}

	search(
		query: Float32Array,
		topK: number,
	): Promise<Array<{ globalIdx: number; score: number }>> {
		return this.enqueue((id) => ({ type: "vector", id, query, topK }));
	}

	bm25(
		originalQuery: string,
		expandedKeywords: string[],
		topK: number,
		normFilter?: string[],
	): Promise<Array<{ normId: string; blockId: string; rank: number }>> {
		return this.enqueue((id) => ({
			type: "bm25",
			id,
			originalQuery,
			expandedKeywords,
			topK,
			normFilter,
		}));
	}

	terminate() {
		for (const w of this.workers) w.terminate();
		this.workers = [];
		this.idle = [];
		this.workerReady.clear();
		for (const p of this.pending.values())
			p.reject(new Error("pool terminated"));
		this.pending.clear();
		this.queue = [];
	}
}

/**
 * Build a SharedArrayBuffer-backed view of an existing in-memory vector
 * index by *copying* each chunk into a SAB. We accept the one-time copy
 * cost (~5.6 GB) at boot; afterwards the SAB is the source of truth and
 * the original ArrayBuffer is dropped.
 *
 * If we ever rebuild loadVectorsToMemory() to allocate SABs directly,
 * this copy disappears.
 */
function toShared(index: InMemoryVectorIndex): SharedIndex {
	const sharedChunks: SharedArrayBuffer[] = [];
	const sharedNorms: SharedArrayBuffer[] = [];
	const sharedScales: SharedArrayBuffer[] = [];
	const isInt8 = index.kind === "int8";
	const numChunks = isInt8 ? index.int8Chunks.length : index.chunks.length;

	for (let c = 0; c < numChunks; c++) {
		// Vector chunk (f32 → Float32Array, int8 → Int8Array). In both
		// cases the loader already allocates SAB-backed buffers, so the
		// hot path is a zero-copy SAB pass-through.
		if (isInt8) {
			const v = index.int8Chunks[c]!;
			if (v.buffer instanceof SharedArrayBuffer) {
				sharedChunks.push(v.buffer);
			} else {
				const sab = new SharedArrayBuffer(v.byteLength);
				new Int8Array(sab).set(v);
				sharedChunks.push(sab);
			}
			const sc = index.scalesPerChunk[c]!;
			if (sc.buffer instanceof SharedArrayBuffer) {
				sharedScales.push(sc.buffer);
			} else {
				const sab = new SharedArrayBuffer(sc.byteLength);
				new Float32Array(sab).set(sc);
				sharedScales.push(sab);
			}
		} else {
			const v = index.chunks[c]!;
			if (v.buffer instanceof SharedArrayBuffer) {
				sharedChunks.push(v.buffer);
			} else {
				const sab = new SharedArrayBuffer(v.byteLength);
				new Float32Array(sab).set(v);
				sharedChunks.push(sab);
			}
		}

		const n = index.normsPerChunk[c]!;
		if (n.buffer instanceof SharedArrayBuffer) {
			sharedNorms.push(n.buffer);
		} else {
			const sabN = new SharedArrayBuffer(n.byteLength);
			new Float32Array(sabN).set(n);
			sharedNorms.push(sabN);
		}
	}
	return {
		kind: index.kind,
		sharedChunks,
		sharedNorms,
		sharedScales,
		vectorsPerChunk: [...index.vectorsPerChunk],
		dim: index.dim,
		totalVectors: index.totalVectors,
	};
}

/**
 * Look up the platform-specific shared library path next to this file.
 */
function defaultLibPath(): string | null {
	const platform = process.platform;
	const arch = process.arch;
	if (platform === "linux" && arch === "x64") {
		return join(import.meta.dir, "vector-simd.linux-amd64.so");
	}
	if (platform === "darwin" && arch === "arm64") {
		return join(import.meta.dir, "vector-simd.darwin-arm64.dylib");
	}
	if (platform === "darwin" && arch === "x64") {
		return join(import.meta.dir, "vector-simd.darwin-amd64.dylib");
	}
	return null;
}

/**
 * Lazily build the singleton pool. Returns null if pool cannot be
 * created (unsupported platform, missing .so) — callers should fall
 * back to the synchronous in-process path.
 *
 * Concurrent callers share the same `initPromise` (no double-init,
 * no leaked workers). If the first init rejects, `initPromise` is
 * cleared so a later call gets to try again.
 *
 * NOTE: `options` is only honoured on the first call that triggers
 * init. Later calls receive the existing singleton regardless of the
 * options they pass — the pool is not reconfigurable at runtime.
 */
export async function getVectorPool(
	index: InMemoryVectorIndex,
): Promise<VectorPool | null> {
	if (pool) return pool;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		const libPath = defaultLibPath();
		if (!libPath) return null;

		const dim = index.dim;
		if (!dim) return null;

		// Sizing read at init time — the pool is a process-wide singleton
		// so accepting per-call options would silently no-op for everyone
		// after the first caller. Override via env vars below.
		const workerCount = Number(process.env.RAG_VECTOR_POOL_WORKERS ?? "4");
		const maxPending = Number(process.env.RAG_VECTOR_POOL_MAX_PENDING ?? "20");
		const dbPath = process.env.DB_PATH ?? "./data/leyabierta.db";

		const shared = toShared(index);
		const candidate = new VectorPool(shared, {
			workerCount,
			libPath,
			dbPath,
			maxPending,
		});
		try {
			await candidate.ready();
		} catch (err) {
			candidate.terminate();
			throw err;
		}
		pool = candidate;
		return pool;
	})();

	try {
		return await initPromise;
	} catch (err) {
		// Clear so the next caller can retry (e.g. .so was missing at boot
		// but now exists after a reload).
		initPromise = null;
		throw err;
	}
}

export async function vectorSearchPooled(
	queryEmbedding: Float32Array,
	meta: Array<{ normId: string; blockId: string }>,
	index: InMemoryVectorIndex,
	_dims: number,
	topK: number = 10,
): Promise<VectorSearchResult[]> {
	const p = await getVectorPool(index);
	if (!p) {
		throw new Error("vector pool unavailable on this platform");
	}
	const t0 = performance.now();
	const raw = await p.search(queryEmbedding, topK);
	const totalMs = performance.now() - t0;
	console.log(
		`[vector-search-pool] ${index.totalVectors} vectors → top-${raw.length} in ${totalMs.toFixed(0)}ms`,
	);
	return raw.slice(0, topK).map((r) => {
		const article = meta[r.globalIdx]!;
		return {
			normId: article.normId,
			blockId: article.blockId,
			score: r.score,
		};
	});
}

/**
 * BM25 article search via the same worker pool used for vector search.
 *
 * The five BM25 systems in the retrieval pipeline (main, synonym,
 * namedLaw, coreLaw, recent) are independent in data, so dispatching
 * them to the pool concurrently turns sequential sum-of-stages into
 * parallel max-of-stages — that's the whole Sprint 2 P0 win.
 *
 * Each worker owns its own SQLite readonly handle, so contention is
 * limited to whatever the SQLite WAL gives us (concurrent reads OK).
 */
export async function bm25SearchPooled(
	index: InMemoryVectorIndex,
	originalQuery: string,
	expandedKeywords: string[],
	topK: number,
	normFilter?: string[],
): Promise<Array<{ normId: string; blockId: string; rank: number }>> {
	const p = await getVectorPool(index);
	if (!p) {
		throw new Error("vector pool unavailable on this platform");
	}
	return p.bm25(originalQuery, expandedKeywords, topK, normFilter);
}

export function shutdownVectorPool() {
	pool?.terminate();
	pool = null;
	initPromise = null;
}

export type { VectorPool };
