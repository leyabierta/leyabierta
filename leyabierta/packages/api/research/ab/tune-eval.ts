/**
 * Tuning eval harness for Qwen3-Embedding-8B via NaN API.
 *
 * Corpus loaded from pre-extracted JSON. Embeddings cached in SQLite.
 * Uses a small corpus sample (1000 blocks) for fast tuning iterations.
 *
 * Usage:
 *   bun packages/api/research/ab/tune-eval.ts \
 *     --query-prefix=instruct-en \
 *     --doc-format=prod \
 *     --mrl-dim=4096 \
 *     --normalize=l2
 *
 * Outputs: RESULT r1=XX.X r5=XX.X ... gap=-XX.X prefix=...
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

const REPO_ROOT = "/Users/alex/00_Programacion/01_Alex/leyabierta/leyabierta";
const CORPUS_JSON = join(REPO_ROOT, "data", "corpus-tune-500.json");
const EVAL_JSON = join(REPO_ROOT, "data", "eval-answers-504-omnibus.json");
const CACHE_DIR = join(REPO_ROOT, "data", "tune-cache");
const OUT_DIR = join(REPO_ROOT, "data", "ab-results");

const NAN_BASE_URL = "https://api.nan.builders/v1";
const NAN_API_KEY = process.env.NAN_API_KEY ?? "sk-1WqPsfFrl3YHyBg52xRvTg";
const NAN_MODEL = "qwen3-embedding";
const NAN_BATCH_SIZE = 32;
const GEMINI_R1 = 96.5;

function flush() { try { process.stdout.write('\n'); } catch {} }

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

const QUERY_PREFIXES: Record<string, (q: string) => string> = {
  "instruct-en": (q) => `Instruct: Given a Spanish citizen's legal question, retrieve the article of Spanish law that best answers it.\nQuery: ${q}`,
  "instruct-es": (q) => `Instruct: Dada una pregunta legal de un ciudadano español, recupera el artículo de la ley española que mejor la responde.\nConsulta: ${q}`,
  "short-en": (q) => `Retrieve Spanish legal article for: ${q}`,
  "short-es": (q) => `Recupera artículo de ley española para: ${q}`,
  none: (q) => q,
  "keyword-en": (q) => `Given a Spanish legal question, find the relevant article of Spanish law.\nQuery: ${q}`,
  "keyword-es": (q) => `Dada una pregunta legal en español, encuentra el artículo relevante de la ley española.\nConsulta: ${q}`,
  "qa-en": (q) => `Answer the following legal question using Spanish law.\nQuestion: ${q}`,
  "qa-es": (q) => `Responde la siguiente pregunta legal usando la ley española.\nPregunta: ${q}`,
  "search-en": (q) => `Search for the Spanish law article that answers this question:\nQuery: ${q}`,
  "search-es": (q) => `Buscar el artículo de ley española que responda a esta pregunta:\nConsulta: ${q}`,
  minimal: (q) => `Query: ${q}`,
  "instruct-long-en": (q) => `You are a legal research assistant for Spanish citizens. Given a plain-language legal question in Spanish or English, retrieve the most relevant article or section of Spanish law that directly answers the question. Consider current, vigente law. Think about the subject matter (materia), the type of legal relationship, and the specific rights or obligations mentioned.\nQuery: ${q}`,
  "instruct-long-es": (q) => `Eres un asistente de investigación legal para ciudadanos españoles. Dada una pregunta legal en lenguaje claro, en español o inglés, recupera el artículo o sección más relevante de la ley española que responda directamente a la pregunta. Considera la ley vigente. Piensa en la materia, el tipo de relación legal y los derechos u obligaciones específicos mencionados.\nConsulta: ${q}`,
};

interface CorpusBlock {
  normId: string;
  blockId: string;
  parentBlockId: string;
  text: string;
  rawText: string;
}

function formatDoc(block: CorpusBlock, format: string): string {
  const parts = block.text.split("\n\n");
  const header = parts[0] || "";
  const body = parts[1] || block.rawText;
  const normTitleMatch = header.match(/title:\s*(.+?)\s*\|/);
  const normTitle = normTitleMatch ? normTitleMatch[1].trim() : block.normId;
  switch (format) {
    case "prod": return `title: ${normTitle} | text: ${block.blockId}\n\n${body}`;
    case "raw": return block.rawText;
    case "title-only": return `title: ${normTitle}\n\n${body}`;
    case "no-title": return `text: ${block.blockId}\n\n${body}`;
    case "full-meta": return `Title: ${normTitle}\nArticle: ${block.blockId}\n\n${body}`;
    case "spanish-labels": return `título: ${normTitle} | texto: ${block.blockId}\n\n${body}`;
    case "yaml-front": return `---\nnorm: ${normTitle}\narticle: ${block.blockId}\n---\n\n${body}`;
    case "doc-prefix": return `Document: ${normTitle}\nSection: ${block.blockId}\n\n${body}`;
    default: return block.text;
  }
}

function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

function l1Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += Math.abs(v[i]!);
  const norm = sum || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

function matryoshkaTruncate(vec: Float32Array, targetDim: number): Float32Array {
  if (targetDim > vec.length) throw new Error(`targetDim ${targetDim} > vector dim ${vec.length}`);
  if (targetDim === vec.length) return vec;
  const out = new Float32Array(targetDim);
  let sum = 0;
  for (let i = 0; i < targetDim; i++) { const v = vec[i]!; out[i] = v; sum += v * v; }
  const norm = Math.sqrt(sum);
  if (norm === 0) return out;
  for (let i = 0; i < targetDim; i++) out[i] = out[i]! / norm;
  return out;
}

async function nanEmbed(input: string | string[]): Promise<Float32Array[]> {
  const res = await fetch(`${NAN_BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${NAN_API_KEY}` },
    body: JSON.stringify({ model: NAN_MODEL, input }),
  });
  if (!res.ok) { const txt = await res.text(); throw new Error(`NaN embeddings failed ${res.status}: ${txt.slice(0, 500)}`); }
  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => new Float32Array(d.embedding));
}

interface CacheEntry {
  docFormat: string; mrlDim: number; normalize: string;
  count: number; articles: { normId: string; blockId: string }[];
  vectors: Float32Array; norms: Float32Array;
}

async function loadOrBuildCache(
  corpus: CorpusBlock[], docFormat: string, mrlDim: number, normalize: string,
): Promise<CacheEntry> {
  const cacheKey = `${docFormat}-${mrlDim}-${normalize}-${corpus.length}`;
  const cachePath = join(CACHE_DIR, `corpus-${cacheKey}.db`);

  if (await Bun.file(cachePath).exists()) {
    console.log(`Loading corpus cache: ${cacheKey}`);
    const db = new Database(cachePath);
    const cntRow = db.query("SELECT COUNT(*) as cnt FROM vectors").get() as { cnt: number };
    const dimRow = db.query("SELECT LENGTH(vec)/4 as dim FROM vectors LIMIT 1").get() as { dim: number };
    const count = cntRow.cnt;
    const dim = dimRow.dim;
    const rows = db.query<{ vec: number[] }>("SELECT vec FROM vectors").all();
    const vectors = new Float32Array(count * dim);
    const norms = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const v = new Float32Array(rows[i]!.vec);
      vectors.set(v, i * dim);
      let sum = 0;
      for (let k = 0; k < dim; k++) sum += v[k]! * v[k]!;
      norms[i] = Math.sqrt(sum);
    }
    const articles = db.query<{ norm_id: string; block_id: string }>("SELECT norm_id, block_id FROM articles").all();
    db.close();
    console.log(`  Cache hit: ${count} vectors, dim=${dim}`);
    return { docFormat, mrlDim, normalize, count, articles: articles.map((r) => ({ normId: r.norm_id, blockId: r.block_id })), vectors, norms };
  }

  console.log(`Building corpus cache: ${cacheKey}...`);
  await Bun.write(`${OUT_DIR}/.keep`, "");
  const blocks = corpus.map((b) => ({ ...b }));

  console.log(`  Embedding ${blocks.length} blocks with doc_format=${docFormat}...`);
  const allVectors: Float32Array[] = [];
  const allArticles: { normId: string; blockId: string }[] = [];
  const allNorms: number[] = [];

  for (let i = 0; i < blocks.length; i += NAN_BATCH_SIZE) {
    const batch = blocks.slice(i, i + NAN_BATCH_SIZE);
    const formatted = batch.map((b) => formatDoc(b, docFormat));
    const embeddings = await nanEmbed(formatted);
    for (let j = 0; j < embeddings.length; j++) {
      let vec = embeddings[j]!;
      if (mrlDim < vec.length) vec = matryoshkaTruncate(vec, mrlDim);
      if (normalize === "l2") vec = l2Normalize(vec);
      else if (normalize === "l1") vec = l1Normalize(vec);
      allVectors.push(vec);
      allArticles.push({ normId: batch[j]!.normId, blockId: batch[j]!.blockId });
      let sum = 0;
      for (let k = 0; k < vec.length; k++) sum += vec[k]! * vec[k]!;
      allNorms.push(Math.sqrt(sum));
    }
    if ((i + NAN_BATCH_SIZE) % 256 === 0 || i + NAN_BATCH_SIZE >= blocks.length) {
      process.stdout.write(`\r  Embedded ${Math.min(i + NAN_BATCH_SIZE, blocks.length)}/${blocks.length}`);
    }
  }
  console.log("\n");

  const dim = allVectors[0]!.length;
  const count = allVectors.length;
  const vectors = new Float32Array(count * dim);
  const norms = new Float32Array(count);
  for (let i = 0; i < count; i++) { vectors.set(allVectors[i]!, i * dim); norms[i] = allNorms[i]!; }

  console.log(`  Saving cache to ${cachePath}...`);
  const cacheDb = new Database(cachePath);
  cacheDb.exec(`CREATE TABLE IF NOT EXISTS vectors (id INTEGER PRIMARY KEY, vec BLOB);
    CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY, norm_id TEXT, block_id TEXT);`);
  const insertVec = cacheDb.prepare("INSERT INTO vectors (id, vec) VALUES (?, ?)");
  const insertArt = cacheDb.prepare("INSERT INTO articles (id, norm_id, block_id) VALUES (?, ?, ?)");
  for (let i = 0; i < count; i++) {
    insertVec.run(i, JSON.stringify(Array.from(vectors.subarray(i * dim, (i + 1) * dim))));
    insertArt.run(i, allArticles[i]!.normId, allArticles[i]!.blockId);
  }
  cacheDb.close();
  return { docFormat, mrlDim, normalize, count, articles: allArticles, vectors, norms };
}

function cosineSearch(
  query: Float32Array, vectors: Float32Array, norms: Float32Array,
  articles: { normId: string; blockId: string }[], topK: number,
): { normId: string; blockId: string; score: number }[] {
  const dim = query.length;
  const count = norms.length;
  const qNorm = Math.sqrt(query.reduce((s: number, v: number) => s + v * v, 0));
  const scores: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    let dot = 0;
    for (let k = 0; k < dim; k++) dot += query[k]! * vectors[i * dim + k]!;
    scores[i] = dot / (qNorm * norms[i] + 1e-10);
  }
  const indices = Array.from({ length: count }, (_, i) => i);
  indices.sort((a, b) => scores[b]! - scores[a]!);
  const results: { normId: string; blockId: string; score: number }[] = [];
  for (let i = 0; i < Math.min(topK, indices.length); i++) {
    const idx = indices[i]!;
    results.push({ normId: articles[idx]!.normId, blockId: articles[idx]!.blockId, score: scores[idx]! });
  }
  return results;
}

async function main() {
  const args = parseArgs();
  const queryPrefixName = args["query-prefix"] ?? "instruct-en";
  const docFormat = args["doc-format"] ?? "prod";
  const mrlDim = Number(args["mrl-dim"] ?? 4096);
  const normalize = args["normalize"] ?? "l2";
  const queryStrategy = args["query-strategy"] ?? "single";
  const maxQuestions = Number(args["max-questions"] ?? 5);

  if (!QUERY_PREFIXES[queryPrefixName]) {
    console.error(`Unknown query prefix: ${queryPrefixName}. Available: ${Object.keys(QUERY_PREFIXES).join(", ")}`);
    process.exit(1);
  }

  console.log(`Loading corpus from ${CORPUS_JSON}...`);
  const corpus = (await Bun.file(CORPUS_JSON).json()) as CorpusBlock[];
  console.log(`  Loaded ${corpus.length} blocks`);

  const cache = await loadOrBuildCache(corpus, docFormat, mrlDim, normalize);

  console.log(`Loading gold set from ${EVAL_JSON}...`);
  interface EvalResult { id: number; question: string; expectedNorms?: string[]; }
  const evalData = (await Bun.file(EVAL_JSON).json()) as { results: EvalResult[] };
  let questions = evalData.results.filter((r) => (r.expectedNorms?.length ?? 0) > 0);
  questions = questions.slice(0, maxQuestions);
  console.log(`  Gold set: ${questions.length} questions (max=${maxQuestions})`);

  console.log(`Evaluating (query_prefix=${queryPrefixName}, strategy=${queryStrategy})...`);
  let hits1 = 0, hits5 = 0, hits10 = 0, hits60 = 0, mrrSum = 0;
  let latencySum = 0;
  const perQuestion: { id: number; question: string; expectedNorms: string[]; hitRank: number | null; topNorms: string[]; latencyMs: number }[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const expected = new Set(q.expectedNorms!);
    const t0 = Date.now();

    let queryVec: Float32Array;
    if (queryStrategy === "split") {
      const words = q.question.split(/\s+/).filter((w) => w.length > 3);
      const vecs = await nanEmbed(words);
      const avg = new Float32Array(vecs[0]!.length);
      for (const v of vecs) for (let k = 0; k < v.length; k++) avg[k]! += v[k]!;
      for (let k = 0; k < avg.length; k++) avg[k]! /= vecs.length;
      queryVec = avg;
    } else {
      const prefixFn = QUERY_PREFIXES[queryPrefixName]!;
      const prefixed = prefixFn(q.question);
      const result = await nanEmbed(prefixed);
      queryVec = result[0]!;
    }

    if (mrlDim < queryVec.length) queryVec = matryoshkaTruncate(queryVec, mrlDim);
    if (normalize === "l2") queryVec = l2Normalize(queryVec);
    else if (normalize === "l1") queryVec = l1Normalize(queryVec);

    const latency = Date.now() - t0;
    latencySum += latency;
    const results = cosineSearch(queryVec, cache.vectors, cache.norms, cache.articles, 60);

    let hitRank: number | null = null;
    for (let r = 0; r < results.length; r++) { if (expected.has(results[r]!.normId)) { hitRank = r + 1; break; } }
    if (hitRank) {
      if (hitRank <= 1) hits1++;
      if (hitRank <= 5) hits5++;
      if (hitRank <= 10) { hits10++; mrrSum += 1 / hitRank; }
      if (hitRank <= 60) hits60++;
    }

    const topNorms: string[] = [];
    const seen = new Set<string>();
    for (const r of results) { if (!seen.has(r.normId)) { seen.add(r.normId); topNorms.push(r.normId); if (topNorms.length >= 5) break; } }

    perQuestion.push({ id: q.id, question: q.question, expectedNorms: q.expectedNorms!, hitRank, topNorms, latencyMs: latency });
    if ((i + 1) % 50 === 0) process.stdout.write(`\r  [${i + 1}/${questions.length}] R@1=${((hits1 / (i + 1)) * 100).toFixed(1)}% R@5=${((hits5 / (i + 1)) * 100).toFixed(1)}%`);
  }
  console.log("\n");

  const n = questions.length;
  const r1 = (hits1 / n) * 100;
  const r5 = (hits5 / n) * 100;
  const r10 = (hits10 / n) * 100;
  const r60 = (hits60 / n) * 100;
  const mrr = mrrSum / n;
  const gap = r1 - GEMINI_R1;

  console.log(`RESULT r1=${r1.toFixed(1)} r5=${r5.toFixed(1)} r10=${r10.toFixed(1)} r60=${r60.toFixed(1)} mrr=${mrr.toFixed(3)} gap=${gap.toFixed(1)} qprefix=${queryPrefixName} docfmt=${docFormat} mrl=${mrlDim} norm=${normalize} strategy=${queryStrategy}`);

  console.log(`\n=== Config Summary ===`);
  console.log(`  Query prefix: ${queryPrefixName}\n  Doc format:   ${docFormat}\n  MRL dim:      ${mrlDim}\n  Normalize:    ${normalize}\n  Strategy:     ${queryStrategy}\n\n  R@1:  ${r1.toFixed(1)}%  (gap: ${gap.toFixed(1)}pp vs Gemini-2)\n  R@5:  ${r5.toFixed(1)}%\n  R@10: ${r10.toFixed(1)}%\n  R@60: ${r60.toFixed(1)}%\n  MRR@10: ${mrr.toFixed(3)}\n  Avg latency: ${(latencySum / n).toFixed(0)}ms`);

  const outPath = `${OUT_DIR}/tune-${Date.now()}-${queryPrefixName}-${docFormat}-${mrlDim}.json`;
  await Bun.write(outPath, JSON.stringify({
    config: { queryPrefix: queryPrefixName, docFormat, mrlDim, normalize, queryStrategy },
    metrics: { r1: r1 / 100, r5: r5 / 100, r10: r10 / 100, r60: r60 / 100, mrr, gap: gap / 100, avgLatencyMs: latencySum / n },
    perQuestion,
  }, null, 2));
  console.log(`\nDetailed results: ${outPath}`);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
