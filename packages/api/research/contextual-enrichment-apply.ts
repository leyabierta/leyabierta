/**
 * Apply contextual enrichment to target articles in SQLite embedding store.
 *
 * 1. Backs up vectors.bin → vectors.bin.bak, vectors.meta.jsonl ��� vectors.meta.jsonl.bak
 * 2. Saves original embeddings to data/enrichment-backup.json
 * 3. Re-embeds target articles with citizen-language context prepended
 * 4. Updates SQLite embeddings table
 * 5. On next API restart, ensureVectorIndex() re-exports from SQLite
 *
 * Restore with: bun run packages/api/research/contextual-enrichment-restore.ts
 */

import { Database } from "bun:sqlite";
import {
	EMBEDDING_MODELS,
	fetchWithRetry,
} from "../src/services/rag/embeddings.ts";
import { splitByApartados } from "../src/services/rag/subchunk.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";
const DATA_DIR = process.env.VECTORS_DIR ?? "./data";
const MODEL_KEY = "gemini-embedding-2";
const model = EMBEDDING_MODELS[MODEL_KEY]!;
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
	console.error("OPENROUTER_API_KEY required");
	process.exit(1);
}

const db = new Database(DB_PATH);

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
		normId: "BOE-A-2015-11724",
		blockId: "a328",
		context:
			"Términos ciudadanos: requisitos para cobrar paro autónomo, cese de actividad requisitos, qué necesito para paro autónomo.",
		desc: "LGSS art.328 (requisitos cese)",
	},
	{
		normId: "BOE-A-2015-11724",
		blockId: "a329",
		context:
			"Términos ciudadanos: cuánto dura el paro de autónomo, duración prestación autónomo, cuántos meses de paro autónomo.",
		desc: "LGSS art.329 (duración cese)",
	},
	{
		normId: "BOE-A-2015-11724",
		blockId: "a330",
		context:
			"Términos ciudadanos: cuánto cobra un autónomo de paro, cuantía prestación autónomo, cuánto dinero de paro autónomo.",
		desc: "LGSS art.330 (cuantía cese)",
	},
	{
		normId: "BOE-A-2015-11430",
		blockId: "a45",
		context:
			"Términos ciudadanos: derechos embarazada trabajo, protección embarazo, riesgo embarazo trabajo, baja por embarazo, pueden echar a una embarazada, suspensión contrato embarazo.",
		desc: "ET art.45 (embarazo)",
	},
	{
		normId: "BOE-A-2015-11430",
		blockId: "a53",
		context:
			"Términos ciudadanos: despido embarazada, pueden echar a una embarazada, nulidad despido embarazada, protección maternidad despido.",
		desc: "ET art.53 (despido embarazada)",
	},
	{
		normId: "BOE-A-2015-11430",
		blockId: "a55",
		context:
			"Términos ciudadanos: despido nulo embarazada, derechos embarazada despido, nulidad despido por embarazo, despido improcedente embarazada.",
		desc: "ET art.55 (despido nulo)",
	},
	{
		normId: "BOE-A-1994-26003",
		blockId: "a7",
		context:
			"Términos ciudadanos: derechos del inquilino, puede mi casero entrar en mi piso, derechos como arrendatario, condiciones del alquiler, casero sin permiso.",
		desc: "LAU art.7 (arrendatario)",
	},
	{
		normId: "BOE-A-2007-13409",
		blockId: "a33",
		context:
			"Términos ciudadanos: paro siendo autónomo, cobrar paro autónomo, compatibilizar paro con autónomo, prestación desempleo autónomo.",
		desc: "LETA art.33 (paro autónomo)",
	},
];

// ── Step 1: Check backup doesn't already exist ──
const backupPath = `${DATA_DIR}/enrichment-backup.json`;
if (await Bun.file(backupPath).exists()) {
	console.error(
		`Backup already exists at ${backupPath}. Run contextual-enrichment-restore.ts first.`,
	);
	process.exit(1);
}

// ── Step 2: Find all sub-chunks to update ──
console.log("=== Finding target embeddings ===\n");

type TargetChunk = {
	normId: string;
	blockId: string;
	enrichment: string;
};

const targetChunks: TargetChunk[] = [];

for (const e of ENRICHMENTS) {
	const chunks = db
		.query<
			{ norm_id: string; block_id: string },
			[string, string, string]
		>(
			"SELECT norm_id, block_id FROM embeddings WHERE norm_id = ? AND block_id LIKE ? AND model = ?",
		)
		.all(e.normId, `${e.blockId}%`, MODEL_KEY);

	for (const c of chunks) {
		targetChunks.push({
			normId: c.norm_id,
			blockId: c.block_id,
			enrichment: e.context,
		});
	}
	console.log(
		`  ${e.desc}: ${chunks.length} chunks`,
	);
}

console.log(`\nTotal: ${targetChunks.length} chunks to re-embed\n`);

// ── Step 3: Back up original embeddings ──
console.log("=== Backing up original embeddings ===\n");

const backupData: Array<{
	normId: string;
	blockId: string;
	vector: number[];
}> = [];

for (const tc of targetChunks) {
	const row = db
		.query<{ vector: Buffer }, [string, string, string]>(
			"SELECT vector FROM embeddings WHERE norm_id = ? AND block_id = ? AND model = ?",
		)
		.get(tc.normId, tc.blockId, MODEL_KEY);

	if (row) {
		const f32 = new Float32Array(
			row.vector.buffer,
			row.vector.byteOffset,
			model.dimensions,
		);
		backupData.push({
			normId: tc.normId,
			blockId: tc.blockId,
			vector: Array.from(f32),
		});
	}
}

// ── Step 4: Rename vectors.bin → vectors.bin.bak ──
console.log("=== Renaming vector files to .bak ===\n");

const vecBin = `${DATA_DIR}/vectors.bin`;
const vecMeta = `${DATA_DIR}/vectors.meta.jsonl`;
const fs = require("fs");

if (fs.existsSync(vecBin)) {
	fs.renameSync(vecBin, `${vecBin}.bak`);
	console.log(`  ${vecBin} → ${vecBin}.bak`);
}
if (fs.existsSync(vecMeta)) {
	fs.renameSync(vecMeta, `${vecMeta}.bak`);
	console.log(`  ${vecMeta} → ${vecMeta}.bak`);
}

// ── Step 5: Generate enriched embeddings ──
console.log("\n=== Generating enriched embeddings ===\n");

// Prepare enriched texts (same format as sync-embeddings.ts)
const enrichedTexts: Array<{
	normId: string;
	blockId: string;
	text: string;
}> = [];

for (const e of ENRICHMENTS) {
	const article = db
		.query<
			{
				norm_title: string;
				block_id: string;
				title: string;
				current_text: string;
			},
			[string, string]
		>(
			`SELECT n.title as norm_title, b.block_id, b.title, b.current_text
		 FROM blocks b JOIN norms n ON b.norm_id = n.id
		 WHERE b.norm_id = ? AND b.block_id = ?`,
		)
		.get(e.normId, e.blockId);

	if (!article) continue;

	const chunks = splitByApartados(
		article.block_id,
		article.title,
		article.current_text,
	);

	if (chunks) {
		for (const chunk of chunks) {
			enrichedTexts.push({
				normId: e.normId,
				blockId: chunk.blockId,
				text: `title: ${article.norm_title} | text: ${chunk.title}\n\n[${e.context}]\n\n${chunk.text}`,
			});
		}
	} else {
		enrichedTexts.push({
			normId: e.normId,
			blockId: article.block_id,
			text: `title: ${article.norm_title} | text: ${article.title}\n\n[${e.context}]\n\n${article.current_text}`,
		});
	}
}

console.log(`  Prepared ${enrichedTexts.length} enriched texts`);

// Generate embeddings
const BATCH_SIZE = 50;
const newEmbeddings: Map<string, Float32Array> = new Map();

for (let i = 0; i < enrichedTexts.length; i += BATCH_SIZE) {
	const batch = enrichedTexts.slice(i, i + BATCH_SIZE);
	const texts = batch.map((b) => b.text.slice(0, 24000));

	const response = await fetchWithRetry(apiKey, model.id, texts);
	const data = (await response.json()) as {
		data: Array<{ embedding: number[] }>;
	};

	for (let j = 0; j < batch.length; j++) {
		const key = `${batch[j]!.normId}:${batch[j]!.blockId}`;
		newEmbeddings.set(key, new Float32Array(data.data[j]!.embedding));
	}

	console.log(
		`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} embeddings`,
	);
}

// ── Step 6: Update SQLite ──
console.log("\n=== Updating SQLite ===\n");

const updateStmt = db.prepare(
	"UPDATE embeddings SET vector = ? WHERE norm_id = ? AND block_id = ? AND model = ?",
);

let updated = 0;
for (const [key, embedding] of newEmbeddings) {
	const [normId, blockId] = key.split(":");
	const buf = Buffer.from(embedding.buffer);
	updateStmt.run(buf, normId, blockId, MODEL_KEY);
	updated++;
}
console.log(`  Updated ${updated} embeddings`);

// ── Step 7: Save backup ──
await Bun.write(backupPath, JSON.stringify(backupData));
console.log(`\n  Backup saved to ${backupPath} (${backupData.length} vectors)`);

console.log(`
=== Done ===

Enriched ${updated} embeddings in SQLite.
Original vectors.bin renamed to vectors.bin.bak.

Next steps:
  1. Restart API: bun run api
     (ensureVectorIndex will re-export from SQLite automatically)
  2. Run eval or test questions
  3. To restore: bun run packages/api/research/contextual-enrichment-restore.ts
`);
