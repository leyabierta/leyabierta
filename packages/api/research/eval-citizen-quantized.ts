/**
 * Vector-only eval comparing float32 baseline vs int8 quantized index.
 *
 * Purely measures retrieval quality of the quantization step. BM25, RRF,
 * reranking, and the rest of the hybrid pipeline are intentionally out of
 * scope here — we want to isolate the degradation introduced by the int8
 * representation.
 *
 * For each citizen query:
 *   1. Embed the query via OpenRouter (Gemini-2 embeddings, 3072 dims).
 *   2. L2-normalize the query vector.
 *   3. KNN top-K against the float32 index using cosine similarity
 *      (precomputed doc norms).
 *   4. KNN top-K against the int8 index using
 *      score_i = (q · int8_i) * scale_i / 127 / docNorm_i
 *      where docNorm_i is the L2 norm of the *original* float32 vector
 *      (loaded once at boot).
 *   5. Aggregate per-article scores to per-norm scores using max-pool
 *      (mirrors hybrid-search.ts behavior).
 *   6. Compare metrics:
 *        - Recall@1/5/10 against expectedNorms.
 *        - Top-10 norm overlap between float32 and int8.
 *        - Spearman rank correlation across the union of top-50 norms.
 *
 * Usage:
 *   bun run packages/api/research/eval-citizen-quantized.ts
 *   bun run packages/api/research/eval-citizen-quantized.ts --topk 200 --out data/eval-citizen-quantized.json
 */

const F32_PATH = "./data/vectors.bin";
const I8_PATH = "./data/vectors-int8.bin";
const META_PATH = "./data/vectors.meta.jsonl";
const EVAL_PATH = "./packages/api/research/datasets/citizen-queries.json";
const OUT_DEFAULT = "./data/eval-citizen-quantized.json";
const DIMS = 3072;

interface MetaEntry {
	normId: string;
	blockId: string;
}

interface EvalEntry {
	id: number;
	question: string;
	category: string;
	expectedNorms: string[];
	rationale: string;
}

interface EvalFile {
	description: string;
	version: number;
	createdAt: string;
	results: EvalEntry[];
}

interface NormScore {
	normId: string;
	score: number;
}

interface PerQueryResult {
	id: number;
	question: string;
	category: string;
	expectedNorms: string[];
	f32: {
		topNorms: string[];
		hitRank: number | null;
		recall1: 0 | 1;
		recall5: 0 | 1;
		recall10: 0 | 1;
	};
	int8: {
		topNorms: string[];
		hitRank: number | null;
		recall1: 0 | 1;
		recall5: 0 | 1;
		recall10: 0 | 1;
	};
	top10Overlap: number; // 0..10
	spearmanTop50: number; // -1..1
}

interface CategorySummary {
	category: string;
	n: number;
	f32: { recall1: number; recall5: number; recall10: number };
	int8: { recall1: number; recall5: number; recall10: number };
	avgTop10Overlap: number;
	avgSpearmanTop50: number;
}

interface FinalReport {
	createdAt: string;
	totalQueries: number;
	corpusVectors: number;
	dims: number;
	topK: number;
	indexSizes: { f32Bytes: number; int8Bytes: number };
	overall: {
		f32: { recall1: number; recall5: number; recall10: number };
		int8: { recall1: number; recall5: number; recall10: number };
		avgTop10Overlap: number;
		avgSpearmanTop50: number;
	};
	byCategory: CategorySummary[];
	perQuery: PerQueryResult[];
}

function parseArgs(): { topK: number; outPath: string } {
	const argv = process.argv;
	const tk = argv.indexOf("--topk");
	const op = argv.indexOf("--out");
	return {
		topK: tk >= 0 ? Number(argv[tk + 1]) : 200,
		outPath: op >= 0 ? (argv[op + 1] ?? OUT_DEFAULT) : OUT_DEFAULT,
	};
}

// ── Meta loading ──

async function loadMeta(): Promise<MetaEntry[]> {
	const text = await Bun.file(META_PATH).text();
	const lines = text.split("\n").filter((l) => l.length > 0);
	const meta: MetaEntry[] = new Array(lines.length);
	for (let i = 0; i < lines.length; i++) {
		const obj = JSON.parse(lines[i]!) as { n: string; b: string };
		meta[i] = { normId: obj.n, blockId: obj.b };
	}
	return meta;
}

// ── Float32 index ──

interface F32Index {
	chunks: Float32Array[];
	vectorsPerChunk: number[];
	norms: Float32Array; // global, length = totalVectors
	totalVectors: number;
}

async function loadF32Index(totalVectors: number): Promise<F32Index> {
	const file = Bun.file(F32_PATH);
	const totalBytes = file.size;
	const bytesPerVec = DIMS * 4;
	if (totalBytes !== totalVectors * bytesPerVec) {
		throw new Error(
			`f32 size mismatch: ${totalBytes} vs ${totalVectors * bytesPerVec}`,
		);
	}
	const MAX_CHUNK_BYTES = 2_500_000_000;
	const vectorsPerChunkCap = Math.floor(MAX_CHUNK_BYTES / bytesPerVec);
	const chunks: Float32Array[] = [];
	const vpc: number[] = [];
	const norms = new Float32Array(totalVectors);

	let loaded = 0;
	const t0 = performance.now();
	while (loaded < totalVectors) {
		const startVec = loaded;
		const endVec = Math.min(startVec + vectorsPerChunkCap, totalVectors);
		const numVecs = endVec - startVec;
		const startByte = startVec * bytesPerVec;
		const endByte = endVec * bytesPerVec;

		const ab = await file.slice(startByte, endByte).arrayBuffer();
		const vec = new Float32Array(ab, 0, numVecs * DIMS);

		for (let i = 0; i < numVecs; i++) {
			const off = i * DIMS;
			let s = 0;
			for (let j = 0; j < DIMS; j++) {
				const v = vec[off + j]!;
				s += v * v;
			}
			norms[startVec + i] = Math.sqrt(s);
		}
		chunks.push(vec);
		vpc.push(numVecs);
		loaded = endVec;
	}
	console.log(
		`[f32] loaded ${(totalBytes / 1e9).toFixed(2)} GB in ${chunks.length} chunks, ` +
			`norms computed in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
	);
	return { chunks, vectorsPerChunk: vpc, norms, totalVectors };
}

// ── Int8 index ──

interface I8Index {
	chunks: Int8Array[]; // raw int8 components (numVecs × DIMS, contiguous)
	scales: Float32Array; // global, length = totalVectors
	vectorsPerChunk: number[];
	totalVectors: number;
}

async function loadI8Index(): Promise<I8Index> {
	const file = Bun.file(I8_PATH);
	const totalBytes = file.size;

	// Header.
	const headBuf = await file.slice(0, 32).arrayBuffer();
	const headBytes = new Uint8Array(headBuf);
	const magic = String.fromCharCode(...headBytes.subarray(0, 8));
	if (magic !== "INT8VEC1") {
		throw new Error(`bad magic in ${I8_PATH}: ${magic}`);
	}
	const headDv = new DataView(headBuf);
	const dims = headDv.getUint32(8, true);
	const totalVectors = headDv.getUint32(12, true);
	if (dims !== DIMS) throw new Error(`dims mismatch: ${dims}`);

	const bytesPerVec = 4 + DIMS;
	const expectedSize = 32 + totalVectors * bytesPerVec;
	if (totalBytes !== expectedSize) {
		throw new Error(`int8 size mismatch: ${totalBytes} vs ${expectedSize}`);
	}

	// Stream into int8 chunks + global scales.
	// Use chunks of ~5,000 vectors at read time, but materialize the full
	// int8 array as one ~1.5GB buffer per chunk to keep KNN tight.
	// Memory budget: int8 corpus ~ 1.42 GB total. Single chunk works.
	const MAX_CHUNK_BYTES = 1_800_000_000;
	const vectorsPerChunkCap = Math.floor(MAX_CHUNK_BYTES / DIMS);
	const chunks: Int8Array[] = [];
	const vpc: number[] = [];
	const scales = new Float32Array(totalVectors);

	let loaded = 0;
	const t0 = performance.now();

	while (loaded < totalVectors) {
		const startVec = loaded;
		const endVec = Math.min(startVec + vectorsPerChunkCap, totalVectors);
		const numVecs = endVec - startVec;
		const startByte = 32 + startVec * bytesPerVec;
		const endByte = 32 + endVec * bytesPerVec;

		const ab = await file.slice(startByte, endByte).arrayBuffer();
		const dv = new DataView(ab);
		const i8FullBuf = new Int8Array(numVecs * DIMS);

		for (let i = 0; i < numVecs; i++) {
			const recOff = i * bytesPerVec;
			scales[startVec + i] = dv.getFloat32(recOff, true);
			// Copy the int8 components into the contiguous int8 chunk.
			const src = new Int8Array(ab, recOff + 4, DIMS);
			i8FullBuf.set(src, i * DIMS);
		}

		chunks.push(i8FullBuf);
		vpc.push(numVecs);
		loaded = endVec;
	}
	console.log(
		`[int8] loaded ${(totalBytes / 1e9).toFixed(2)} GB in ${chunks.length} chunks, ` +
			`scales extracted in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
	);

	return { chunks, scales, vectorsPerChunk: vpc, totalVectors };
}

// ── KNN ──

interface VectorHit {
	index: number;
	score: number;
}

/**
 * Brute-force top-K via partial selection. Maintains a min-heap of size K.
 */
class TopKHeap {
	private readonly heap: VectorHit[] = [];
	private readonly k: number;
	min = -Infinity;

	constructor(k: number) {
		this.k = k;
	}

	maybeInsert(index: number, score: number): void {
		const k = this.k;
		const heap = this.heap;
		if (heap.length < k) {
			heap.push({ index, score });
			let i = heap.length - 1;
			while (i > 0) {
				const p = (i - 1) >> 1;
				if (heap[p]!.score <= heap[i]!.score) break;
				[heap[p], heap[i]] = [heap[i]!, heap[p]!];
				i = p;
			}
			this.min = heap[0]!.score;
		} else if (score > this.min) {
			heap[0] = { index, score };
			let i = 0;
			while (true) {
				const l = 2 * i + 1;
				const r = 2 * i + 2;
				let s = i;
				if (l < k && heap[l]!.score < heap[s]!.score) s = l;
				if (r < k && heap[r]!.score < heap[s]!.score) s = r;
				if (s === i) break;
				[heap[s], heap[i]] = [heap[i]!, heap[s]!];
				i = s;
			}
			this.min = heap[0]!.score;
		}
	}

	sortedDescending(): VectorHit[] {
		return [...this.heap].sort((a, b) => b.score - a.score);
	}
}

function knnFloat32(
	query: Float32Array,
	index: F32Index,
	topK: number,
): VectorHit[] {
	// Query is already L2-normalized → cosine = dot / docNorm.
	const heap = new TopKHeap(topK);
	let global = 0;
	for (let c = 0; c < index.chunks.length; c++) {
		const vecs = index.chunks[c]!;
		const n = index.vectorsPerChunk[c]!;
		for (let i = 0; i < n; i++) {
			const off = i * DIMS;
			let dot = 0;
			for (let j = 0; j < DIMS; j++) {
				dot += query[j]! * vecs[off + j]!;
			}
			const dn = index.norms[global]!;
			const score = dn > 0 ? dot / dn : 0;
			heap.maybeInsert(global, score);
			global++;
		}
	}
	return heap.sortedDescending();
}

function knnInt8(
	query: Float32Array,
	index: I8Index,
	docNorms: Float32Array,
	topK: number,
): VectorHit[] {
	// Query L2-normalized. Each int8 vector reconstructs as
	//   v_approx = (int8 / 127) * scale
	// so dot(q, v_approx) = (q · int8) * scale / 127.
	// Cosine ≈ dot(q, v_approx) / docNorm  (norm of original float32 vector,
	// known exactly so quantization error doesn't get compounded by an
	// int8-derived norm).
	const heap = new TopKHeap(topK);
	let global = 0;
	for (let c = 0; c < index.chunks.length; c++) {
		const vecs = index.chunks[c]!;
		const n = index.vectorsPerChunk[c]!;
		for (let i = 0; i < n; i++) {
			const off = i * DIMS;
			let dot = 0;
			for (let j = 0; j < DIMS; j++) {
				dot += query[j]! * vecs[off + j]!;
			}
			const scale = index.scales[global]!;
			const dn = docNorms[global]!;
			const score = dn > 0 ? (dot * scale) / 127 / dn : 0;
			heap.maybeInsert(global, score);
			global++;
		}
	}
	return heap.sortedDescending();
}

// ── Norm aggregation (max-pool) ──

function aggregateByNorm(
	hits: VectorHit[],
	meta: MetaEntry[],
	limit: number,
): NormScore[] {
	const best = new Map<string, number>();
	for (const h of hits) {
		const m = meta[h.index]!;
		const cur = best.get(m.normId);
		if (cur === undefined || h.score > cur) best.set(m.normId, h.score);
	}
	const out: NormScore[] = [];
	for (const [normId, score] of best) out.push({ normId, score });
	out.sort((a, b) => b.score - a.score);
	return out.slice(0, limit);
}

// ── Metrics ──

function firstHitRank(top: string[], expected: string[]): number | null {
	const set = new Set(expected);
	for (let i = 0; i < top.length; i++) {
		if (set.has(top[i]!)) return i + 1;
	}
	return null;
}

function spearmanFromUnion(
	a: NormScore[],
	b: NormScore[],
	cutoff: number,
): number {
	const aTop = a.slice(0, cutoff);
	const bTop = b.slice(0, cutoff);

	// Build rank maps (1 = best).
	const rankA = new Map<string, number>();
	const rankB = new Map<string, number>();
	for (let i = 0; i < aTop.length; i++) rankA.set(aTop[i]!.normId, i + 1);
	for (let i = 0; i < bTop.length; i++) rankB.set(bTop[i]!.normId, i + 1);

	// Union of norms appearing in either top-K.
	const union = new Set<string>([...rankA.keys(), ...rankB.keys()]);
	const sentinel = cutoff + 1; // missing items ranked just past the cutoff.

	const xs: number[] = [];
	const ys: number[] = [];
	for (const norm of union) {
		xs.push(rankA.get(norm) ?? sentinel);
		ys.push(rankB.get(norm) ?? sentinel);
	}

	if (xs.length < 2) return 1;

	// Spearman = Pearson on ranks. With our sentinel handling there can be
	// ties, so rank the value vectors themselves to be safe.
	const rx = ranksWithTies(xs);
	const ry = ranksWithTies(ys);
	return pearson(rx, ry);
}

function ranksWithTies(values: number[]): number[] {
	const indexed = values.map((v, i) => ({ v, i }));
	indexed.sort((a, b) => a.v - b.v);
	const ranks = new Array<number>(values.length);
	let i = 0;
	while (i < indexed.length) {
		let j = i;
		while (j < indexed.length && indexed[j]!.v === indexed[i]!.v) j++;
		const avgRank = (i + 1 + j) / 2;
		for (let k = i; k < j; k++) ranks[indexed[k]!.i] = avgRank;
		i = j;
	}
	return ranks;
}

function pearson(xs: number[], ys: number[]): number {
	const n = xs.length;
	let mx = 0;
	let my = 0;
	for (let i = 0; i < n; i++) {
		mx += xs[i]!;
		my += ys[i]!;
	}
	mx /= n;
	my /= n;
	let num = 0;
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < n; i++) {
		const a = xs[i]! - mx;
		const b = ys[i]! - my;
		num += a * b;
		dx += a * a;
		dy += b * b;
	}
	const denom = Math.sqrt(dx * dy);
	return denom === 0 ? 1 : num / denom;
}

// ── Embedding (Gemini-2 via OpenRouter) ──

async function embedQueryGemini(
	apiKey: string,
	query: string,
): Promise<Float32Array> {
	const prefixedQuery = `task: question answering | query: ${query}`;
	const body = {
		model: "google/gemini-embedding-2-preview",
		input: prefixedQuery,
	};
	const maxRetries = 4;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const resp = await fetch("https://openrouter.ai/api/v1/embeddings", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://leyabierta.es",
				"X-Title": "Ley Abierta RAG quantization eval",
			},
			body: JSON.stringify(body),
		});
		if (resp.status === 429 || resp.status >= 500) {
			if (attempt < maxRetries) {
				await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
				continue;
			}
		}
		if (!resp.ok) {
			const t = await resp.text();
			throw new Error(`embed failed ${resp.status}: ${t.slice(0, 200)}`);
		}
		// biome-ignore lint/suspicious/noExplicitAny: OpenRouter response shape
		const data: any = await resp.json();
		const arr = data.data?.[0]?.embedding;
		if (!Array.isArray(arr)) {
			throw new Error(`embed: missing embedding array`);
		}
		return new Float32Array(arr);
	}
	throw new Error("embed: exhausted retries");
}

function l2Normalize(v: Float32Array): Float32Array {
	let s = 0;
	for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
	const n = Math.sqrt(s);
	if (n === 0) return v;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
	return out;
}

// ── Main ──

async function main(): Promise<void> {
	const apiKey = process.env.OPENROUTER_API_KEY ?? "";
	if (!apiKey) {
		console.error("OPENROUTER_API_KEY is required. No mocking allowed.");
		process.exit(1);
	}

	const { topK, outPath } = parseArgs();
	console.log(`[eval-quant] topK=${topK} out=${outPath}`);

	const evalFile = (await Bun.file(EVAL_PATH).json()) as EvalFile;
	console.log(`[eval-quant] queries=${evalFile.results.length}`);

	const meta = await loadMeta();
	console.log(`[eval-quant] meta entries=${meta.length}`);

	if (meta.length !== 483_983) {
		console.warn(
			`[eval-quant] note: meta count is ${meta.length}, expected 483,983`,
		);
	}

	const f32 = await loadF32Index(meta.length);
	const i8 = await loadI8Index();
	if (i8.totalVectors !== meta.length) {
		throw new Error(
			`int8 vector count ${i8.totalVectors} != meta ${meta.length}`,
		);
	}

	const f32Bytes = Bun.file(F32_PATH).size;
	const int8Bytes = Bun.file(I8_PATH).size;

	const perQuery: PerQueryResult[] = [];
	let totalEmbedMs = 0;
	let totalF32Ms = 0;
	let totalI8Ms = 0;

	for (let qi = 0; qi < evalFile.results.length; qi++) {
		const entry = evalFile.results[qi]!;

		const tEmb = performance.now();
		const rawQ = await embedQueryGemini(apiKey, entry.question);
		const q = l2Normalize(rawQ);
		totalEmbedMs += performance.now() - tEmb;

		const tF = performance.now();
		const fHits = knnFloat32(q, f32, topK);
		const fMs = performance.now() - tF;
		totalF32Ms += fMs;

		const tI = performance.now();
		const iHits = knnInt8(q, i8, f32.norms, topK);
		const iMs = performance.now() - tI;
		totalI8Ms += iMs;

		const fNorms = aggregateByNorm(fHits, meta, 50);
		const iNorms = aggregateByNorm(iHits, meta, 50);

		const fTop = fNorms.map((n) => n.normId);
		const iTop = iNorms.map((n) => n.normId);
		const fHit = firstHitRank(fTop, entry.expectedNorms);
		const iHit = firstHitRank(iTop, entry.expectedNorms);

		const fTop10 = new Set(fTop.slice(0, 10));
		let overlap = 0;
		for (const n of iTop.slice(0, 10)) if (fTop10.has(n)) overlap++;

		const sp = spearmanFromUnion(fNorms, iNorms, 50);

		perQuery.push({
			id: entry.id,
			question: entry.question,
			category: entry.category,
			expectedNorms: entry.expectedNorms,
			f32: {
				topNorms: fTop.slice(0, 10),
				hitRank: fHit,
				recall1: fHit !== null && fHit <= 1 ? 1 : 0,
				recall5: fHit !== null && fHit <= 5 ? 1 : 0,
				recall10: fHit !== null && fHit <= 10 ? 1 : 0,
			},
			int8: {
				topNorms: iTop.slice(0, 10),
				hitRank: iHit,
				recall1: iHit !== null && iHit <= 1 ? 1 : 0,
				recall5: iHit !== null && iHit <= 5 ? 1 : 0,
				recall10: iHit !== null && iHit <= 10 ? 1 : 0,
			},
			top10Overlap: overlap,
			spearmanTop50: sp,
		});

		console.log(
			`[${(qi + 1).toString().padStart(2)}/${evalFile.results.length}] ` +
				`f32=${fHit ?? "miss"} int8=${iHit ?? "miss"} ` +
				`overlap=${overlap}/10 sp=${sp.toFixed(3)} ` +
				`(emb ${(performance.now() - tEmb).toFixed(0)}ms, f32 ${fMs.toFixed(0)}ms, i8 ${iMs.toFixed(0)}ms) ` +
				`q="${entry.question.slice(0, 60)}"`,
		);
	}

	// Aggregates.
	const n = perQuery.length;
	const sum = (sel: (p: PerQueryResult) => number): number =>
		perQuery.reduce((s, p) => s + sel(p), 0);

	const overall = {
		f32: {
			recall1: sum((p) => p.f32.recall1) / n,
			recall5: sum((p) => p.f32.recall5) / n,
			recall10: sum((p) => p.f32.recall10) / n,
		},
		int8: {
			recall1: sum((p) => p.int8.recall1) / n,
			recall5: sum((p) => p.int8.recall5) / n,
			recall10: sum((p) => p.int8.recall10) / n,
		},
		avgTop10Overlap: sum((p) => p.top10Overlap) / n / 10,
		avgSpearmanTop50: sum((p) => p.spearmanTop50) / n,
	};

	const byCatMap = new Map<string, PerQueryResult[]>();
	for (const p of perQuery) {
		const arr = byCatMap.get(p.category) ?? [];
		arr.push(p);
		byCatMap.set(p.category, arr);
	}
	const byCategory: CategorySummary[] = [];
	for (const [category, items] of byCatMap) {
		const m = items.length;
		const sumC = (sel: (p: PerQueryResult) => number): number =>
			items.reduce((s, p) => s + sel(p), 0);
		byCategory.push({
			category,
			n: m,
			f32: {
				recall1: sumC((p) => p.f32.recall1) / m,
				recall5: sumC((p) => p.f32.recall5) / m,
				recall10: sumC((p) => p.f32.recall10) / m,
			},
			int8: {
				recall1: sumC((p) => p.int8.recall1) / m,
				recall5: sumC((p) => p.int8.recall5) / m,
				recall10: sumC((p) => p.int8.recall10) / m,
			},
			avgTop10Overlap: sumC((p) => p.top10Overlap) / m / 10,
			avgSpearmanTop50: sumC((p) => p.spearmanTop50) / m,
		});
	}
	byCategory.sort((a, b) => a.category.localeCompare(b.category));

	const report: FinalReport = {
		createdAt: new Date().toISOString(),
		totalQueries: n,
		corpusVectors: meta.length,
		dims: DIMS,
		topK,
		indexSizes: { f32Bytes, int8Bytes },
		overall,
		byCategory,
		perQuery,
	};

	await Bun.write(outPath, JSON.stringify(report, null, 2));

	console.log("");
	console.log("===== summary =====");
	console.log(
		`Recall@1   f32=${(overall.f32.recall1 * 100).toFixed(1)}%   int8=${(overall.int8.recall1 * 100).toFixed(1)}%   Δ=${((overall.int8.recall1 - overall.f32.recall1) * 100).toFixed(1)}pp`,
	);
	console.log(
		`Recall@5   f32=${(overall.f32.recall5 * 100).toFixed(1)}%   int8=${(overall.int8.recall5 * 100).toFixed(1)}%   Δ=${((overall.int8.recall5 - overall.f32.recall5) * 100).toFixed(1)}pp`,
	);
	console.log(
		`Recall@10  f32=${(overall.f32.recall10 * 100).toFixed(1)}%   int8=${(overall.int8.recall10 * 100).toFixed(1)}%   Δ=${((overall.int8.recall10 - overall.f32.recall10) * 100).toFixed(1)}pp`,
	);
	console.log(
		`Top-10 overlap (avg) = ${(overall.avgTop10Overlap * 100).toFixed(1)}%`,
	);
	console.log(`Spearman top-50 (avg) = ${overall.avgSpearmanTop50.toFixed(3)}`);
	console.log("");
	console.log(
		`Index sizes: f32=${(f32Bytes / 1e9).toFixed(2)} GB → int8=${(int8Bytes / 1e9).toFixed(2)} GB ` +
			`(${((int8Bytes / f32Bytes) * 100).toFixed(1)}% of original)`,
	);
	console.log(
		`Total times: embed=${(totalEmbedMs / 1000).toFixed(1)}s f32-knn=${(totalF32Ms / 1000).toFixed(1)}s int8-knn=${(totalI8Ms / 1000).toFixed(1)}s`,
	);
	console.log(`Wrote ${outPath}`);
}

await main();
