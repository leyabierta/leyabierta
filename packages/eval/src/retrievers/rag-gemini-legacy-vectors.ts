/**
 * Vector loading helper for the Gemini legacy retriever.
 *
 * Reads `data/vectors-gemini.bin` + `data/vectors-gemini.meta.jsonl` into
 * memory as an InMemoryVectorIndex (f32, chunked). The format is identical to
 * the Qwen export (`ensureVectorIndex` in embeddings.ts) — raw Float32, row-major,
 * one vector per row, no header.
 *
 * The index is chunked (same 2.5 GB per chunk limit as the Qwen loader) to
 * handle the 5.7 GB Gemini binary without hitting the V8/Bun ArrayBuffer cap.
 *
 * Uses SharedArrayBuffers for the chunks so a future worker-pool path can share
 * them without copying — consistent with how the Qwen loader works.
 */

import type { InMemoryVectorIndex } from "../../../api/src/services/rag/embeddings.ts";

const GEMINI_DIMS = 3072;
const MAX_CHUNK_BYTES = 2_500_000_000; // 2.5 GB per chunk, same as Qwen loader

export interface GeminiVectorIndex {
	meta: Array<{ normId: string; blockId: string }>;
	index: InMemoryVectorIndex;
	totalVectors: number;
}

/**
 * Load vectors-gemini.bin + vectors-gemini.meta.jsonl into memory.
 *
 * @param vecPath  - Absolute path to vectors-gemini.bin
 * @param metaPath - Absolute path to vectors-gemini.meta.jsonl
 */
export async function loadVectorsGemini(
	vecPath: string,
	metaPath: string,
): Promise<GeminiVectorIndex> {
	const dims = GEMINI_DIMS;
	const bytesPerVec = dims * 4; // float32
	const MAX_CHUNK_BYTES_ADJUSTED = MAX_CHUNK_BYTES;
	const vectorsPerChunk = Math.floor(MAX_CHUNK_BYTES_ADJUSTED / bytesPerVec);

	// Load meta lines.
	const metaText = await Bun.file(metaPath).text();
	const metaLines = metaText.split("\n").filter(Boolean);
	const totalVectors = metaLines.length;

	if (totalVectors === 0) {
		throw new Error(
			`[rag-gemini-legacy] vectors-gemini.meta.jsonl is empty: ${metaPath}`,
		);
	}

	const meta: Array<{ normId: string; blockId: string }> = metaLines.map(
		(l) => {
			const obj = JSON.parse(l) as { n: string; b: string };
			return { normId: obj.n, blockId: obj.b };
		},
	);

	// Validate binary size.
	const vecFile = Bun.file(vecPath);
	const expectedBytes = totalVectors * bytesPerVec;
	const actualBytes = vecFile.size;
	if (actualBytes !== expectedBytes) {
		throw new Error(
			`[rag-gemini-legacy] vectors-gemini.bin size mismatch: ` +
				`expected ${expectedBytes} (${totalVectors} × ${dims} × 4B), ` +
				`got ${actualBytes}. ` +
				`Re-run packages/api/scripts/export-gemini-vectors.ts --force`,
		);
	}

	// Load in chunks.
	const chunks: Float32Array[] = [];
	const normsPerChunk: Float32Array[] = [];
	const vpc: number[] = [];
	const t0 = performance.now();

	let loaded = 0;
	while (loaded < totalVectors) {
		const startVec = loaded;
		const endVec = Math.min(startVec + vectorsPerChunk, totalVectors);
		const numVecs = endVec - startVec;
		const startByte = startVec * bytesPerVec;
		const endByte = endVec * bytesPerVec;
		const wanted = endByte - startByte;

		// Read into a temporary ArrayBuffer, then copy into a SharedArrayBuffer.
		// Same pattern as loadVectorsToMemory in embeddings.ts.
		const buf = await vecFile.slice(startByte, endByte).arrayBuffer();
		if (buf.byteLength < wanted) {
			throw new Error(
				`[rag-gemini-legacy] vectors-gemini.bin chunk short: expected ${wanted} got ${buf.byteLength}`,
			);
		}

		const sab = new SharedArrayBuffer(wanted);
		new Uint8Array(sab).set(new Uint8Array(buf, 0, wanted));
		const vectors = new Float32Array(sab);

		// Pre-compute L2 norms in a SAB.
		const normSab = new SharedArrayBuffer(numVecs * 4);
		const norms = new Float32Array(normSab);
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

	const totalMs = performance.now() - t0;
	console.log(
		`[rag-gemini-legacy] Loaded vectors-gemini.bin: ${(actualBytes / 1e9).toFixed(2)}GB in ${chunks.length} chunk(s) (${totalVectors} vectors, ${totalMs.toFixed(0)}ms)`,
	);

	const index: InMemoryVectorIndex = {
		kind: "f32",
		chunks,
		int8Chunks: [],
		scalesPerChunk: [],
		vectorsPerChunk: vpc,
		normsPerChunk,
		totalVectors,
		dim: dims,
	};

	return { meta, index, totalVectors };
}
