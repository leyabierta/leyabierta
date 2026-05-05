#!/usr/bin/env node
/**
 * Fast tuning eval: uses pre-extracted corpus JSON directly.
 * No DB loading, no corpus plan — just embed + search.
 *
 * Writes RESULT directly to a file for reliability.
 * Uses process.stderr.write() for real-time progress.
 *
 * Usage:
 *   bun run fast-tune.ts --query-prefix=instruct-en --doc-format=prod --mrl-dim=4096 --normalize=l2
 */

const fs = require("node:fs");
const path = require("node:path");

const NAN_BASE_URL = "https://api.nan.builders/v1";
const NAN_API_KEY = process.env.NAN_API_KEY || "sk-1WqPsfFrl3YHyBg52xRvTg";
const NAN_MODEL = "qwen3-embedding";
const GEMINI_R1 = 96.5;
const REPO_ROOT = "/Users/alex/00_Programacion/01_Alex/leyabierta/leyabierta";

// ── Query prefix implementations ──
const QUERY_PREFIXES = {
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
	minimal: (q) => `Query: ${q}`,
};

// ── Document format ──
function formatDoc(block, format) {
	const parts = block.text.split("\n\n");
	const header = parts[0] || "";
	const body = parts[1] || block.rawText;
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
		case "title-body":
			return `Title: ${normTitle}\n\n${body}`;
		case "body-only":
			return body;
		default:
			return block.rawText;
	}
}

// ── Embedding ──
async function nanEmbed(texts) {
	const resp = await fetch(`${NAN_BASE_URL}/embeddings`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${NAN_API_KEY}`,
		},
		body: JSON.stringify({ model: NAN_MODEL, input: texts }),
	});
	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`NAN API error ${resp.status}: ${err}`);
	}
	const data = await resp.json();
	return data.data.map((d) => d.embedding);
}

// ── Matryoshka truncation ──
function matryoshkaTruncate(vec, dim) {
	if (vec.length <= dim) return vec;
	return vec.slice(0, dim);
}

// ── L2 normalization ──
function l2Normalize(vec) {
	let sum = 0;
	for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
	const norm = Math.sqrt(sum) || 1e-9;
	return vec.map((v) => v / norm);
}

// ── Cosine search (brute force) ──
function cosineSearch(queryVec, store, topK) {
	const { vectors, norms, articles, count, dim } = store;
	const scores = [];

	for (let i = 0; i < count; i++) {
		let dot = 0;
		for (let d = 0; d < dim; d++) {
			dot += queryVec[d] * vectors[i * dim + d];
		}
		const qNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0)) || 1e-9;
		const cosSim = dot / (qNorm * norms[i]);
		scores.push({ idx: i, score: cosSim, normId: articles[i].normId });
	}

	scores.sort((a, b) => b.score - a.score);
	return scores.slice(0, topK);
}

// ── Arg parser ──
function parseArgs() {
	const args = {};
	const raw = process.argv.slice(2);
	for (let i = 0; i < raw.length; i++) {
		if (raw[i].startsWith("--")) {
			const key = raw[i].slice(2);
			const next = raw[i + 1];
			if (next && !next.startsWith("--")) {
				args[key] = next;
				i++;
			} else {
				args[key] = true;
			}
		}
	}
	return args;
}

// ── Write result to file immediately ──
function writeResult(result) {
	const resultFile = path.join(
		REPO_ROOT,
		"data",
		"ab-results",
		`tune-${Date.now()}-${result.qprefix}-${result.docfmt}-${result.mrl}.json`,
	);
	const resultJson = {
		...result,
		timestamp: new Date().toISOString(),
	};
	fs.mkdirSync(path.dirname(resultFile), { recursive: true });
	fs.writeFileSync(resultFile, JSON.stringify(resultJson, null, 2));

	// Write a plain text RESULT line to a dedicated file
	const line = `RESULT r1=${result.r1.toFixed(1)} r5=${result.r5.toFixed(1)} r10=${result.r10.toFixed(1)} r60=${result.r60.toFixed(1)} mrr=${result.mrr.toFixed(3)} gap=${result.gap.toFixed(1)} qprefix=${result.qprefix} docfmt=${result.docfmt} mrl=${result.mrl} norm=${result.norm} strategy=${result.strategy}`;

	fs.writeFileSync(
		path.join(REPO_ROOT, "data", "ab-results", "latest-result.txt"),
		`${line}\n`,
	);

	// Also append to leaderboard
	const leaderboardPath = path.join(REPO_ROOT, "tune-leaderboard.jsonl");
	let iter = 1;
	if (fs.existsSync(leaderboardPath)) {
		const lines = fs.readFileSync(leaderboardPath, "utf8").trim().split("\n");
		iter = lines.length + 1;
	}
	const lbEntry = JSON.stringify({
		iteration: iter,
		...result,
		timestamp: new Date().toISOString(),
	});
	fs.appendFileSync(leaderboardPath, `${lbEntry}\n`);

	return { line, resultFile, leaderboardPath };
}

// ── Main ──
async function main() {
	const args = parseArgs();
	const queryPrefixName = args["query-prefix"] || "instruct-en";
	const docFormat = args["doc-format"] || "prod";
	const mrlDim = Number(args["mrl-dim"] || 4096);
	const normalize = args.normalize || "l2";
	const maxBlocks = Number(args["max-blocks"] || 50);
	const maxQuestions = Number(args["max-questions"] || 10);
	const strategy = args["query-strategy"] || "single";

	if (!QUERY_PREFIXES[queryPrefixName]) {
		process.stderr.write(
			`Unknown prefix: ${queryPrefixName}. Available: ${Object.keys(QUERY_PREFIXES).join(", ")}\n`,
		);
		process.exit(1);
	}

	// Load corpus
	const corpusPath = path.join(
		REPO_ROOT,
		"data",
		`corpus-tune-${maxBlocks}.json`,
	);
	process.stderr.write(`Loading corpus from ${corpusPath}...\n`);
	const corpusRaw = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
	const blocks = corpusRaw;
	process.stderr.write(`  Loaded ${blocks.length} blocks\n`);

	// Format and embed corpus
	process.stderr.write(
		`Embedding corpus (doc_format=${docFormat}, mrl=${mrlDim}, norm=${normalize})...\n`,
	);
	const BATCH = 32;
	const allVectors = [];
	const allArticles = [];
	const allNorms = [];
	const dim = mrlDim;

	for (let i = 0; i < blocks.length; i += BATCH) {
		const batch = blocks.slice(i, i + BATCH);
		const formatted = batch.map((b) => formatDoc(b, docFormat));
		const embeddings = await nanEmbed(formatted);

		for (let j = 0; j < embeddings.length; j++) {
			let vec = matryoshkaTruncate(embeddings[j], dim);
			if (normalize === "l2") vec = l2Normalize(vec);

			allVectors.push(vec);
			allArticles.push({ normId: batch[j].normId, blockId: batch[j].blockId });

			let sum = 0;
			for (let k = 0; k < dim; k++) sum += vec[k] * vec[k];
			allNorms.push(Math.sqrt(sum));
		}

		if ((i + BATCH) % 64 === 0 || i + BATCH >= blocks.length) {
			process.stderr.write(
				`  Embedded ${Math.min(i + BATCH, blocks.length)}/${blocks.length}\n`,
			);
		}
	}

	// Build search store
	const count = allVectors.length;
	const vectors = new Float32Array(count * dim);
	const norms = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		vectors.set(allVectors[i], i * dim);
		norms[i] = allNorms[i];
	}

	const store = { vectors, norms, articles: allArticles, count, dim };

	// Load gold set
	const evalData = JSON.parse(
		fs.readFileSync(
			path.join(REPO_ROOT, "data", "eval-answers-504-omnibus.json"),
			"utf8",
		),
	);
	let questions = evalData.results.filter(
		(r) => (r.expectedNorms?.length ?? 0) > 0,
	);
	if (questions.length > maxQuestions) {
		questions = questions
			.sort(() => Math.random() - 0.5)
			.slice(0, maxQuestions);
	}
	process.stderr.write(`Gold set: ${questions.length} questions\n`);

	// Evaluate
	process.stderr.write(`Evaluating queries...\n`);
	let hits1 = 0,
		hits5 = 0,
		hits10 = 0,
		hits60 = 0,
		mrrSum = 0;
	let latencySum = 0;

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const expected = new Set(q.expectedNorms);
		const t0 = Date.now();

		const prefixFn = QUERY_PREFIXES[queryPrefixName];
		const prefixed = prefixFn(q.question);
		const result = await nanEmbed(prefixed);
		let queryVec = matryoshkaTruncate(result[0], dim);
		if (normalize === "l2") queryVec = l2Normalize(queryVec);

		latencySum += Date.now() - t0;

		const results = cosineSearch(queryVec, store, 60);
		let hitRank = null;
		for (let r = 0; r < results.length; r++) {
			if (expected.has(results[r].normId)) {
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

		if ((i + 1) % 5 === 0) {
			process.stderr.write(
				`  [${i + 1}/${questions.length}] R@1=${((hits1 / (i + 1)) * 100).toFixed(1)}%\n`,
			);
		}
	}

	const n = questions.length;
	const r1 = (hits1 / n) * 100;
	const r5 = (hits5 / n) * 100;
	const r10 = (hits10 / n) * 100;
	const r60 = (hits60 / n) * 100;
	const mrr = mrrSum / n;
	const gap = r1 - GEMINI_R1;

	// Write result to file immediately
	const { line, resultFile } = writeResult({
		r1,
		r5,
		r10,
		r60,
		mrr,
		gap,
		qprefix: queryPrefixName,
		docfmt: docFormat,
		mrl: mrlDim,
		norm: normalize,
		strategy,
		latency_ms: Math.round(latencySum / n),
		blocks: maxBlocks,
		questions: n,
	});

	process.stderr.write(`RESULT: ${line}\n`);
	process.stderr.write(`Results saved to: ${resultFile}\n`);
}

main().catch((err) => {
	process.stderr.write(`FATAL: ${err.message}\n`);
	process.exit(1);
});
