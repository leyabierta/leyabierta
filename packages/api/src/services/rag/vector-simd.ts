/**
 * Native SIMD brute-force cosine top-K search via Bun.dlopen.
 *
 * Loads the platform-appropriate shared library compiled from
 * `vector-simd.c` and exposes a single function `vectorSearchSIMD`
 * that mirrors the contract of `vectorSearchInMemory` (in
 * embeddings.ts) but pushes the inner loops to AVX2+FMA on Linux/x86_64.
 *
 * Behavior contract — for the same inputs, the top-K returned by
 * `vectorSearchSIMD` is the same set as `vectorSearchInMemory` up to
 * ties broken by index order. Scores match within ~1e-5 absolute
 * (different reduction order between scalar JS and FMA).
 *
 * Selection of backend at runtime:
 *   - process.env.RAG_VECTOR_BACKEND === "js"   → never load native
 *   - "simd" or unset → try native; fall back to JS if dylib missing
 */

import { dlopen, FFIType, ptr, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { InMemoryVectorIndex, VectorSearchResult } from "./embeddings.ts";

const BACKEND_ENV = (process.env.RAG_VECTOR_BACKEND ?? "simd").toLowerCase();

interface NativeBindings {
	cosine_topk: (
		query: Uint8Array | NodeJS.TypedArray,
		queryNorm: number,
		vectors: Uint8Array | NodeJS.TypedArray,
		docNorms: Uint8Array | NodeJS.TypedArray,
		nDocs: number,
		dim: number,
		topK: number,
		outIndices: Uint8Array | NodeJS.TypedArray,
		outScores: Uint8Array | NodeJS.TypedArray,
	) => number;
	cosine_topk_int8: (
		query: Uint8Array | NodeJS.TypedArray,
		queryNorm: number,
		corpusInt8: Uint8Array | NodeJS.TypedArray,
		scales: Uint8Array | NodeJS.TypedArray,
		docNorms: Uint8Array | NodeJS.TypedArray,
		nDocs: number,
		dim: number,
		topK: number,
		outIndices: Uint8Array | NodeJS.TypedArray,
		outScores: Uint8Array | NodeJS.TypedArray,
	) => number;
}

let cached: NativeBindings | null | undefined;

function platformLibName(): string | null {
	const platform = process.platform;
	const arch = process.arch;
	if (platform === "linux" && arch === "x64") {
		return `vector-simd.linux-amd64.${suffix}`;
	}
	if (platform === "darwin" && arch === "arm64") {
		return `vector-simd.darwin-arm64.${suffix}`;
	}
	if (platform === "darwin" && arch === "x64") {
		return `vector-simd.darwin-amd64.${suffix}`;
	}
	return null;
}

function loadNative(): NativeBindings | null {
	if (cached !== undefined) return cached;
	if (BACKEND_ENV === "js") {
		cached = null;
		return null;
	}
	const libName = platformLibName();
	if (!libName) {
		cached = null;
		return null;
	}
	const libPath = join(import.meta.dir, libName);
	if (!existsSync(libPath)) {
		console.warn(
			`[vector-simd] native lib missing at ${libPath} — falling back to JS`,
		);
		cached = null;
		return null;
	}
	try {
		const { symbols } = dlopen(libPath, {
			cosine_topk: {
				args: [
					FFIType.ptr, // const float* query
					FFIType.f32, // float query_norm
					FFIType.ptr, // const float* vectors
					FFIType.ptr, // const float* doc_norms
					FFIType.i32, // int32 n_docs
					FFIType.i32, // int32 dim
					FFIType.i32, // int32 top_k
					FFIType.ptr, // int32* out_indices
					FFIType.ptr, // float* out_scores
				],
				returns: FFIType.i32,
			},
			cosine_topk_int8: {
				args: [
					FFIType.ptr, // const float* query
					FFIType.f32, // float query_norm
					FFIType.ptr, // const int8* corpus
					FFIType.ptr, // const float* scales
					FFIType.ptr, // const float* doc_norms
					FFIType.i32, // int32 n_docs
					FFIType.i32, // int32 dim
					FFIType.i32, // int32 top_k
					FFIType.ptr, // int32* out_indices
					FFIType.ptr, // float* out_scores
				],
				returns: FFIType.i32,
			},
		});
		cached = {
			cosine_topk: (q, qn, v, dn, n, d, k, oi, os) =>
				symbols.cosine_topk(
					ptr(q as NodeJS.TypedArray),
					qn,
					ptr(v as NodeJS.TypedArray),
					ptr(dn as NodeJS.TypedArray),
					n,
					d,
					k,
					ptr(oi as NodeJS.TypedArray),
					ptr(os as NodeJS.TypedArray),
				),
			cosine_topk_int8: (q, qn, c, sc, dn, n, d, k, oi, os) =>
				symbols.cosine_topk_int8(
					ptr(q as NodeJS.TypedArray),
					qn,
					ptr(c as NodeJS.TypedArray),
					ptr(sc as NodeJS.TypedArray),
					ptr(dn as NodeJS.TypedArray),
					n,
					d,
					k,
					ptr(oi as NodeJS.TypedArray),
					ptr(os as NodeJS.TypedArray),
				),
		};
		return cached;
	} catch (err) {
		console.warn(
			`[vector-simd] dlopen failed (${(err as Error).message}) — JS fallback`,
		);
		cached = null;
		return null;
	}
}

/**
 * Returns true iff the native backend is available and selected.
 * Handlers can use this to decide whether to call vectorSearchSIMD()
 * or stay on vectorSearchInMemory().
 */
export function simdAvailable(): boolean {
	return loadNative() !== null;
}

/**
 * Native SIMD vector search.
 *
 * The vector index is split into chunks (Float32Array up to ~2.5GB each)
 * because Bun's ArrayBuffer cap is ~4GB and our prod corpus is ~6GB. We
 * call the native function once per chunk and merge top-K across chunks
 * with a tiny final selection in JS — cost is negligible for K≤200.
 */
export function vectorSearchSIMD(
	queryEmbedding: Float32Array,
	meta: Array<{ normId: string; blockId: string }>,
	index: InMemoryVectorIndex,
	dims: number,
	topK: number = 10,
): VectorSearchResult[] {
	const native = loadNative();
	if (!native) {
		throw new Error(
			"vectorSearchSIMD called but native backend is unavailable",
		);
	}

	// Precompute query norm.
	let queryNorm = 0;
	for (let i = 0; i < dims; i++) {
		const v = queryEmbedding[i] ?? 0;
		queryNorm += v * v;
	}
	queryNorm = Math.sqrt(queryNorm);
	if (queryNorm === 0) return [];

	const t0 = performance.now();
	const merged: Array<{ globalIdx: number; score: number }> = [];
	let globalOffset = 0;

	const isInt8 = index.kind === "int8";
	const numChunks = isInt8 ? index.int8Chunks.length : index.chunks.length;

	for (let c = 0; c < numChunks; c++) {
		const norms = index.normsPerChunk[c]!;
		const numVecs = index.vectorsPerChunk[c]!;
		if (numVecs === 0) continue;

		const k = Math.min(topK, numVecs);
		const outIndices = new Int32Array(k);
		const outScores = new Float32Array(k);

		let written: number;
		if (isInt8) {
			const corpus = index.int8Chunks[c]!;
			const scales = index.scalesPerChunk[c]!;
			written = native.cosine_topk_int8(
				queryEmbedding,
				queryNorm,
				corpus,
				scales,
				norms,
				numVecs,
				dims,
				k,
				outIndices,
				outScores,
			);
		} else {
			const vectors = index.chunks[c]!;
			written = native.cosine_topk(
				queryEmbedding,
				queryNorm,
				vectors,
				norms,
				numVecs,
				dims,
				k,
				outIndices,
				outScores,
			);
		}

		for (let i = 0; i < written; i++) {
			merged.push({
				globalIdx: globalOffset + outIndices[i]!,
				score: outScores[i]!,
			});
		}
		globalOffset += numVecs;
	}

	// Final selection across chunks.
	merged.sort((a, b) => b.score - a.score);
	const results = merged.slice(0, topK).map((m) => {
		const article = meta[m.globalIdx]!;
		return {
			normId: article.normId,
			blockId: article.blockId,
			score: m.score,
		} satisfies VectorSearchResult;
	});

	const totalMs = performance.now() - t0;
	console.log(
		`[vector-search-simd:${index.kind}] ${index.totalVectors} vectors, ${numChunks} chunks, ${totalMs.toFixed(0)}ms`,
	);
	return results;
}
