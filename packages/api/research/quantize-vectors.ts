/**
 * Offline int8 quantization for the vector index.
 *
 * Reads `data/vectors.bin` (Float32, 3072-dim, ~484K vectors, ~5.5 GB) in
 * chunks and writes:
 *   - `data/vectors-int8.bin`        per-vector symmetric int8 quantization
 *                                    + a float32 scale factor.
 *   - `data/vectors-int8.norms.bin`  flat float32 array of L2 norms of the
 *                                    *original* float32 vectors. Required
 *                                    by the runtime loader so cosine
 *                                    reconstruction is exact (norm of the
 *                                    int8 vector, even rescaled, drifts
 *                                    enough to drop Recall@1 by ~1pp).
 *
 * Quantized vector format:
 *   Header (32 bytes):
 *     bytes 0..7   = ASCII "INT8VEC1"
 *     bytes 8..11  = uint32 LE  dims (= 3072)
 *     bytes 12..15 = uint32 LE  n_vectors
 *     bytes 16..31 = reserved (zeroed)
 *   Per vector (4 + dims bytes):
 *     float32 LE  scale = max(|v|)
 *     int8[dims]  quantized components, v_int8 = round(v / scale * 127)
 *
 * Norms format:
 *   float32 LE × n_vectors (no header).
 *
 * Total: 32 + n * (4 + dims) + n * 4 bytes.
 *
 * The original meta file is reused verbatim (no copy) — this script does not
 * modify any production data.
 *
 * Usage:
 *   bun run packages/api/research/quantize-vectors.ts
 *   bun run packages/api/research/quantize-vectors.ts --in data/vectors.bin --out data/vectors-int8.bin
 */

const DEFAULT_IN = "./data/vectors.bin";
const DEFAULT_OUT = "./data/vectors-int8.bin";
const DIMS = 3072;

// Process this many vectors per disk chunk. ~5,000 vectors ≈ 60 MB read.
const CHUNK_VECTORS = 5_000;
const REPORT_EVERY = 50_000;

interface Args {
	inPath: string;
	outPath: string;
}

function parseArgs(): Args {
	const argv = process.argv;
	const inIdx = argv.indexOf("--in");
	const outIdx = argv.indexOf("--out");
	return {
		inPath: inIdx >= 0 ? (argv[inIdx + 1] ?? DEFAULT_IN) : DEFAULT_IN,
		outPath: outIdx >= 0 ? (argv[outIdx + 1] ?? DEFAULT_OUT) : DEFAULT_OUT,
	};
}

/**
 * Derive the norms sidecar path from the int8 output path.
 * `data/vectors-int8.bin` → `data/vectors-int8.norms.bin`.
 * Falls back to appending `.norms` for any other suffix.
 */
export function normsPathFor(outPath: string): string {
	if (outPath.endsWith(".bin")) {
		return `${outPath.slice(0, -".bin".length)}.norms.bin`;
	}
	return `${outPath}.norms.bin`;
}

/**
 * Quantize a float32 vectors.bin into INT8VEC1 + a norms sidecar.
 *
 * Pure-ish: takes paths, writes two files, returns counts. No process.exit
 * inside so callers (e.g. sync-embeddings.ts) can run it inline.
 */
export async function quantizeVectorsFile(opts: {
	inPath: string;
	outPath: string;
	dims?: number;
	chunkVectors?: number;
	reportEvery?: number;
}): Promise<{ totalVectors: number; outBytes: number; normsBytes: number }> {
	const dims = opts.dims ?? DIMS;
	const chunkVecs = opts.chunkVectors ?? CHUNK_VECTORS;
	const reportEvery = opts.reportEvery ?? REPORT_EVERY;
	const bytesPerF32Vec = dims * 4;
	const bytesPerInt8Vec = 4 + dims;

	const inFile = Bun.file(opts.inPath);
	if (!(await inFile.exists())) {
		throw new Error(`Input vectors file not found: ${opts.inPath}`);
	}

	const totalBytes = inFile.size;
	if (totalBytes % bytesPerF32Vec !== 0) {
		throw new Error(
			`Input size ${totalBytes} is not a multiple of ${bytesPerF32Vec} (${dims} floats × 4 bytes)`,
		);
	}
	const totalVectors = totalBytes / bytesPerF32Vec;
	const normsPath = normsPathFor(opts.outPath);
	console.log(
		`[quantize] input=${opts.inPath} size=${(totalBytes / 1e9).toFixed(2)}GB vectors=${totalVectors} dims=${dims}`,
	);
	console.log(`[quantize] output=${opts.outPath}`);
	console.log(`[quantize] norms =${normsPath}`);

	const writer = Bun.file(opts.outPath).writer();
	const normsWriter = Bun.file(normsPath).writer();

	// Write header (32 bytes).
	const header = new Uint8Array(32);
	const magic = "INT8VEC1";
	for (let i = 0; i < magic.length; i++) header[i] = magic.charCodeAt(i);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(8, dims, true);
	headerView.setUint32(12, totalVectors, true);
	writer.write(header);

	const t0 = performance.now();
	let processed = 0;

	const outChunkBytes = chunkVecs * bytesPerInt8Vec;
	const outBuf = new Uint8Array(outChunkBytes);
	const normsBuf = new Float32Array(chunkVecs);

	while (processed < totalVectors) {
		const startVec = processed;
		const endVec = Math.min(startVec + chunkVecs, totalVectors);
		const numVecs = endVec - startVec;

		const startByte = startVec * bytesPerF32Vec;
		const endByte = endVec * bytesPerF32Vec;
		const wantedBytes = endByte - startByte;

		const ab = await inFile.slice(startByte, endByte).arrayBuffer();
		if (ab.byteLength < wantedBytes) {
			throw new Error(
				`Short read at vec ${startVec}: expected ${wantedBytes} got ${ab.byteLength}`,
			);
		}
		const floats = new Float32Array(ab, 0, numVecs * dims);

		const outView = new DataView(
			outBuf.buffer,
			outBuf.byteOffset,
			numVecs * bytesPerInt8Vec,
		);
		const outI8 = new Int8Array(outBuf.buffer, outBuf.byteOffset);

		for (let v = 0; v < numVecs; v++) {
			const inOff = v * dims;
			const outOff = v * bytesPerInt8Vec;

			// Compute scale = max(|v|) and the L2 norm of the *original*
			// float32 vector in the same pass — both are O(dims) anyway and
			// the data is already hot in the L1.
			let absMax = 0;
			let sumSq = 0;
			for (let j = 0; j < dims; j++) {
				const x = floats[inOff + j]!;
				const a = Math.abs(x);
				if (a > absMax) absMax = a;
				sumSq += x * x;
			}
			normsBuf[v] = Math.sqrt(sumSq);

			const scale = absMax;
			outView.setFloat32(outOff, scale, true);

			if (scale === 0) {
				for (let j = 0; j < dims; j++) {
					outI8[outOff + 4 + j] = 0;
				}
				continue;
			}

			const inv = 127 / scale;
			for (let j = 0; j < dims; j++) {
				let q = Math.round(floats[inOff + j]! * inv);
				if (q > 127) q = 127;
				else if (q < -128) q = -128;
				outI8[outOff + 4 + j] = q;
			}
		}

		writer.write(outBuf.subarray(0, numVecs * bytesPerInt8Vec));
		// Norms sidecar: write the prefix of the per-chunk norms buffer.
		// Slicing yields a copy backed by a fresh ArrayBuffer; not ideal
		// per-chunk but the volume here is ~2 MB total so the overhead is
		// negligible vs. the int8 write.
		const normsBytes = new Uint8Array(
			normsBuf.buffer,
			normsBuf.byteOffset,
			numVecs * 4,
		);
		normsWriter.write(normsBytes);
		processed = endVec;

		if (processed - (processed % reportEvery) > startVec) {
			const now = performance.now();
			const elapsedSec = (now - t0) / 1000;
			const rate = processed / elapsedSec;
			const etaSec = (totalVectors - processed) / rate;
			console.log(
				`  ${processed.toLocaleString()}/${totalVectors.toLocaleString()} ` +
					`(${((processed / totalVectors) * 100).toFixed(1)}%) ` +
					`elapsed=${elapsedSec.toFixed(1)}s rate=${rate.toFixed(0)}/s ETA=${etaSec.toFixed(1)}s`,
			);
		}
	}

	await writer.end();
	await normsWriter.end();

	const totalSec = (performance.now() - t0) / 1000;
	const outFile = Bun.file(opts.outPath);
	const outBytes = outFile.size;
	const normsBytes = Bun.file(normsPath).size;
	const expectedBytes = 32 + totalVectors * bytesPerInt8Vec;
	const expectedNormsBytes = totalVectors * 4;
	console.log(
		`[quantize] wrote ${(outBytes / 1e9).toFixed(3)} GB ` +
			`(expected ${(expectedBytes / 1e9).toFixed(3)} GB) in ${totalSec.toFixed(1)}s`,
	);
	console.log(
		`[quantize] norms ${(normsBytes / 1e6).toFixed(2)} MB (expected ${(expectedNormsBytes / 1e6).toFixed(2)} MB)`,
	);
	if (outBytes !== expectedBytes) {
		throw new Error(
			`[quantize] SIZE MISMATCH: got ${outBytes}, expected ${expectedBytes}`,
		);
	}
	if (normsBytes !== expectedNormsBytes) {
		throw new Error(
			`[quantize] NORMS SIZE MISMATCH: got ${normsBytes}, expected ${expectedNormsBytes}`,
		);
	}

	const ratio = outBytes / totalBytes;
	console.log(
		`[quantize] compression: ${(totalBytes / 1e9).toFixed(2)} GB → ${(outBytes / 1e9).toFixed(2)} GB ` +
			`(${(ratio * 100).toFixed(1)}%, saved ${((1 - ratio) * 100).toFixed(1)}%)`,
	);
	return { totalVectors, outBytes, normsBytes };
}

async function main(): Promise<void> {
	const { inPath, outPath } = parseArgs();
	await quantizeVectorsFile({ inPath, outPath });
	console.log(
		`[quantize] meta file is reused as-is from data/vectors.meta.jsonl ` +
			`(no copy made — single source of truth)`,
	);
}

if (import.meta.main) {
	await main();
}
