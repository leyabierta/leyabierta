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
	maxPending: number;
}

interface Pending {
	resolve: (r: Array<{ globalIdx: number; score: number }>) => void;
	reject: (e: Error) => void;
	query: Float32Array;
	topK: number;
}

interface SharedIndex {
	sharedChunks: SharedArrayBuffer[];
	sharedNorms: SharedArrayBuffer[];
	vectorsPerChunk: number[];
	dim: number;
	totalVectors: number;
}

let pool: VectorPool | null = null;

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
				sharedChunks: this.shared.sharedChunks,
				sharedNorms: this.shared.sharedNorms,
				vectorsPerChunk: this.shared.vectorsPerChunk,
				dim: this.shared.dim,
				libPath: config.libPath,
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
			w.postMessage({
				type: "query",
				id,
				query: p.query,
				topK: p.topK,
			});
		}
	}

	search(
		query: Float32Array,
		topK: number,
	): Promise<Array<{ globalIdx: number; score: number }>> {
		if (this.pending.size >= this.maxPending) {
			return Promise.reject(new Error("VECTOR_POOL_BUSY"));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, query, topK });
			this.queue.push(id);
			this.drain();
		});
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
	for (let c = 0; c < index.chunks.length; c++) {
		const v = index.chunks[c]!;
		const sab = new SharedArrayBuffer(v.byteLength);
		new Float32Array(sab).set(v);
		sharedChunks.push(sab);

		const n = index.normsPerChunk[c]!;
		const sabN = new SharedArrayBuffer(n.byteLength);
		new Float32Array(sabN).set(n);
		sharedNorms.push(sabN);
	}
	return {
		sharedChunks,
		sharedNorms,
		vectorsPerChunk: [...index.vectorsPerChunk],
		dim: index.chunks[0]
			? index.chunks[0].length / index.vectorsPerChunk[0]!
			: 0,
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
 */
export async function getVectorPool(
	index: InMemoryVectorIndex,
	options: { workerCount?: number; maxPending?: number } = {},
): Promise<VectorPool | null> {
	if (pool) return pool;
	const libPath = defaultLibPath();
	if (!libPath) return null;

	const dim = index.chunks[0]
		? index.chunks[0].length / index.vectorsPerChunk[0]!
		: 0;
	if (!dim) return null;

	const shared = toShared(index);
	pool = new VectorPool(shared, {
		workerCount: options.workerCount ?? 4,
		libPath,
		maxPending: options.maxPending ?? 20,
	});
	await pool.ready();
	return pool;
}

export async function vectorSearchPooled(
	queryEmbedding: Float32Array,
	meta: Array<{ normId: string; blockId: string }>,
	index: InMemoryVectorIndex,
	dims: number,
	topK: number = 10,
	options: { workerCount?: number; maxPending?: number } = {},
): Promise<VectorSearchResult[]> {
	const p = await getVectorPool(index, options);
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

export function shutdownVectorPool() {
	pool?.terminate();
	pool = null;
}

export type { VectorPool };
