/**
 * Generate citizen-friendly tags and summaries for laws using LLM.
 *
 * Reads norms from SQLite, calls Gemini 2.5 Flash Lite via OpenRouter,
 * stores citizen_tags and citizen_summary back in the DB.
 *
 * Usage:
 *   bun run packages/pipeline/src/scripts/generate-citizen-tags.ts [--limit N] [--norm-id ID] [--force]
 */

import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { createSchema } from "../db/schema.ts";

// ── CLI args ──

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const limitArg = getArg("limit");
const normIdArg = getArg("norm-id");
const force = hasFlag("force");
const skipArticles = hasFlag("skip-articles");

// ── Load .env manually ──

const SCRIPT_DIR = import.meta.dirname;
const MONOREPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", "..");
const WORKSPACE_ROOT = MONOREPO_ROOT;

const envPath = join(MONOREPO_ROOT, ".env");
let apiKey = process.env.OPENROUTER_API_KEY;

try {
	const envContent = await Bun.file(envPath).text();
	for (const line of envContent.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
		const eqIdx = trimmed.indexOf("=");
		const key = trimmed.slice(0, eqIdx).trim();
		const value = trimmed
			.slice(eqIdx + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (key === "OPENROUTER_API_KEY" && !apiKey) {
			apiKey = value;
		}
	}
} catch {
	// .env file not found, rely on environment
}

if (!apiKey) {
	console.error("OPENROUTER_API_KEY not found in environment or .env file");
	process.exit(1);
}

// ── Constants ──

const MODEL = "google/gemini-2.5-flash-lite";
const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DELAY_MS = 0;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;
const ARTICLE_BATCH_SIZE = 10;
const ARTICLE_THRESHOLD = 20;
const ARTICLE_MIN_TEXT_LENGTH = 50;

const LAW_SYSTEM_PROMPT = `Eres un clasificador de legislación española. Tu trabajo es analizar una ley y generar metadatos orientados a ciudadanos, NO a juristas.

- citizen_tags: 5-10 tags en español llano. Piensa en cómo buscaría un ciudadano normal. Incluye situaciones específicas, no solo temas genéricos. Ejemplo para la Ley de Seguridad Social: "subsidio mayores 52", "prestación por desempleo", "baja por maternidad", "pensión viudedad", "incapacidad temporal".
- citizen_summary: Frase de máximo 150 caracteres en lenguaje llano. Sin jerga legal. Con acentos correctos.`;

const ARTICLE_SYSTEM_PROMPT = `Eres un redactor institucional que traduce artículos legales españoles a lenguaje accesible para ciudadanos.

Tono: serio e informativo, como una institución pública que explica derechos y obligaciones. NO uses tono coloquial ni de blog. Evita jerga jurídica, pero mantén la seriedad. Ejemplo: "Tienes derecho a..." es correcto; "Puedes..." es demasiado informal.

- citizen_tags: 3-5 tags en español llano, como buscaría un ciudadano normal.
- citizen_summary: Resumen de máximo 280 caracteres. Lenguaje claro y serio, sin jerga legal. Con acentos correctos. Incluye los datos concretos más relevantes (plazos, requisitos, cantidades) cuando los haya.
Si un artículo es puramente procedimental o técnico, devuelve citizen_tags vacío y citizen_summary vacío.`;

// ── JSON Schemas for structured outputs ──

const LAW_SCHEMA = {
	name: "law_citizen_metadata",
	strict: true,
	schema: {
		type: "object",
		properties: {
			citizen_tags: {
				type: "array",
				items: { type: "string" },
			},
			citizen_summary: { type: "string" },
		},
		required: ["citizen_tags", "citizen_summary"],
		additionalProperties: false,
	},
};

const ARTICLE_ITEM_SCHEMA = {
	type: "object" as const,
	properties: {
		block_id: { type: "string" as const },
		citizen_tags: {
			type: "array" as const,
			items: { type: "string" as const },
		},
		citizen_summary: { type: "string" as const },
	},
	required: ["block_id", "citizen_tags", "citizen_summary"],
	additionalProperties: false,
};

const ARTICLE_SCHEMA = {
	name: "article_citizen_metadata",
	strict: true,
	schema: {
		type: "object",
		properties: {
			articles: {
				type: "array",
				items: ARTICLE_ITEM_SCHEMA,
			},
		},
		required: ["articles"],
		additionalProperties: false,
	},
};

// ── Open DB ──

const dbPath = join(WORKSPACE_ROOT, "data", "leyabierta.db");
const db = new Database(dbPath, { create: true });
createSchema(db);

// ── Prepared statements ──

const selectNormsAll = db.prepare(
	`SELECT id, title, rank, department FROM norms WHERE citizen_summary = '' ORDER BY id`,
);
const selectNormsAllForce = db.prepare(
	`SELECT id, title, rank, department FROM norms ORDER BY id`,
);
const selectNormById = db.prepare(
	`SELECT id, title, rank, department FROM norms WHERE id = ?`,
);
const selectMaterias = db.prepare(
	`SELECT materia FROM materias WHERE norm_id = ?`,
);
const selectPreceptoBlocks = db.prepare(
	`SELECT block_id, title, current_text FROM blocks WHERE norm_id = ? AND block_type = 'precepto' AND length(current_text) > ? ORDER BY position`,
);
const updateCitizenSummary = db.prepare(
	`UPDATE norms SET citizen_summary = ? WHERE id = ?`,
);
const deleteCitizenTags = db.prepare(
	`DELETE FROM citizen_tags WHERE norm_id = ?`,
);
const deleteArticleSummaries = db.prepare(
	`DELETE FROM citizen_article_summaries WHERE norm_id = ?`,
);
const insertCitizenTag = db.prepare(
	`INSERT OR REPLACE INTO citizen_tags (norm_id, block_id, tag) VALUES (?, ?, ?)`,
);
const insertArticleSummary = db.prepare(
	`INSERT OR REPLACE INTO citizen_article_summaries (norm_id, block_id, summary) VALUES (?, ?, ?)`,
);

// ── Select norms to process ──

interface NormRow {
	id: string;
	title: string;
	rank: string;
	department: string;
}

let norms: NormRow[];

if (normIdArg) {
	const row = selectNormById.get(normIdArg) as NormRow | null;
	if (!row) {
		console.error(`Norm not found: ${normIdArg}`);
		process.exit(1);
	}
	norms = [row];
} else if (force) {
	norms = selectNormsAllForce.all() as NormRow[];
} else {
	norms = selectNormsAll.all() as NormRow[];
}

if (limitArg) {
	const limit = Number.parseInt(limitArg, 10);
	if (limit > 0) norms = norms.slice(0, limit);
}

if (norms.length === 0) {
	console.log("No norms to process.");
	process.exit(0);
}

console.log(`\n═══ Citizen Tag Generation ═══`);
console.log(`Model: ${MODEL}`);
console.log(`Norms: ${norms.length}`);
console.log(`Force: ${force}`);
console.log(`Skip articles: ${skipArticles}`);
console.log("");

// ── Cost tracking ──

let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalCost = 0;
let processedCount = 0;
let errorCount = 0;

// ── LLM call with retries ──

interface LlmResponse {
	content: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

async function callLlm(
	systemPrompt: string,
	userPrompt: string,
	maxTokens: number,
	schema: { name: string; strict: boolean; schema: object },
): Promise<LlmResponse | null> {
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

			const response = await fetch(API_URL, {
				method: "POST",
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://leyabierta.es",
					"X-Title": "Ley Abierta",
				},
				body: JSON.stringify({
					model: MODEL,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: userPrompt },
					],
					temperature: 0.2,
					max_tokens: maxTokens,
					response_format: {
						type: "json_schema",
						json_schema: schema,
					},
				}),
			});

			clearTimeout(timeout);

			if (response.status === 429 || response.status >= 500) {
				console.error(
					`    API error ${response.status}, retry ${attempt + 1}/${MAX_RETRIES}...`,
				);
				await Bun.sleep(RETRY_DELAY_MS);
				continue;
			}

			if (!response.ok) {
				const errorText = await response.text();
				console.error(`    API error ${response.status}: ${errorText}`);
				return null;
			}

			const data = await response.json();
			const usage = data.usage ?? {};
			const content = data.choices?.[0]?.message?.content ?? "";

			return {
				content,
				inputTokens: usage.prompt_tokens ?? 0,
				outputTokens: usage.completion_tokens ?? 0,
				cost: usage.cost ?? 0,
			};
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				console.error(`    Timeout, retry ${attempt + 1}/${MAX_RETRIES}...`);
			} else {
				console.error(
					`    Error: ${err}, retry ${attempt + 1}/${MAX_RETRIES}...`,
				);
			}
			if (attempt < MAX_RETRIES - 1) {
				await Bun.sleep(RETRY_DELAY_MS);
			}
		}
	}
	return null;
}

function parseJson(raw: string): unknown | null {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// ── Process norms ──

for (let i = 0; i < norms.length; i++) {
	const norm = norms[i];
	const jsonPath = join(WORKSPACE_ROOT, "data", "json", `${norm.id}.json`);

	// Read article text from JSON cache
	let articleText = "";
	try {
		const jsonFile = await Bun.file(jsonPath).text();
		const jsonData = JSON.parse(jsonFile);
		// Extract text from blocks
		if (jsonData.blocks && Array.isArray(jsonData.blocks)) {
			const texts: string[] = [];
			for (const block of jsonData.blocks) {
				if (block.versions && Array.isArray(block.versions)) {
					const lastVersion = block.versions[block.versions.length - 1];
					if (lastVersion?.paragraphs) {
						for (const p of lastVersion.paragraphs) {
							if (p.text) texts.push(p.text);
						}
					}
				}
			}
			articleText = texts.join("\n");
		}
	} catch {
		// JSON not found or malformed, use empty text
	}

	// Collect materias
	const materias = (selectMaterias.all(norm.id) as { materia: string }[]).map(
		(r) => r.materia,
	);

	// ── Law-level tagging ──

	const userPrompt = `LEY: ${norm.title}
RANGO: ${norm.rank}
DEPARTAMENTO: ${norm.department}
MATERIAS: ${materias.join(", ") || "sin materias"}
TEXTO (primeros 2000 chars):
${articleText.slice(0, 2000)}`;

	const lawResult = await callLlm(
		LAW_SYSTEM_PROMPT,
		userPrompt,
		1500,
		LAW_SCHEMA,
	);

	if (!lawResult) {
		console.error(
			`[${i + 1}/${norms.length}] ${norm.id} — ERROR: LLM call failed`,
		);
		errorCount++;
		await Bun.sleep(DELAY_MS);
		continue;
	}

	const lawData = parseJson(lawResult.content) as {
		citizen_tags: string[];
		citizen_summary: string;
	} | null;

	if (!lawData) {
		console.error(
			`[${i + 1}/${norms.length}] ${norm.id} — ERROR: JSON parse failed`,
		);
		errorCount++;
		await Bun.sleep(DELAY_MS);
		continue;
	}

	const citizenTags = lawData.citizen_tags ?? [];
	const citizenSummary = lawData.citizen_summary ?? "";

	totalInputTokens += lawResult.inputTokens;
	totalOutputTokens += lawResult.outputTokens;
	totalCost += lawResult.cost;

	// Store law-level results
	deleteCitizenTags.run(norm.id);
	deleteArticleSummaries.run(norm.id);
	updateCitizenSummary.run(citizenSummary, norm.id);

	for (const tag of citizenTags) {
		insertCitizenTag.run(norm.id, "", tag);
	}

	const tagPreview = citizenTags.slice(0, 3).join(", ");
	console.log(
		`[${i + 1}/${norms.length}] ${norm.id} — ${tagPreview}... ($${lawResult.cost.toFixed(4)})`,
	);

	// ── Article-level tagging (skip with --skip-articles) ──

	if (skipArticles) {
		processedCount++;
		await Bun.sleep(DELAY_MS);
		continue;
	}

	const preceptoBlocks = selectPreceptoBlocks.all(
		norm.id,
		ARTICLE_MIN_TEXT_LENGTH,
	) as { block_id: string; title: string; current_text: string }[];

	if (preceptoBlocks.length > ARTICLE_THRESHOLD) {
		const batchCount = Math.ceil(preceptoBlocks.length / ARTICLE_BATCH_SIZE);
		let articleTagCount = 0;
		let articleCost = 0;

		console.log(
			`  → ${preceptoBlocks.length} articles, tagging ${batchCount} batches...`,
		);

		for (let b = 0; b < batchCount; b++) {
			const batch = preceptoBlocks.slice(
				b * ARTICLE_BATCH_SIZE,
				(b + 1) * ARTICLE_BATCH_SIZE,
			);

			const articlesText = batch
				.map(
					(block) =>
						`[${block.block_id}] ${block.title}\n${block.current_text.slice(0, 500)}`,
				)
				.join("\n\n---\n\n");

			const articleUserPrompt = `LEY: ${norm.title}\n\nARTÍCULOS:\n\n${articlesText}`;

			await Bun.sleep(DELAY_MS);

			const batchResult = await callLlm(
				ARTICLE_SYSTEM_PROMPT,
				articleUserPrompt,
				4000,
				ARTICLE_SCHEMA,
			);

			if (!batchResult) continue;

			const batchParsed = parseJson(batchResult.content) as {
				articles: Array<{
					block_id: string;
					citizen_tags: string[];
					citizen_summary: string;
				}>;
			} | null;

			if (!batchParsed) continue;
			const batchData = batchParsed.articles;

			totalInputTokens += batchResult.inputTokens;
			totalOutputTokens += batchResult.outputTokens;
			totalCost += batchResult.cost;
			articleCost += batchResult.cost;

			const validBlockIds = new Set(batch.map((b) => b.block_id));

			for (const article of batchData) {
				if (!article.block_id || !validBlockIds.has(article.block_id)) continue;

				if (article.citizen_tags && article.citizen_tags.length > 0) {
					for (const tag of article.citizen_tags) {
						insertCitizenTag.run(norm.id, article.block_id, tag);
					}
					articleTagCount += article.citizen_tags.length;
				}

				if (article.citizen_summary) {
					insertArticleSummary.run(
						norm.id,
						article.block_id,
						article.citizen_summary,
					);
				}
			}
		}

		console.log(
			`  → ${articleTagCount} article tags generated ($${articleCost.toFixed(3)})`,
		);
	}

	processedCount++;
	await Bun.sleep(DELAY_MS);
}

// ── Summary ──

db.close();

console.log(`\n═══ Summary ═══`);
console.log(`Processed: ${processedCount}/${norms.length}`);
console.log(`Errors: ${errorCount}`);
console.log(`Tokens: ${totalInputTokens} in, ${totalOutputTokens} out`);
console.log(`Total cost: $${totalCost.toFixed(4)}`);
console.log("");
