/**
 * Embedding generation and vector search for RAG.
 *
 * Generates embeddings via OpenRouter API and stores them as a binary file.
 * Supports brute-force cosine similarity search (sufficient for ~13K articles).
 */

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const BATCH_SIZE = 50; // articles per API call
const BACKOFF_MS = 1000;

export interface EmbeddingModel {
	id: string;
	dimensions: number;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModel> = {
	"openai-small": {
		id: "openai/text-embedding-3-small",
		dimensions: 1536,
	},
	"openai-large": {
		id: "openai/text-embedding-3-large",
		dimensions: 3072,
	},
	qwen3: {
		id: "qwen/qwen3-embedding-8b",
		dimensions: 4096,
	},
	"gemini-embedding-2": {
		id: "google/gemini-embedding-2-preview",
		dimensions: 3072,
	},
};

export interface ArticleEmbedding {
	normId: string;
	blockId: string;
	embedding: Float32Array;
}

export interface EmbeddingStore {
	model: string;
	dimensions: number;
	count: number;
	articles: Array<{ normId: string; blockId: string; index?: number }>;
	vectors: Float32Array; // flattened: count × dimensions
	norms: Float32Array; // pre-computed L2 norms per document
}

function computeNorms(
	vectors: Float32Array,
	count: number,
	dims: number,
): Float32Array {
	const norms = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		const offset = i * dims;
		let sum = 0;
		for (let j = 0; j < dims; j++) {
			const v = vectors[offset + j] ?? 0;
			sum += v * v;
		}
		norms[i] = Math.sqrt(sum);
	}
	return norms;
}

// ── Shared fetch with retry ──

export async function fetchWithRetry(
	apiKey: string,
	modelId: string,
	input: string | string[],
): Promise<Response> {
	const maxRetries = 3;
	let attempts = 0;

	while (true) {
		let response: Response;
		try {
			response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://leyabierta.es",
					"X-Title": "Ley Abierta RAG",
				},
				body: JSON.stringify({ model: modelId, input }),
			});

			if (response.status === 429) {
				attempts++;
				if (attempts > maxRetries) {
					throw new Error("Rate limited after max retries");
				}
				const delay = BACKOFF_MS * attempts * 2;
				await new Promise((r) => setTimeout(r, delay));
				continue;
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Embedding API error ${response.status}: ${errorText.slice(0, 200)}`,
				);
			}

			return response;
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("Rate limited"))
				throw err;
			attempts++;
			if (attempts > maxRetries) throw err;
			await new Promise((r) => setTimeout(r, BACKOFF_MS * attempts));
		}
	}
}

// ── Generate embeddings ──

export async function generateEmbeddings(
	apiKey: string,
	modelKey: string,
	articles: Array<{ normId: string; blockId: string; text: string }>,
	onProgress?: (done: number, total: number) => void,
	onCheckpoint?: (data: {
		meta: Array<{ normId: string; blockId: string }>;
		vectors: Float32Array;
		dims: number;
		completedArticles: number;
	}) => Promise<void>,
): Promise<EmbeddingStore> {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) {
		throw new Error(
			`Unknown model: ${modelKey}. Available: ${Object.keys(EMBEDDING_MODELS).join(", ")}`,
		);
	}

	const allEmbeddings: Float32Array[] = [];
	const articleMeta: Array<{ normId: string; blockId: string }> = [];
	const skippedBatches: Array<{ batchIndex: number; articleRange: string }> =
		[];
	let totalCost = 0;
	let totalTokens = 0;

	for (let i = 0; i < articles.length; i += BATCH_SIZE) {
		const batch = articles.slice(i, i + BATCH_SIZE);
		const texts = batch.map((a) => {
			// Gemini Embedding 2 supports 8,192 tokens (~24K chars).
			// Truncate to 24000 chars to stay safely within limit while using
			// most of the available context window (previously 2000 chars / 6%).
			const content = a.text.slice(0, 24000);
			return content;
		});

		// biome-ignore lint/suspicious/noExplicitAny: OpenRouter API response shape
		let data: any = null;
		for (let attempt = 0; attempt < 5; attempt++) {
			if (attempt > 0) {
				const delay = 5000 * attempt;
				console.warn(
					`\n  Batch ${i / BATCH_SIZE + 1}: retry ${attempt}/4 after ${delay / 1000}s...`,
				);
				await new Promise((r) => setTimeout(r, delay));
			}
			const response = await fetchWithRetry(apiKey, model.id, texts);
			data = await response.json();
			if (data.data && Array.isArray(data.data)) break;
			console.warn(
				`\n  Batch ${i / BATCH_SIZE + 1}: API returned no embeddings (${JSON.stringify(data).slice(0, 150)})`,
			);
			data = null;
		}
		if (!data) {
			const range = `${i}-${Math.min(i + BATCH_SIZE, articles.length) - 1}`;
			console.warn(
				`\n  ⚠ Batch ${i / BATCH_SIZE + 1}: SKIPPED after 5 failed attempts (articles ${range})`,
			);
			skippedBatches.push({
				batchIndex: i / BATCH_SIZE + 1,
				articleRange: range,
			});
			continue;
		}

		const usage = data.usage ?? {};
		totalCost += usage.cost ?? 0;
		totalTokens += usage.total_tokens ?? 0;

		for (const item of data.data) {
			const embedding = new Float32Array(item.embedding);
			allEmbeddings.push(embedding);
			const batchItem = batch[item.index]!;
			articleMeta.push({
				normId: batchItem.normId,
				blockId: batchItem.blockId,
			});
		}

		const done = Math.min(i + BATCH_SIZE, articles.length);
		onProgress?.(done, articles.length);

		// Periodic checkpoint
		if (onCheckpoint && done % 1000 < BATCH_SIZE) {
			const dims = allEmbeddings[0]?.length ?? model.dimensions;
			const vectors = new Float32Array(allEmbeddings.length * dims);
			for (let j = 0; j < allEmbeddings.length; j++) {
				vectors.set(allEmbeddings[j]!, j * dims);
			}
			await onCheckpoint({
				meta: articleMeta,
				vectors,
				dims,
				completedArticles: done,
			});
		}

		// Small delay between batches
		if (i + BATCH_SIZE < articles.length) {
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	// Flatten all embeddings into a single Float32Array
	const dims = allEmbeddings[0]?.length ?? model.dimensions;
	const vectors = new Float32Array(allEmbeddings.length * dims);
	for (let i = 0; i < allEmbeddings.length; i++) {
		vectors.set(allEmbeddings[i]!, i * dims);
	}

	console.log(
		`  Embedding stats: ${allEmbeddings.length} articles, ${totalTokens.toLocaleString()} tokens, $${totalCost.toFixed(4)} cost`,
	);

	if (skippedBatches.length > 0) {
		console.warn(
			`\n  ⚠ ${skippedBatches.length} batch(es) SKIPPED due to API errors:`,
		);
		for (const s of skippedBatches) {
			console.warn(`    Batch ${s.batchIndex}: articles ${s.articleRange}`);
		}
		console.warn(
			"  Re-run the same command to retry only the missing articles.",
		);
	}

	const norms = computeNorms(vectors, allEmbeddings.length, dims);
	return {
		model: modelKey,
		dimensions: dims,
		count: allEmbeddings.length,
		articles: articleMeta,
		vectors,
		norms,
	};
}

// ── Save/Load embeddings ──

export async function saveEmbeddings(
	store: EmbeddingStore,
	path: string,
): Promise<void> {
	const meta = {
		model: store.model,
		dimensions: store.dimensions,
		count: store.count,
		articles: store.articles,
	};
	// Save metadata as JSON
	await Bun.write(`${path}.meta.json`, JSON.stringify(meta));
	// Save vectors as binary
	await Bun.write(`${path}.vectors.bin`, store.vectors.buffer);
}

export async function loadEmbeddings(path: string): Promise<EmbeddingStore> {
	const metaFile = Bun.file(`${path}.meta.json`);
	if (!(await metaFile.exists())) {
		throw new Error(`Embeddings not found at ${path}`);
	}
	const meta = JSON.parse(await metaFile.text());
	const vectorsBuffer = await Bun.file(`${path}.vectors.bin`).arrayBuffer();
	const vectors = new Float32Array(vectorsBuffer);
	const norms = computeNorms(vectors, meta.count, meta.dimensions);
	return { ...meta, vectors, norms };
}

// ── SQLite-backed embeddings ──
// Stores vectors as BLOBs in the embeddings table. No file size limit,
// atomic inserts, incremental add/remove per norm.

import type { Database } from "bun:sqlite";

/**
 * Load all embeddings from SQLite into the same EmbeddingStore format
 * used by vectorSearch(). Falls back to flat file if the DB has no embeddings.
 */
export function loadEmbeddingsFromDb(
	db: Database,
	modelKey: string,
): EmbeddingStore | null {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) return null;

	const rows = db
		.query<{ norm_id: string; block_id: string; vector: Buffer }, [string]>(
			"SELECT norm_id, block_id, vector FROM embeddings WHERE model = ? ORDER BY norm_id, block_id",
		)
		.all(modelKey);

	if (rows.length === 0) return null;

	const dims = model.dimensions;
	const count = rows.length;
	const articles: Array<{ normId: string; blockId: string }> = [];
	const vectors = new Float32Array(count * dims);

	for (let i = 0; i < count; i++) {
		const row = rows[i]!;
		articles.push({ normId: row.norm_id, blockId: row.block_id });
		const rowVector = new Float32Array(
			row.vector.buffer,
			row.vector.byteOffset,
			dims,
		);
		vectors.set(rowVector, i * dims);
	}

	const norms = computeNorms(vectors, count, dims);
	return { model: modelKey, dimensions: dims, count, articles, vectors, norms };
}

/**
 * Insert embeddings into SQLite in batches. Each batch is wrapped in a
 * transaction for atomicity. If the process crashes mid-batch, all
 * previously committed batches are safe.
 */
export function insertEmbeddingsBatch(
	db: Database,
	modelKey: string,
	articles: Array<{ normId: string; blockId: string }>,
	vectors: Float32Array,
	dims: number,
): void {
	const stmt = db.prepare(
		"INSERT OR REPLACE INTO embeddings (norm_id, block_id, model, vector) VALUES (?, ?, ?, ?)",
	);

	const BATCH = 500;
	for (let i = 0; i < articles.length; i += BATCH) {
		const end = Math.min(i + BATCH, articles.length);
		db.exec("BEGIN");
		try {
			for (let j = i; j < end; j++) {
				const a = articles[j]!;
				const offset = j * dims;
				const vec = vectors.subarray(offset, offset + dims);
				stmt.run(
					a.normId,
					a.blockId,
					modelKey,
					Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
				);
			}
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}
}

/**
 * Delete all embeddings for a norm from SQLite.
 */
export function deleteEmbeddingsByNorm(
	db: Database,
	normId: string,
	modelKey: string,
): number {
	const result = db
		.query("DELETE FROM embeddings WHERE norm_id = ? AND model = ?")
		.run(normId, modelKey);
	return result.changes;
}

// ── Vector search (brute-force cosine similarity) ──

/**
 * Chunked vector search from a flat binary file — fast and memory-efficient.
 *
 * Reads the pre-exported vectors.bin file in ~1GB chunks (80K vectors each),
 * computes cosine similarity per chunk, and maintains a min-heap of top-K.
 * Each chunk is allocated then GC'd, so peak heap is ~1GB instead of 6GB.
 *
 * Performance: ~2s for 484K vectors (vs 12s iterating SQLite row-by-row).
 * The OS page cache keeps vectors.bin hot after the first query.
 *
 * Requires vectors.bin + vectors.meta.jsonl to be exported first via
 * ensureVectorIndex(). Falls back to SQLite iterate if files don't exist.
 */

/**
 * In-memory vector index. vectors.bin is split into multiple chunks
 * because V8/Bun ArrayBuffer is capped at ~4GB. The index can hold
 * either a float32 corpus (`kind: "f32"`) or an int8 quantized corpus
 * (`kind: "int8"`) — the latter has per-vector scales recorded
 * alongside the raw int8 data and norms computed on the original
 * float32 vectors (see `quantize-vectors.ts`).
 *
 * For f32 indices `chunks` carry the raw float32 data and
 * `int8Chunks` / `scalesPerChunk` are empty.
 *
 * For int8 indices `chunks` is empty (or undefined-length entries)
 * and `int8Chunks[c]` is an `Int8Array` of `vectorsPerChunk[c] * dim`
 * bytes; `scalesPerChunk[c]` is a `Float32Array` of `vectorsPerChunk[c]`
 * scales (one per vector); `normsPerChunk[c]` is a `Float32Array` of
 * the original-vector L2 norms (loaded from the sidecar).
 */
export type VectorIndexKind = "f32" | "int8";

export interface InMemoryVectorIndex {
	kind: VectorIndexKind;
	chunks: Float32Array[];
	/** Only populated when kind === "int8". */
	int8Chunks: Int8Array[];
	/** Only populated when kind === "int8". One scale per vector. */
	scalesPerChunk: Float32Array[];
	/** vectorsPerChunk[i] = number of vectors in chunk i */
	vectorsPerChunk: number[];
	/**
	 * normsPerChunk[i] = L2 norms of vectors in chunks[i] (one float per
	 * vector). For int8 indices these are norms of the *original* float32
	 * vectors (so cosine reconstructs cleanly).
	 */
	normsPerChunk: Float32Array[];
	totalVectors: number;
	/** Dimensionality of every vector. */
	dim: number;
}

/**
 * JS reference implementation for the int8 path. Used when the native
 * SIMD lib is unavailable (CI without compiler, dev sanity checks) and
 * by the integration tests.
 */
function vectorSearchInMemoryInt8(
	queryEmbedding: Float32Array,
	meta: Array<{ normId: string; blockId: string }>,
	index: InMemoryVectorIndex,
	dims: number,
	topK: number,
): VectorSearchResult[] {
	const searchStart = Date.now();
	let queryNorm = 0;
	for (let i = 0; i < dims; i++) {
		const v = queryEmbedding[i] ?? 0;
		queryNorm += v * v;
	}
	queryNorm = Math.sqrt(queryNorm);
	if (queryNorm === 0) return [];

	const scored: Array<{ globalIdx: number; score: number }> = [];
	let globalIdx = 0;
	for (let c = 0; c < index.int8Chunks.length; c++) {
		const corpus = index.int8Chunks[c]!;
		const scales = index.scalesPerChunk[c]!;
		const norms = index.normsPerChunk[c]!;
		const numVecs = index.vectorsPerChunk[c]!;
		for (let i = 0; i < numVecs; i++) {
			const scale = scales[i]!;
			const docNorm = norms[i]!;
			if (docNorm === 0) {
				globalIdx++;
				continue;
			}
			const offset = i * dims;
			let dot = 0;
			for (let j = 0; j < dims; j++) {
				dot += queryEmbedding[j]! * corpus[offset + j]!;
			}
			const score = (dot * (scale / 127)) / (queryNorm * docNorm);
			scored.push({ globalIdx, score });
			globalIdx++;
		}
	}
	scored.sort((a, b) => b.score - a.score);
	const totalMs = Date.now() - searchStart;
	console.log(
		`[vector-search-int8] ${index.totalVectors} int8 vectors in ${totalMs}ms (JS path)`,
	);
	return scored.slice(0, topK).map((s) => {
		const a = meta[s.globalIdx]!;
		return { normId: a.normId, blockId: a.blockId, score: s.score };
	});
}

export function vectorSearchInMemory(
	queryEmbedding: Float32Array,
	meta: Array<{ normId: string; blockId: string }>,
	index: InMemoryVectorIndex,
	dims: number,
	topK: number = 10,
): VectorSearchResult[] {
	if (index.kind === "int8") {
		return vectorSearchInMemoryInt8(queryEmbedding, meta, index, dims, topK);
	}
	const searchStart = Date.now();

	// Precompute query norm
	let queryNorm = 0;
	for (let i = 0; i < dims; i++) {
		const v = queryEmbedding[i]!;
		queryNorm += v * v;
	}
	queryNorm = Math.sqrt(queryNorm);
	if (queryNorm === 0) return [];

	// Min-heap for top-K
	const heap: VectorSearchResult[] = [];
	let heapMin = -Infinity;

	const cpuStart = performance.now();
	let globalIdx = 0;
	for (let c = 0; c < index.chunks.length; c++) {
		const vectors = index.chunks[c]!;
		const norms = index.normsPerChunk[c]!;
		const numVecs = index.vectorsPerChunk[c]!;
		for (let i = 0; i < numVecs; i++) {
			const offset = i * dims;
			let dot = 0;
			for (let j = 0; j < dims; j++) {
				dot += queryEmbedding[j]! * vectors[offset + j]!;
			}
			const docNorm = norms[i]!;
			const score = docNorm > 0 ? dot / (queryNorm * docNorm) : 0;

			if (heap.length >= topK && score <= heapMin) {
				globalIdx++;
				continue;
			}

			const article = meta[globalIdx]!;
			const result: VectorSearchResult = {
				normId: article.normId,
				blockId: article.blockId,
				score,
			};

			if (heap.length < topK) {
				heap.push(result);
				let idx = heap.length - 1;
				while (idx > 0) {
					const parent = (idx - 1) >> 1;
					if (heap[parent]!.score <= heap[idx]!.score) break;
					[heap[parent]!, heap[idx]!] = [heap[idx]!, heap[parent]!];
					idx = parent;
				}
				heapMin = heap[0]!.score;
			} else {
				heap[0] = result;
				let idx = 0;
				while (true) {
					const left = 2 * idx + 1;
					const right = 2 * idx + 2;
					let smallest = idx;
					if (left < topK && heap[left]!.score < heap[smallest]!.score)
						smallest = left;
					if (right < topK && heap[right]!.score < heap[smallest]!.score)
						smallest = right;
					if (smallest === idx) break;
					[heap[smallest]!, heap[idx]!] = [heap[idx]!, heap[smallest]!];
					idx = smallest;
				}
				heapMin = heap[0]!.score;
			}
			globalIdx++;
		}
	}
	const totalCpuMs = performance.now() - cpuStart;
	const totalMs = Date.now() - searchStart;
	console.log(
		`[vector-search] ${index.totalVectors} vectors in-memory (${index.chunks.length} chunks), ${totalMs}ms (CPU ${totalCpuMs.toFixed(0)}ms)`,
	);
	heap.sort((a, b) => b.score - a.score);
	return heap;
}

/**
 * Load vectors.bin into memory as multiple Float32Array chunks (one file,
 * N arrays). Works around the ~4GB ArrayBuffer limit in V8/Bun.
 */
async function loadVectorsToMemory(
	vecPath: string,
	totalVectors: number,
	dims: number,
): Promise<InMemoryVectorIndex> {
	// Vector chunks are always SAB-backed so the worker pool can reference
	// them without a 5.6 GB copy at boot. The pool detects the underlying
	// buffer type and reuses SABs directly in toShared().
	const vecFile = Bun.file(vecPath);
	const totalBytes = vecFile.size;
	const bytesPerVec = dims * 4;
	// Max ~2.5GB per chunk to stay well under ArrayBuffer 4GB ceiling.
	const MAX_CHUNK_BYTES = 2_500_000_000;
	const vectorsPerChunk = Math.floor(MAX_CHUNK_BYTES / bytesPerVec);
	const chunks: Float32Array[] = [];
	const normsPerChunk: Float32Array[] = [];
	const vpc: number[] = [];
	let loaded = 0;
	const normStart = performance.now();
	while (loaded < totalVectors) {
		const startVec = loaded;
		const endVec = Math.min(startVec + vectorsPerChunk, totalVectors);
		const numVecs = endVec - startVec;
		const startByte = startVec * bytesPerVec;
		const endByte = endVec * bytesPerVec;
		const wanted = endByte - startByte;

		// Read into an ArrayBuffer first (Bun's fast path) and then memcpy
		// into a SAB. Per-chunk peak is 2× chunk size during the copy, but
		// each ArrayBuffer is reclaimed before the next chunk allocates.
		// Streaming via for-await proved CPU-bound at ~80x slower in
		// practice — see bench-pool history.
		const buf = await vecFile.slice(startByte, endByte).arrayBuffer();
		if (buf.byteLength < wanted) {
			throw new Error(
				`vectors.bin chunk short: expected ${wanted} got ${buf.byteLength}`,
			);
		}
		const sab = new SharedArrayBuffer(wanted);
		new Uint8Array(sab).set(new Uint8Array(buf, 0, wanted));
		const vectors = new Float32Array(sab);

		// Norms are cheap (~2 MB total) but live in a SAB too so workers
		// receive them via the init message without a copy step.
		const norms = new Float32Array(new SharedArrayBuffer(numVecs * 4));
		for (let i = 0; i < numVecs; i++) {
			const offset = i * dims;
			let sum = 0;
			for (let j = 0; j < dims; j++) {
				const v = vectors[offset + j]!;
				sum += v * v;
			}
			norms[i] = Math.sqrt(sum);
		}
		chunks.push(vectors);
		normsPerChunk.push(norms);
		vpc.push(numVecs);
		loaded = endVec;
	}
	const totalMs = performance.now() - normStart;
	console.log(
		`[rag] Loaded vectors.bin: ${(totalBytes / 1e9).toFixed(2)}GB in ${chunks.length} chunks (${totalVectors} vectors, load + norms in ${totalMs.toFixed(0)}ms)`,
	);
	return {
		kind: "f32",
		chunks,
		int8Chunks: [],
		scalesPerChunk: [],
		vectorsPerChunk: vpc,
		normsPerChunk,
		totalVectors,
		dim: dims,
	};
}

/**
 * Magic header for the int8 quantized format. See
 * `packages/api/research/quantize-vectors.ts` for the full layout.
 */
const INT8_MAGIC = "INT8VEC1";
const INT8_HEADER_BYTES = 32;
const INT8_BYTES_PER_VEC_OVERHEAD = 4; // float32 scale prefix per vector

/**
 * Detect the format of a vectors file by sniffing the first 8 bytes.
 * Cheap (single 8-byte read) and lets the caller skip touching the
 * file twice on the hot boot path.
 */
async function detectVectorFormat(
	path: string,
): Promise<"int8" | "f32" | null> {
	const f = Bun.file(path);
	if (!(await f.exists())) return null;
	const head = await f.slice(0, INT8_MAGIC.length).arrayBuffer();
	if (head.byteLength < INT8_MAGIC.length) return "f32";
	const bytes = new Uint8Array(head);
	let isInt8 = true;
	for (let i = 0; i < INT8_MAGIC.length; i++) {
		if (bytes[i] !== INT8_MAGIC.charCodeAt(i)) {
			isInt8 = false;
			break;
		}
	}
	return isInt8 ? "int8" : "f32";
}

/**
 * Load a `vectors-int8.bin` (INT8VEC1 format) into SAB-backed chunks.
 *
 * The on-disk layout interleaves a float32 scale with the int8 data per
 * vector. To keep the SIMD inner loop contiguous (and the FFI signature
 * tidy) we deinterleave at load time: int8 data lives in `Int8Array`
 * SAB chunks; scales live in their own per-chunk `Float32Array` SAB.
 *
 * Norms come from the `vectors-int8.norms.bin` sidecar — one float32
 * per vector recording the L2 norm of the *original* float32 vector
 * (so cosine reconstruction is exact).
 */
export async function loadInt8VectorsToMemory(
	vecPath: string,
	normsPath: string,
): Promise<InMemoryVectorIndex> {
	const vecFile = Bun.file(vecPath);
	const totalBytes = vecFile.size;

	// Read header.
	const headerAb = await vecFile.slice(0, INT8_HEADER_BYTES).arrayBuffer();
	const headerView = new DataView(headerAb);
	for (let i = 0; i < INT8_MAGIC.length; i++) {
		if (headerView.getUint8(i) !== INT8_MAGIC.charCodeAt(i)) {
			throw new Error(`${vecPath}: missing INT8VEC1 magic`);
		}
	}
	const dims = headerView.getUint32(8, true);
	const totalVectors = headerView.getUint32(12, true);
	const bytesPerInt8Vec = INT8_BYTES_PER_VEC_OVERHEAD + dims;

	const expectedBytes = INT8_HEADER_BYTES + totalVectors * bytesPerInt8Vec;
	if (totalBytes !== expectedBytes) {
		throw new Error(
			`${vecPath}: size mismatch — got ${totalBytes}, expected ${expectedBytes} (header says ${totalVectors} × ${dims})`,
		);
	}

	// Norms sidecar is required.
	const normsFile = Bun.file(normsPath);
	if (!(await normsFile.exists())) {
		throw new Error(
			`${vecPath} present but norms sidecar missing at ${normsPath}. ` +
				`Re-run quantize-vectors.ts to regenerate both files.`,
		);
	}
	const normsAb = await normsFile.arrayBuffer();
	if (normsAb.byteLength !== totalVectors * 4) {
		throw new Error(
			`${normsPath}: expected ${totalVectors * 4} bytes (${totalVectors} float32 norms), got ${normsAb.byteLength}`,
		);
	}
	const allNorms = new Float32Array(normsAb);

	// Chunk by vector count so each Int8Array stays well under the
	// ArrayBuffer cap. ~80M vectors per chunk is plenty for our 484K rows
	// but we keep the chunking so the loader generalizes if the corpus
	// grows beyond 4 GB of int8 (~1.4M × 3072 dims).
	const MAX_CHUNK_BYTES = 2_500_000_000;
	const vectorsPerChunk = Math.floor(MAX_CHUNK_BYTES / dims);

	const int8Chunks: Int8Array[] = [];
	const scalesPerChunk: Float32Array[] = [];
	const normsPerChunk: Float32Array[] = [];
	const vpc: number[] = [];

	const t0 = performance.now();
	let loaded = 0;
	while (loaded < totalVectors) {
		const startVec = loaded;
		const endVec = Math.min(startVec + vectorsPerChunk, totalVectors);
		const numVecs = endVec - startVec;

		const startByte = INT8_HEADER_BYTES + startVec * bytesPerInt8Vec;
		const endByte = INT8_HEADER_BYTES + endVec * bytesPerInt8Vec;
		const buf = await vecFile.slice(startByte, endByte).arrayBuffer();

		const intSab = new SharedArrayBuffer(numVecs * dims);
		const int8 = new Int8Array(intSab);
		const scaleSab = new SharedArrayBuffer(numVecs * 4);
		const scales = new Float32Array(scaleSab);

		const src = new Uint8Array(buf);
		const srcView = new DataView(buf);
		for (let v = 0; v < numVecs; v++) {
			const inOff = v * bytesPerInt8Vec;
			scales[v] = srcView.getFloat32(inOff, true);
			// Copy int8 portion. Using set on a Uint8Array view of the int8
			// SAB chunk avoids a per-byte loop while preserving the bit
			// pattern (int8 bytes are bit-identical to uint8).
			const dstOff = v * dims;
			new Uint8Array(intSab, dstOff, dims).set(
				src.subarray(
					inOff + INT8_BYTES_PER_VEC_OVERHEAD,
					inOff + bytesPerInt8Vec,
				),
			);
		}

		// Slice norms for this chunk into its own SAB so workers receive
		// it without a copy.
		const normSab = new SharedArrayBuffer(numVecs * 4);
		const norms = new Float32Array(normSab);
		norms.set(allNorms.subarray(startVec, endVec));

		int8Chunks.push(int8);
		scalesPerChunk.push(scales);
		normsPerChunk.push(norms);
		vpc.push(numVecs);
		loaded = endVec;
	}

	const totalMs = performance.now() - t0;
	console.log(
		`[rag] Loaded vectors-int8.bin: ${(totalBytes / 1e9).toFixed(2)}GB in ${int8Chunks.length} chunks (${totalVectors} vectors, dims=${dims}) in ${totalMs.toFixed(0)}ms`,
	);

	return {
		kind: "int8",
		chunks: [],
		int8Chunks,
		scalesPerChunk,
		vectorsPerChunk: vpc,
		normsPerChunk,
		totalVectors,
		dim: dims,
	};
}

/**
 * Export vectors from SQLite to flat binary files for fast chunked search.
 * Creates vectors.bin (raw Float32 data) and vectors.meta.jsonl (article IDs).
 * Only re-exports if the count has changed.
 */
export async function ensureVectorIndex(
	db: Database,
	modelKey: string,
	dataDir: string,
): Promise<{
	meta: Array<{ normId: string; blockId: string }>;
	vectors: InMemoryVectorIndex;
	dims: number;
} | null> {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) return null;

	const metaPath = `${dataDir}/vectors.meta.jsonl`;
	const vecPath = `${dataDir}/vectors.bin`;
	const int8Path = `${dataDir}/vectors-int8.bin`;
	const int8NormsPath = `${dataDir}/vectors-int8.norms.bin`;
	const dims = model.dimensions;

	const dbCount =
		db
			.query<{ cnt: number }, [string]>(
				"SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?",
			)
			.get(modelKey)?.cnt ?? 0;

	if (dbCount === 0) return null;

	// Check if files exist and are up to date
	const metaFile = Bun.file(metaPath);
	const vecFile = Bun.file(vecPath);
	const int8File = Bun.file(int8Path);

	let meta: Array<{ normId: string; blockId: string }> | null = null;

	// Prefer int8 quantized index if it exists and is fresh. Falls back
	// to float32 transparently — deleting `vectors-int8.bin` is the
	// rollback path.
	if (
		(await metaFile.exists()) &&
		(await int8File.exists()) &&
		(await Bun.file(int8NormsPath).exists())
	) {
		const lines = (await metaFile.text()).split("\n").filter(Boolean);
		if (lines.length === dbCount) {
			const fmt = await detectVectorFormat(int8Path);
			if (fmt === "int8") {
				meta = lines.map((l) => {
					const obj = JSON.parse(l);
					return { normId: obj.n, blockId: obj.b };
				});
				const vectors = await loadInt8VectorsToMemory(int8Path, int8NormsPath);
				if (vectors.totalVectors !== lines.length) {
					console.warn(
						`[rag] int8 index has ${vectors.totalVectors} vectors but meta has ${lines.length} — falling back to f32`,
					);
				} else if (vectors.dim !== dims) {
					console.warn(
						`[rag] int8 index dim=${vectors.dim} but model expects ${dims} — falling back to f32`,
					);
				} else {
					return { meta, vectors, dims };
				}
			}
		} else {
			console.log(
				`[rag] Vector index stale (${lines.length} vs ${dbCount}), rebuilding...`,
			);
		}
	}

	if ((await metaFile.exists()) && (await vecFile.exists())) {
		const lines = (await metaFile.text()).split("\n").filter(Boolean);
		if (lines.length === dbCount) {
			meta = lines.map((l) => {
				const obj = JSON.parse(l);
				return { normId: obj.n, blockId: obj.b };
			});
			const vectors = await loadVectorsToMemory(vecPath, lines.length, dims);
			return { meta, vectors, dims };
		}
		console.log(
			`[rag] Vector index stale (${lines.length} vs ${dbCount}), rebuilding...`,
		);
	}

	// Export from SQLite
	console.log(`[rag] Building vector index: ${dbCount} vectors → ${vecPath}`);
	const start = Date.now();
	const metaLines: string[] = [];

	const writer = vecFile.writer();
	const stmt = db.query<
		{ norm_id: string; block_id: string; vector: Buffer },
		[string]
	>(
		"SELECT norm_id, block_id, vector FROM embeddings WHERE model = ? ORDER BY norm_id, block_id",
	);

	let exported = 0;
	for (const row of stmt.iterate(modelKey)) {
		metaLines.push(JSON.stringify({ n: row.norm_id, b: row.block_id }));
		writer.write(
			new Uint8Array(row.vector.buffer, row.vector.byteOffset, dims * 4),
		);
		exported++;
		if (exported % 100_000 === 0) {
			writer.flush();
		}
	}
	writer.end();
	await Bun.write(metaPath, metaLines.join("\n"));

	meta = metaLines.map((l) => {
		const obj = JSON.parse(l);
		return { normId: obj.n, blockId: obj.b };
	});

	console.log(
		`[rag] Vector index built: ${exported} vectors in ${((Date.now() - start) / 1000).toFixed(1)}s`,
	);

	const vectors = await loadVectorsToMemory(vecPath, exported, dims);
	return { meta, vectors, dims };
}

/**
 * Get distinct norm IDs that have embeddings in SQLite.
 * Used for scoping BM25 search to norms that are in the embedding store.
 */
export function getEmbeddedNormIds(db: Database, modelKey: string): string[] {
	return db
		.query<{ norm_id: string }, [string]>(
			"SELECT DISTINCT norm_id FROM embeddings WHERE model = ?",
		)
		.all(modelKey)
		.map((r) => r.norm_id);
}

/**
 * Get the count of embeddings for a model.
 */
export function getEmbeddingCount(db: Database, modelKey: string): number {
	return (
		db
			.query<{ cnt: number }, [string]>(
				"SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?",
			)
			.get(modelKey)?.cnt ?? 0
	);
}

export async function embedQuery(
	apiKey: string,
	modelKey: string,
	query: string,
): Promise<{ embedding: Float32Array; cost: number; tokens: number }> {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) throw new Error(`Unknown model: ${modelKey}`);

	// Gemini Embedding 2 requires inline task prefixes for asymmetric retrieval.
	// See: https://ai.google.dev/gemini-api/docs/embeddings
	const prefixedQuery =
		modelKey === "gemini-embedding-2"
			? `task: question answering | query: ${query}`
			: query;

	const response = await fetchWithRetry(apiKey, model.id, prefixedQuery);
	// biome-ignore lint/suspicious/noExplicitAny: OpenRouter API response shape
	const data: any = await response.json();
	const usage = data.usage ?? {};
	return {
		embedding: new Float32Array(data.data[0].embedding),
		cost: usage.cost ?? 0,
		tokens: usage.total_tokens ?? 0,
	};
}

export interface VectorSearchResult {
	normId: string;
	blockId: string;
	score: number;
}

export function vectorSearch(
	queryEmbedding: Float32Array,
	store: EmbeddingStore,
	topK: number = 10,
): VectorSearchResult[] {
	const dims = store.dimensions;

	if (queryEmbedding.length !== dims) {
		throw new Error(
			`Dimension mismatch: query=${queryEmbedding.length}, store=${dims}`,
		);
	}

	const scores: Array<{ index: number; score: number }> = [];

	// Precompute query norm
	let queryNorm = 0;
	for (let i = 0; i < dims; i++) {
		queryNorm += (queryEmbedding[i] ?? 0) * (queryEmbedding[i] ?? 0);
	}
	queryNorm = Math.sqrt(queryNorm);

	for (let i = 0; i < store.count; i++) {
		const offset = i * dims;
		const docNorm = store.norms[i] ?? 0;

		// Cosine similarity using pre-computed doc norms
		let dotProduct = 0;
		for (let j = 0; j < dims; j++) {
			dotProduct += (queryEmbedding[j] ?? 0) * (store.vectors[offset + j] ?? 0);
		}

		const score =
			queryNorm > 0 && docNorm > 0 ? dotProduct / (queryNorm * docNorm) : 0;

		scores.push({ index: i, score });
	}

	scores.sort((a, b) => b.score - a.score);

	return scores.slice(0, topK).map((s) => {
		const article = store.articles[s.index]!;
		return {
			normId: article.normId,
			blockId: article.blockId,
			score: s.score,
		};
	});
}
