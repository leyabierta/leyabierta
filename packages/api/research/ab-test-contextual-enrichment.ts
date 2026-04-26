/**
 * A/B test: Contextual Retrieval enrichment — score comparison.
 *
 * Compares cosine similarity between citizen queries and target articles,
 * with and without citizen-language context prepended to the article text.
 *
 * Does NOT modify any files on disk. Pure in-memory comparison.
 *
 * Usage: bun run packages/api/research/ab-test-contextual-enrichment.ts
 */

import { Database } from "bun:sqlite";
import {
	EMBEDDING_MODELS,
	fetchWithRetry,
} from "../src/services/rag/embeddings.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";
const MODEL_KEY = "gemini-embedding-2";
const model = EMBEDDING_MODELS[MODEL_KEY]!;
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
	console.error("OPENROUTER_API_KEY required");
	process.exit(1);
}

const db = new Database(DB_PATH);

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		normA += a[i]! * a[i]!;
		normB += b[i]! * b[i]!;
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Enrichment definitions ──
const ENRICHMENTS: Array<{
	normId: string;
	blockId: string;
	context: string;
	desc: string;
}> = [
	{
		normId: "BOE-A-2015-11430",
		blockId: "a48",
		context:
			"Términos ciudadanos: baja por paternidad, baja por maternidad, permiso parental, permiso por nacimiento de hijo, baja por parto, cuántas semanas de baja, 19 semanas, 16 semanas, permiso del padre, permiso de la madre.",
		desc: "ET art.48 (paternidad)",
	},
	{
		normId: "BOE-A-2015-11430",
		blockId: "a20",
		context:
			"Términos ciudadanos: test de drogas en el trabajo, reconocimiento médico obligatorio, puede mi empresa hacerme análisis, vigilancia de la salud, control médico del trabajador, pruebas médicas en el trabajo.",
		desc: "ET art.20 (test drogas)",
	},
	{
		normId: "BOE-A-1978-31229",
		blockId: "a18",
		context:
			"Términos ciudadanos: pueden mirar mi móvil, pueden registrar mi casa, pueden entrar en mi piso, pueden leer mis mensajes, privacidad del teléfono, registro del domicilio, secreto de comunicaciones, puede la policía registrarme.",
		desc: "CE art.18 (inviolabilidad)",
	},
	{
		normId: "BOE-A-2015-11724",
		blockId: "a327",
		context:
			"Términos ciudadanos: paro de autónomo, cese de actividad, prestación por dejar de ser autónomo, desempleo para autónomos, cuánto cobra un autónomo de paro, puedo cobrar paro siendo autónomo.",
		desc: "LGSS art.327 (cese actividad)",
	},
	{
		normId: "BOE-A-2015-11430",
		blockId: "a45",
		context:
			"Términos ciudadanos: derechos embarazada trabajo, protección embarazo, riesgo embarazo trabajo, baja por embarazo, pueden echar a una embarazada, suspensión contrato embarazo.",
		desc: "ET art.45 (embarazo)",
	},
	{
		normId: "BOE-A-1994-26003",
		blockId: "a7",
		context:
			"Términos ciudadanos: derechos del inquilino, puede mi casero entrar en mi piso, derechos como arrendatario, condiciones del alquiler, casero sin permiso.",
		desc: "LAU art.7 (arrendatario)",
	},
];

// ── Test questions ──
const QUESTIONS: Array<{
	id: string;
	question: string;
	targetArticles: Array<{ normId: string; blockId: string }>;
}> = [
	{
		id: "Q2",
		question: "¿Cuánto dura la baja por paternidad?",
		targetArticles: [{ normId: "BOE-A-2015-11430", blockId: "a48" }],
	},
	{
		id: "Q808",
		question: "¿Me pueden obligar a hacerme un test de drogas en el trabajo?",
		targetArticles: [{ normId: "BOE-A-2015-11430", blockId: "a20" }],
	},
	{
		id: "Q13",
		question: "¿Puede la policía registrar mi móvil?",
		targetArticles: [{ normId: "BOE-A-1978-31229", blockId: "a18" }],
	},
	{
		id: "Q10",
		question: "¿Puedo cobrar el paro si soy autónomo?",
		targetArticles: [{ normId: "BOE-A-2015-11724", blockId: "a327" }],
	},
	{
		id: "Q11",
		question: "¿Qué derechos tiene una embarazada en el trabajo?",
		targetArticles: [{ normId: "BOE-A-2015-11430", blockId: "a45" }],
	},
	{
		id: "Q304",
		question: "¿Puede mi casero entrar en mi piso sin permiso?",
		targetArticles: [
			{ normId: "BOE-A-1978-31229", blockId: "a18" },
			{ normId: "BOE-A-1994-26003", blockId: "a7" },
		],
	},
];

// ── Step 1: Get article texts ──
console.log("=== Step 1: Preparing article texts ===\n");

type ArticleText = {
	normId: string;
	blockId: string;
	originalText: string;
	enrichedText: string;
	desc: string;
};

const articles: ArticleText[] = [];

for (const e of ENRICHMENTS) {
	const row = db
		.query<
			{
				norm_title: string;
				title: string;
				current_text: string;
			},
			[string, string]
		>(
			`SELECT n.title as norm_title, b.title, b.current_text
		 FROM blocks b JOIN norms n ON b.norm_id = n.id
		 WHERE b.norm_id = ? AND b.block_id = ?`,
		)
		.get(e.normId, e.blockId);

	if (!row) {
		console.log(`  ✗ ${e.desc} — not found`);
		continue;
	}

	// Use the main article (not sub-chunks) for a cleaner comparison
	const original = `title: ${row.norm_title} | text: ${row.title}\n\n${row.current_text}`;
	const enriched = `title: ${row.norm_title} | text: ${row.title}\n\n[${e.context}]\n\n${row.current_text}`;

	articles.push({
		normId: e.normId,
		blockId: e.blockId,
		originalText: original.slice(0, 24000),
		enrichedText: enriched.slice(0, 24000),
		desc: e.desc,
	});

	console.log(`  ✓ ${e.desc} (${row.current_text.length} chars)`);
}

// ── Step 2: Generate embeddings ──
console.log("\n=== Step 2: Generating embeddings ===\n");

// Embed all query texts
const queryTexts = QUESTIONS.map(
	(q) => `task: question answering | query: ${q.question}`,
);
console.log(`  Embedding ${queryTexts.length} queries...`);
const queryResp = await fetchWithRetry(apiKey, model.id, queryTexts);
const queryData = (await queryResp.json()) as {
	data: Array<{ embedding: number[] }>;
};
const queryEmbeddings = queryData.data.map(
	(d) => new Float32Array(d.embedding),
);

// Embed original article texts
const originalTexts = articles.map((a) => a.originalText);
console.log(`  Embedding ${originalTexts.length} original articles...`);
const origResp = await fetchWithRetry(apiKey, model.id, originalTexts);
const origData = (await origResp.json()) as {
	data: Array<{ embedding: number[] }>;
};
const originalEmbeddings = origData.data.map(
	(d) => new Float32Array(d.embedding),
);

// Embed enriched article texts
const enrichedTexts = articles.map((a) => a.enrichedText);
console.log(`  Embedding ${enrichedTexts.length} enriched articles...`);
const enrichResp = await fetchWithRetry(apiKey, model.id, enrichedTexts);
const enrichData = (await enrichResp.json()) as {
	data: Array<{ embedding: number[] }>;
};
const enrichedEmbeddings = enrichData.data.map(
	(d) => new Float32Array(d.embedding),
);

// ── Step 3: Compare scores ──
console.log("\n=== Step 3: Cosine similarity comparison ===\n");

console.log(
	"Question".padEnd(50) +
		"Article".padEnd(30) +
		"Original".padEnd(12) +
		"Enriched".padEnd(12) +
		"Delta",
);
console.log("-".repeat(120));

let totalOriginal = 0;
let totalEnriched = 0;
let comparisons = 0;

for (let qi = 0; qi < QUESTIONS.length; qi++) {
	const q = QUESTIONS[qi]!;
	const qEmb = queryEmbeddings[qi]!;

	for (const target of q.targetArticles) {
		const artIdx = articles.findIndex(
			(a) => a.normId === target.normId && a.blockId === target.blockId,
		);
		if (artIdx === -1) {
			console.log(
				`${`  ${q.question.slice(0, 48).padEnd(50)}${target.normId}:${target.blockId}`.padEnd(
					80,
				)}  NOT FOUND`,
			);
			continue;
		}

		const origScore = cosineSimilarity(qEmb, originalEmbeddings[artIdx]!);
		const enrichScore = cosineSimilarity(qEmb, enrichedEmbeddings[artIdx]!);
		const delta = enrichScore - origScore;

		totalOriginal += origScore;
		totalEnriched += enrichScore;
		comparisons++;

		const deltaStr = delta > 0 ? `+${delta.toFixed(4)}` : delta.toFixed(4);
		const indicator = delta > 0.01 ? " ✓" : delta < -0.01 ? " ✗" : "";

		console.log(
			`${q.id} ${q.question.slice(0, 45).padEnd(47)}${articles[artIdx]!.desc.padEnd(30)}${origScore.toFixed(4).padEnd(12)}${enrichScore.toFixed(4).padEnd(12)}${deltaStr}${indicator}`,
		);
	}
}

console.log("-".repeat(120));
console.log(
	`${"AVERAGE".padEnd(80)}${(totalOriginal / comparisons).toFixed(4).padEnd(12)}${(totalEnriched / comparisons).toFixed(4).padEnd(12)}${(totalEnriched - totalOriginal) / comparisons > 0 ? "+" : ""}${((totalEnriched - totalOriginal) / comparisons).toFixed(4)}`,
);

console.log("\nDone. No files were modified.");
