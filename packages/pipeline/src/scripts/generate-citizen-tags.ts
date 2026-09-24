/**
 * Generate citizen-friendly tags and summaries for laws using LLM.
 *
 * Reads norms from SQLite, calls an OpenRouter chat model (CONTENT_LLM_MODEL,
 * default google/gemini-2.5-flash-lite) for the law-level summary and tags,
 * stores them back in the DB, then summarizes every article of the law with
 * the shared per-article generator (ai/article-summary.ts: prompt v10, whole
 * article, ARTICLE_SUMMARIES_MODEL, default openai/gpt-6-luna), the same as
 * the lazy API route and the RAG background fill.
 *
 * Gap-filling: every run processes norms whose citizen_summary is still empty,
 * newest first, capped per run (--limit, default CITIZEN_TAGS_MAX_PER_RUN or
 * 100) so a backlog is spread across several daily runs.
 *
 * Usage:
 *   bun run packages/pipeline/src/scripts/generate-citizen-tags.ts [--limit N] [--norm-id ID] [--force] [--skip-articles]
 *
 * Env: OPENROUTER_API_KEY (required; also read from .env), CONTENT_LLM_MODEL,
 * CITIZEN_TAGS_MAX_PER_RUN, ARTICLE_SUMMARIES_MODEL,
 * ARTICLE_SUMMARIES_MAX_PER_RUN (articles per run, default 2000).
 */

import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import {
	articleHasSubstance,
	articleSummariesModel,
	generateArticleSummary,
	storeArticleSummary,
} from "../ai/article-summary.ts";
import { createSchema } from "../db/schema.ts";
import { parseLawCitizenMetadata } from "./citizen-tags-validation.ts";

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

// Same env var and default as CONTENT_LLM_MODEL in packages/api/src/services/
// openrouter.ts (this package cannot import from api). The NaN stack (gemma4)
// used here until 2026-08 was cancelled.
const MODEL = process.env.CONTENT_LLM_MODEL || "google/gemini-2.5-flash-lite";
const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MAX_PER_RUN = Number(process.env.CITIZEN_TAGS_MAX_PER_RUN ?? 100);
const DELAY_MS = 0;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;
const ARTICLE_MIN_TEXT_LENGTH = 50;
const ARTICLE_MODEL = articleSummariesModel();
// Concurrent article requests: gpt-6-luna answers some requests with an
// upstream 429 above ~4 (retried by generateArticleSummary).
const ARTICLE_CONCURRENCY = 4;
// Cap on article requests per run, so a huge new code cannot run for hours;
// articles left over are filled by the lazy API route or an offline backfill.
const ARTICLE_MAX_PER_RUN = Number(
	process.env.ARTICLE_SUMMARIES_MAX_PER_RUN ?? 2000,
);

const LAW_SYSTEM_PROMPT = `Eres un clasificador de legislación española. Tu trabajo es analizar una ley y generar metadatos orientados a ciudadanos, NO a juristas.

- citizen_tags: 5-10 tags en español llano. Piensa en cómo buscaría un ciudadano normal. Incluye situaciones específicas, no solo temas genéricos. Ejemplo para la Ley de Seguridad Social: "subsidio mayores 52", "prestación por desempleo", "baja por maternidad", "pensión viudedad", "incapacidad temporal".
- citizen_summary: Frase de máximo 150 caracteres en lenguaje llano. Sin jerga legal. Con acentos correctos.`;

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

// ── Open DB ──

const dbPath =
	process.env.DB_PATH ?? join(WORKSPACE_ROOT, "data", "leyabierta.db");
const db = new Database(dbPath, { create: true });
createSchema(db);

// ── Prepared statements ──

// Newest first, so a per-run cap always serves the latest laws before backlog.
const selectNormsAll = db.prepare(
	`SELECT id, title, rank, department FROM norms WHERE citizen_summary = '' ORDER BY published_at DESC, id`,
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

const pendingTotal = norms.length;
{
	const limit = limitArg ? Number.parseInt(limitArg, 10) : DEFAULT_MAX_PER_RUN;
	if (limit > 0) norms = norms.slice(0, limit);
}

if (norms.length === 0) {
	console.log("No norms to process.");
	process.exit(0);
}

console.log(`\n═══ Citizen Tag Generation ═══`);
console.log(`Model: ${MODEL} (laws), ${ARTICLE_MODEL} (articles)`);
console.log(`Norms: ${norms.length} (of ${pendingTotal} pending)`);
console.log(`Force: ${force}`);
console.log(`Skip articles: ${skipArticles}`);
console.log("");

// ── Cost tracking ──

let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalCost = 0;
let processedCount = 0;
let errorCount = 0;
let articleRequests = 0;
let articleStored = 0;
const articleFailures: Record<string, number> = {};

// ── LLM call with retries ──

interface LlmResponse {
	content: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

interface ChatCompletionResponse {
	choices?: Array<{ message?: { content?: string } }>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cost?: number;
	};
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

			const data = (await response.json()) as ChatCompletionResponse;
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

// ── Process norms ──

for (let i = 0; i < norms.length; i++) {
	const norm = norms[i];
	if (!norm) continue;
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

	// Rejects invalid JSON and blank summaries (see citizen-tags-validation.ts:
	// a blank one would re-select this norm every run and wipe its articles).
	const lawData = parseLawCitizenMetadata(lawResult.content);

	if (!lawData) {
		console.error(
			`[${i + 1}/${norms.length}] ${norm.id} — ERROR: invalid JSON, empty citizen_summary or text in another script`,
		);
		errorCount++;
		await Bun.sleep(DELAY_MS);
		continue;
	}

	const citizenTags = lawData.citizen_tags;
	const citizenSummary = lawData.citizen_summary;

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

	const preceptoBlocks = (
		selectPreceptoBlocks.all(norm.id, ARTICLE_MIN_TEXT_LENGTH) as {
			block_id: string;
			title: string;
			current_text: string;
		}[]
	).filter((block) => articleHasSubstance(block.current_text));

	const budget = Math.max(0, ARTICLE_MAX_PER_RUN - articleRequests);
	const toSummarize = preceptoBlocks.slice(0, budget);
	if (toSummarize.length < preceptoBlocks.length)
		console.log(
			`  → article cap reached (${ARTICLE_MAX_PER_RUN}/run): ${preceptoBlocks.length - toSummarize.length} articles left without summary`,
		);

	if (toSummarize.length > 0) {
		let stored = 0;
		let cost = 0;
		let next = 0;
		const worker = async () => {
			while (next < toSummarize.length) {
				const block = toSummarize[next++];
				if (!block) continue;
				articleRequests++;
				const result = await generateArticleSummary({
					apiKey: apiKey as string,
					article: {
						norm_title: norm.title,
						block_title: block.title,
						current_text: block.current_text,
					},
					model: ARTICLE_MODEL,
				});
				if (!result.ok) {
					// Invalid (second person, too long, another script...) or failed:
					// nothing is stored; the lazy route or a backfill can retry.
					articleFailures[result.reason] =
						(articleFailures[result.reason] ?? 0) + 1;
					continue;
				}
				cost += result.cost;
				if (storeArticleSummary(db, norm.id, block.block_id, result)) stored++;
			}
		};
		await Promise.all(
			Array.from(
				{ length: Math.min(ARTICLE_CONCURRENCY, toSummarize.length) },
				worker,
			),
		);
		articleStored += stored;
		totalCost += cost;
		console.log(
			`  → ${stored}/${toSummarize.length} article summaries ($${cost.toFixed(3)})`,
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
console.log(
	`Articles: ${articleStored} summaries stored of ${articleRequests} requested${
		Object.keys(articleFailures).length
			? ` (not stored: ${JSON.stringify(articleFailures)})`
			: ""
	}`,
);
console.log(`Total cost: $${totalCost.toFixed(4)}`);
console.log("");

// Non-zero exit when every norm failed (e.g. bad key), so the daily pipeline alerts.
if (processedCount === 0 && errorCount > 0) process.exit(1);
