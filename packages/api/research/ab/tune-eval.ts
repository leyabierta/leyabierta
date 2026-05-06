/**
 * Tuning eval harness for Qwen3-Embedding-8B via NaN API.
 *
 * Uses pre-computed qwen3 embeddings from the DB (60,281 vectors),
 * and only uses NaN API for query embedding.
 * This matches the setup from the 2026-05-01 A/B that got R@1=86%.
 *
 * NaN API: https://api.nan.builders/v1
 * Model: qwen3-embedding (4096 dims, OpenAI-compatible)
 *
 * Usage:
 *   bun packages/api/research/ab/tune-eval.ts \
 *     --query-prefix=instruct-en \
 *     --doc-format=prod \
 *     --mrl-dim=4096 \
 *     --normalize=l2
 *
 * Outputs to stdout:
 *   RESULT r1=86.0 r5=96.5 r10=98.2 r60=100.0 mrr=0.902 gap=-10.5 prefix=...
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

import { createSchema } from "../../../pipeline/src/db/schema.ts";
import {
	EMBEDDING_MODELS,
	vectorSearch,
} from "../../src/services/rag/embeddings.ts";
import { buildCorpusPlan, type PreparedBlock } from "./corpus.ts";

// ── NaN config ──
const NAN_BASE_URL = "https://api.nan.builders/v1";
const NAN_API_KEY = process.env.NAN_API_KEY ?? "";
const NAN_MODEL = "qwen3-embedding";
const _NAN_DIM = 4096;
const _NAN_BATCH_SIZE = 32; // NaN supports batch size 32

// ── Gemini-2 baseline (from prior A/B) ──
const GEMINI_R1 = 96.5;

// ── Argument parsing ──
function parseArgs(): Record<string, string> {
	const args = process.argv.slice(2);
	const map: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i]!.startsWith("--")) {
			const eq = args[i]!.indexOf("=");
			if (eq >= 0) {
				map[args[i]!.slice(2, eq)] = args[i]!.slice(eq + 1);
			} else {
				map[args[i]!.slice(2)] = args[i + 1] ?? "true";
				i++;
			}
		}
	}
	return map;
}

// ── Query prefix implementations ──
const QUERY_PREFIXES: Record<string, (q: string) => string> = {
	"instruct-en": (q) =>
		`Instruct: Given a Spanish citizen's legal question, retrieve the article of Spanish law that best answers it.\nQuery: ${q}`,
	"instruct-es": (q) =>
		`Instruct: Dada una pregunta legal de un ciudadano español, recupera el artículo de la ley española que mejor la responde.\nConsulta: ${q}`,
	"short-en": (q) => `Retrieve Spanish legal article for: ${q}`,
	"short-es": (q) => `Recupera artículo de ley española para: ${q}`,
	none: (q) => q,
	"keyword-en": (q) =>
		`Given a Spanish legal question, find the relevant article of Spanish law.\nQuery: ${q}`,
	"keyword-es": (q) =>
		`Dada una pregunta legal en español, encuentra el artículo relevante de la ley española.\nConsulta: ${q}`,
	"qa-en": (q) =>
		`Answer the following legal question using Spanish law.\nQuestion: ${q}`,
	"qa-es": (q) =>
		`Responde la siguiente pregunta legal usando la ley española.\nPregunta: ${q}`,
	"search-en": (q) =>
		`Search for the Spanish law article that answers this question:\nQuery: ${q}`,
	"search-es": (q) =>
		`Buscar el artículo de ley española que responda a esta pregunta:\nConsulta: ${q}`,
	minimal: (q) => `Query: ${q}`,
	"instruct-long-en": (q) =>
		`You are a legal research assistant for Spanish citizens. Given a plain-language legal question in Spanish or English, retrieve the most relevant article or section of Spanish law that directly answers the question. Consider current, vigente law. Think about the subject matter (materia), the type of legal relationship, and the specific rights or obligations mentioned.\nQuery: ${q}`,
	"instruct-long-es": (q) =>
		`Eres un asistente de investigación legal para ciudadanos españoles. Dada una pregunta legal en lenguaje claro, en español o inglés, recupera el artículo o sección más relevante de la ley española que responda directamente a la pregunta. Considera la ley vigente. Piensa en la materia, el tipo de relación legal y los derechos u obligaciones específicos mencionados.\nConsulta: ${q}`,
};

// ── Document format implementations ──
function _formatDoc(block: PreparedBlock, format: string): string {
	// Parse the production format to extract norm title and chunk info
	const parts = block.text.split("\n\n");
	const header = parts[0] || "";
	const body = parts[1] || block.rawText;

	// Extract norm title from header (format: "title: {norm_title} | text: {chunk_title}")
	const normTitleMatch = header.match(/title:\s*(.+?)\s*\|/);
	const normTitle = normTitleMatch ? normTitleMatch[1].trim() : block.normId;
	const chunkTitle = block.blockId;

	switch (format) {
		case "prod":
			return `title: ${normTitle} | text: ${chunkTitle}\n\n${body}`;
		case "raw":
			return block.rawText;
		case "title-only":
			return `title: ${normTitle}\n\n${body}`;
		case "no-title":
			return `text: ${chunkTitle}\n\n${body}`;
		case "full-meta":
			return `Title: ${normTitle}\nArticle: ${chunkTitle}\n\n${body}`;
		case "spanish-labels":
			return `título: ${normTitle} | texto: ${chunkTitle}\n\n${body}`;
		case "yaml-front":
			return `---\nnorm: ${normTitle}\narticle: ${chunkTitle}\n---\n\n${body}`;
		case "doc-prefix":
			return `Document: ${normTitle}\nSection: ${chunkTitle}\n\n${body}`;
		default:
			return block.text; // fallback to production format
	}
}

// ── L2 normalize a vector ──
function l2Normalize(v: Float32Array): Float32Array {
	let sum = 0;
	for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
	const norm = Math.sqrt(sum);
	if (norm === 0) return v;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
	return out;
}

// ── L1 normalize a vector ──
function l1Normalize(v: Float32Array): Float32Array {
	let sum = 0;
	for (let i = 0; i < v.length; i++) sum += Math.abs(v[i]!);
	const norm = sum || 1;
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
	return out;
}

// ── Matryoshka truncation ──
function matryoshkaTruncate(
	vec: Float32Array,
	targetDim: number,
): Float32Array {
	if (targetDim > vec.length) {
		throw new Error(`targetDim ${targetDim} > vector dim ${vec.length}`);
	}
	if (targetDim === vec.length) return vec;
	const out = new Float32Array(targetDim);
	let sum = 0;
	for (let i = 0; i < targetDim; i++) {
		const v = vec[i]!;
		out[i] = v;
		sum += v * v;
	}
	const norm = Math.sqrt(sum);
	if (norm === 0) return out;
	for (let i = 0; i < targetDim; i++) {
		out[i] = out[i]! / norm;
	}
	return out;
}

// ── NaN API call ──
async function nanEmbed(input: string | string[]): Promise<Float32Array[]> {
	const res = await fetch(`${NAN_BASE_URL}/embeddings`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${NAN_API_KEY}`,
		},
		body: JSON.stringify({
			model: NAN_MODEL,
			input,
		}),
	});

	if (!res.ok) {
		const txt = await res.text();
		throw new Error(
			`NaN embeddings failed ${res.status}: ${txt.slice(0, 500)}`,
		);
	}

	const data = (await res.json()) as {
		data: Array<{ embedding: number[] }>;
	};

	return data.data.map((d) => new Float32Array(d.embedding));
}

// ── Load pre-computed qwen3 store from DB ──
function loadFilteredStore(
	db: Database,
	modelKey: string,
	normIds: string[],
): {
	articles: Array<{ normId: string; blockId: string }>;
	vectors: Float32Array;
	norms: Float32Array;
	count: number;
	dimensions: number;
} | null {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) return null;
	const ph = normIds.map(() => "?").join(",");
	const rows = db
		.query<{ norm_id: string; block_id: string; vector: Buffer }, string[]>(
			`SELECT norm_id, block_id, vector
       FROM embeddings
       WHERE model = ? AND norm_id IN (${ph})
       ORDER BY norm_id, block_id`,
		)
		.all(modelKey, ...normIds);
	if (rows.length === 0) return null;

	const dims = model.dimensions;
	const count = rows.length;
	const articles: Array<{ normId: string; blockId: string }> = [];
	const vectors = new Float32Array(count * dims);
	const norms = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		const row = rows[i]!;
		articles.push({ normId: row.norm_id, blockId: row.block_id });
		const rv = new Float32Array(row.vector.buffer, row.vector.byteOffset, dims);
		vectors.set(rv, i * dims);
		let sum = 0;
		for (let j = 0; j < dims; j++) sum += rv[j]! * rv[j]!;
		norms[i] = Math.sqrt(sum);
	}
	return { model: modelKey, dimensions: dims, count, articles, vectors, norms };
}

// ── Main ──
async function main() {
	const args = parseArgs();
	const queryPrefixName = args["query-prefix"] ?? "instruct-en";
	const docFormat = args["doc-format"] ?? "prod";
	const mrlDim = Number(args["mrl-dim"] ?? 4096);
	const normalize = args.normalize ?? "l2";
	const queryStrategy = args["query-strategy"] ?? "single";

	if (!QUERY_PREFIXES[queryPrefixName]) {
		console.error(
			`Unknown query prefix: ${queryPrefixName}. Available: ${Object.keys(QUERY_PREFIXES).join(", ")}`,
		);
		process.exit(1);
	}

	const repoRoot = join(import.meta.dir, "../../../../");
	const dbPath = join(repoRoot, "data", "leyabierta.db");
	const evalPath = join(repoRoot, "data", "eval-answers-504-omnibus.json");
	const outDir = join(repoRoot, "data", "ab-results");
	await Bun.write(`${outDir}/.keep`, "");

	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	createSchema(db);

	// Load gold set
	interface EvalResult {
		id: number;
		question: string;
		expectedNorms?: string[];
	}
	const evalData = (await Bun.file(evalPath).json()) as {
		results: EvalResult[];
	};
	let questions = evalData.results.filter(
		(r) => (r.expectedNorms?.length ?? 0) > 0,
	);
	// Limit for fast tuning iterations
	const maxQuestions = Number(args["max-questions"] ?? 57);
	if (questions.length > maxQuestions) {
		// Stratified sample by expected norms count
		const byCount: Record<string, EvalResult[]> = {};
		for (const q of questions) {
			const k = (q.expectedNorms?.length ?? 0).toString();
			if (!byCount[k]) byCount[k] = [];
			byCount[k].push(q);
		}
		const keys = Object.keys(byCount);
		const shuffled = keys.sort(() => Math.random() - 0.5);
		let remaining = maxQuestions;
		const sample: EvalResult[] = [];
		for (const k of shuffled) {
			if (remaining <= 0) break;
			const qs = byCount[k];
			const take = Math.min(remaining, qs.length);
			const indices = new Set<number>();
			while (indices.size < take)
				indices.add(Math.floor(Math.random() * qs.length));
			for (const i of indices) sample.push(qs[i]!);
			remaining -= take;
		}
		questions = sample;
		console.error(
			`  Tuning sample: ${questions.length} questions (max=${maxQuestions})`,
		);
	}
	console.log(`Gold set: ${questions.length} questions`);
	process.stdout.write("\n");

	// Build corpus plan
	console.log("Building corpus plan...");
	const plan = await buildCorpusPlan(db);
	console.log(
		`  Corpus: ${plan.normIds.length} norms (${plan.counts.chunks} chunks)`,
	);

	// ── Load pre-computed qwen3 store from DB ──
	console.log("Loading pre-computed qwen3 store from DB...");
	const storeData = loadFilteredStore(db, "qwen3", plan.normIds);
	if (!storeData) {
		console.error("  ✗ No qwen3 embeddings found in DB for corpus norms.");
		console.error(
			"  Available models:",
			db.query<string>("SELECT DISTINCT model FROM embeddings").all(),
		);
		process.exit(1);
	}
	console.log(
		`  Loaded ${storeData.count} vectors (${storeData.dimensions} dims) from ${new Set(storeData.articles.map((a) => a.normId)).size} norms`,
	);

	// ── Detect NaN API output dim and align store to it ──
	// NaN API returns 2560-dim vectors for qwen3-embedding (truncated variant).
	// We need to truncate the pre-computed 4096-dim store to match.
	const NaN_OUTPUT_DIM = 2560;
	let searchVectors = storeData.vectors;
	let searchNorms = storeData.norms;
	const searchCount = storeData.count;
	let searchDim = storeData.dimensions;

	// Truncate store to NaN API output dim (2560) if needed
	if (searchDim > NaN_OUTPUT_DIM) {
		console.log(
			`  Truncating store from ${searchDim} to ${NaN_OUTPUT_DIM} (NaN API output dim)...`,
		);
		const newVectors = new Float32Array(searchCount * NaN_OUTPUT_DIM);
		const newNorms = new Float32Array(searchCount);
		for (let i = 0; i < searchCount; i++) {
			const srcOff = i * searchDim;
			let sum = 0;
			for (let j = 0; j < NaN_OUTPUT_DIM; j++) {
				const v = searchVectors[srcOff + j]!;
				newVectors[i * NaN_OUTPUT_DIM + j] = v;
				sum += v * v;
			}
			const n = Math.sqrt(sum);
			newNorms[i] = n;
			if (n > 0) {
				for (let j = 0; j < NaN_OUTPUT_DIM; j++) {
					newVectors[i * NaN_OUTPUT_DIM + j] =
						newVectors[i * NaN_OUTPUT_DIM + j]! / n;
				}
			}
		}
		searchVectors = newVectors;
		searchNorms = newNorms;
		searchDim = NaN_OUTPUT_DIM;
	}

	// Then apply additional MRL truncation if requested
	if (mrlDim < searchDim) {
		console.log(`  Further truncating store to MRL@${mrlDim}...`);
		const newVectors = new Float32Array(searchCount * mrlDim);
		const newNorms = new Float32Array(searchCount);
		for (let i = 0; i < searchCount; i++) {
			const srcOff = i * searchDim;
			let sum = 0;
			for (let j = 0; j < mrlDim; j++) {
				const v = searchVectors[srcOff + j]!;
				newVectors[i * mrlDim + j] = v;
				sum += v * v;
			}
			const n = Math.sqrt(sum);
			newNorms[i] = n;
			if (n > 0) {
				for (let j = 0; j < mrlDim; j++) {
					newVectors[i * mrlDim + j] = newVectors[i * mrlDim + j]! / n;
				}
			}
		}
		searchVectors = newVectors;
		searchNorms = newNorms;
		searchDim = mrlDim;
	}

	if (normalize === "l2") {
		// Already normalized if from DB (llama.cpp normalizes), but re-normalize to be safe
		console.log("  Re-normalizing store vectors (l2)...");
		for (let i = 0; i < searchCount; i++) {
			let sum = 0;
			for (let j = 0; j < searchDim; j++) {
				sum +=
					searchVectors[i * searchDim + j]! * searchVectors[i * searchDim + j]!;
			}
			const n = Math.sqrt(sum);
			if (n > 0) {
				for (let j = 0; j < searchDim; j++) {
					searchVectors[i * searchDim + j]! /= n;
				}
			}
			searchNorms[i] = 1.0;
		}
	}

	const store = {
		model: `qwen3-db`,
		dimensions: searchDim,
		count: searchCount,
		articles: storeData.articles,
		vectors: searchVectors,
		norms: searchNorms,
	};

	// ── Evaluate ──
	console.log(`Evaluating ${questions.length} queries...`);
	let hits1 = 0,
		hits5 = 0,
		hits10 = 0,
		hits60 = 0,
		mrrSum = 0;
	let latencySum = 0;

	const perQuestion: Array<{
		id: number;
		question: string;
		expectedNorms: string[];
		hitRank: number | null;
		topNorms: string[];
		latencyMs: number;
	}> = [];

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const expected = new Set(q.expectedNorms!);

		const t0 = Date.now();

		// Build query embedding
		let queryVec: Float32Array;
		if (queryStrategy === "split") {
			// Split query into keywords and average
			const words = q.question.split(/\s+/).filter((w) => w.length > 3);
			const vecs = await nanEmbed(words);
			const avg = new Float32Array(vecs[0]!.length);
			for (const v of vecs) {
				for (let k = 0; k < v.length; k++) avg[k]! += v[k]!;
			}
			for (let k = 0; k < avg.length; k++) avg[k]! /= vecs.length;
			queryVec = avg;
		} else {
			const prefixFn = QUERY_PREFIXES[queryPrefixName]!;
			const prefixed = prefixFn(q.question);
			const result = await nanEmbed(prefixed);
			queryVec = result[0]!;
		}

		// Truncate query to same MRL dim
		if (mrlDim < queryVec.length) {
			queryVec = matryoshkaTruncate(queryVec, mrlDim);
		}

		// Normalize query
		if (normalize === "l2") {
			queryVec = l2Normalize(queryVec);
		} else if (normalize === "l1") {
			queryVec = l1Normalize(queryVec);
		}

		const latency = Date.now() - t0;
		latencySum += latency;

		// Search
		const results = vectorSearch(queryVec, store, 60);

		let hitRank: number | null = null;
		for (let r = 0; r < results.length; r++) {
			if (expected.has(results[r]!.normId)) {
				hitRank = r + 1;
				break;
			}
		}

		if (hitRank) {
			if (hitRank <= 1) hits1++;
			if (hitRank <= 5) hits5++;
			if (hitRank <= 10) {
				hits10++;
				mrrSum += 1 / hitRank;
			}
			if (hitRank <= 60) hits60++;
		}

		const topNorms: string[] = [];
		const seen = new Set<string>();
		for (const r of results) {
			if (!seen.has(r.normId)) {
				seen.add(r.normId);
				topNorms.push(r.normId);
				if (topNorms.length >= 5) break;
			}
		}

		perQuestion.push({
			id: q.id,
			question: q.question,
			expectedNorms: q.expectedNorms!,
			hitRank,
			topNorms,
			latencyMs: latency,
		});

		if ((i + 1) % 10 === 0) {
			console.error(
				`  [${i + 1}/${questions.length}] R@1=${((hits1 / (i + 1)) * 100).toFixed(0)}% R@5=${((hits5 / (i + 1)) * 100).toFixed(0)}%`,
			);
		}
	}
	console.log("\n");

	const n = questions.length;
	const r1 = (hits1 / n) * 100;
	const r5 = (hits5 / n) * 100;
	const r10 = (hits10 / n) * 100;
	const r60 = (hits60 / n) * 100;
	const mrr = mrrSum / n;
	const gap = r1 - GEMINI_R1;

	// ── Output RESULT line ──
	console.log(
		`RESULT r1=${r1.toFixed(1)} r5=${r5.toFixed(1)} r10=${r10.toFixed(1)} r60=${r60.toFixed(1)} mrr=${mrr.toFixed(3)} gap=${gap.toFixed(1)} qprefix=${queryPrefixName} docfmt=${docFormat} mrl=${mrlDim} norm=${normalize} strategy=${queryStrategy}`,
	);

	// Also print summary table
	console.log(`\n=== Config Summary ===`);
	console.log(
		`  Query prefix: ${queryPrefixName}
  Doc format:   ${docFormat}
  MRL dim:      ${mrlDim}
  Normalize:    ${normalize}
  Strategy:     ${queryStrategy}

  R@1:  ${r1.toFixed(1)}%  (gap: ${gap.toFixed(1)}pp vs Gemini-2)
  R@5:  ${r5.toFixed(1)}%
  R@10: ${r10.toFixed(1)}%
  R@60: ${r60.toFixed(1)}%
  MRR@10: ${mrr.toFixed(3)}
  Avg latency: ${(latencySum / n).toFixed(0)}ms`,
	);

	// Save detailed results
	const outPath = `${outDir}/tune-${Date.now()}-${queryPrefixName}-${docFormat}-${mrlDim}.json`;
	await Bun.write(
		outPath,
		JSON.stringify(
			{
				config: {
					queryPrefix: queryPrefixName,
					docFormat,
					mrlDim,
					normalize,
					queryStrategy,
				},
				metrics: {
					r1: r1 / 100,
					r5: r5 / 100,
					r10: r10 / 100,
					r60: r60 / 100,
					mrr: mrr,
					gap: gap / 100,
					avgLatencyMs: latencySum / n,
				},
				perQuestion,
			},
			null,
			2,
		),
	);
	console.log(`\nDetailed results: ${outPath}`);

	db.close();
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
