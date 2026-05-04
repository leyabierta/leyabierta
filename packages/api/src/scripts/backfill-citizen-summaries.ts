/**
 * Backfill citizen summaries for all articles that don't have one.
 *
 * Uses Qwen 3.6 (unlimited tokens) instead of Gemini 2.5 Flash Lite.
 * The prompt from iteration 7 (few-shot examples) was tested and meets
 * all exit conditions: Qwen wins ≥ Gemini wins, empty rate ≤ 5%,
 * error rate ≤ 5%.
 *
 * Usage:
 *   bun run packages/api/src/scripts/backfill-citizen-summaries.ts [--limit N] [--dry-run] [--force]
 *
 * - --limit N: process only N articles (for testing)
 * - --dry-run: sample articles but don't write to DB
 * - --force: skip articles that already have a summary (default: skip)
 *
 * Checkpoints every 100 articles. Resume from last checkpoint on restart.
 *
 * Estimated runtime: ~433K articles × 30s / 5 concurrent ≈ 77 hours ≈ 3.2 days
 * Cost: $0 (unlimited tokens on Qwen endpoint)
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ── Configuration ──────────────────────────────────────────────────────────

const DB_PATH = "data/leyabierta.db";
const FAILURE_LOG = "data/backfill-failures.jsonl";
const PROGRESS_FILE = "data/backfill-progress.json";

const CONCURRENCY = 5; // Qwen rate limit: max 5 concurrent
const BATCH_SIZE = 100; // checkpoint interval
const TIMEOUT_MS = 180_000; // 3 minutes per article
const HERMES_BASE_URL = "https://api.nan.builders/v1";
const HERMES_API_KEY =
	process.env.HERMES_API_KEY ?? "sk-1WqPsfFrl3YHyBg52xRvTg";

// ── Qwen 3.6 Prompt (Iteration 7 — few-shot examples) ──────────────────────

const SYSTEM_PROMPT = `Eres un redactor institucional que traduce artículos legales españoles a lenguaje accesible para ciudadanos.

**REGISTRO OBLIGATORIO — TERCERA PERSONA:**
El resumen SIEMPRE debe escribirse en tercera persona. PROHIBIDO usar segunda persona (tú, tu, tienes, puedes, te, le, les). Usa construcciones impersonales o de tercera persona:
- ✅ "El ciudadano tiene derecho a..." / "La persona investigada puede solicitar..." / "Se establece que..."
- ✅ "Los funcionarios que falseen..." / "Las sanciones se gradúan..."
- ❌ "Tienes derecho a..." / "Puedes ejercer..." / "tus datos personales"
- ❌ "Usted tiene derecho a..." (tampoco, usa tercera persona)

**NO AÑADIR COMENTARIOS EDITORIALES:**
El resumen debe contener ÚNICAMENTE información presente en el artículo original. PROHIBIDO:
- Añadir frases de conclusión o interpretación que no estén en el texto
- Añadir análisis, opiniones, o contexto externo
- Parafasear de forma que cambie el significado

- citizen_tags: 3-5 tags en español llano, como buscaría un ciudadano normal.
- citizen_summary: Resumen de máximo 280 caracteres. Lenguaje claro y serio, sin jerga legal. Con acentos correctos. Incluye los datos concretos más relevantes (plazos, requisitos, cantidades) cuando los haya.

**LONGITUD OBLIGATORIA:** El resumen debe ser estrictamente menor de 280 caracteres. Si excedes, acorta sin perder el dato central. Un resumen de 150-250 caracteres es ideal.

**PROHIBIDO:** NO añadas frases de relleno como "Consulte la normativa vigente", "Para más información", "Recuerde que...", o cualquier advertencia no presente en el artículo original. Solo resume lo que dice el artículo.

**CUÁNDO DEVOLVER VACÍO (SOLO estos casos):**
Devuelve citizen_summary vacío Y SOLO si el artículo es una de estas cosas:
  1. Declara la entrada en vigor de la norma (ej. "Esta ley entrará en vigor el día siguiente al de su publicación").
  2. Deroga o modifica otra norma (ej. "Se deroga el artículo X de la Ley Y").
  3. Asigna rango de ley orgánica a algo.
  4. Contenido puramente organizativo interno sin efecto sobre derechos u obligaciones ciudadanas.

**IMPORTANTE — Los siguientes SÍ requieren resumen (genera SIEMPRE):**
- Artículos que describen procedimientos, reglas de funcionamiento, composición de órganos, requisitos administrativos, plazos, competencias, o cualquier contenido sustantivo.
- Artículos sobre financiación, presupuestos, organización de organismos públicos.
- En caso de duda, genera siempre un resumen breve. Es mejor un resumen corto que ninguno. Nunca devuelvas vacío por duda.

**FORMATO DE PENSAMIENTO INTERNO (obligatorio):**
Antes de generar el JSON, piensa brevemente en este formato EXACTO:
<think>
OBJETIVO: [1 frase: qué derecho u obligación describe este artículo]
HECHOS: [datos concretos: plazos, cantidades, requisitos — solo lo que dice el artículo]
ETIQUETAS: [3-5 palabras clave en llano]
RESUMEN: [borrador de 1 línea en 3ª persona]
VERIFICACIÓN: [¿uso 3ª persona? ¿añado algo que no está en el artículo? ¿este artículo SÍ merece resumen?]
</think>

NO escribas razonamiento extenso. NO inventes datos. Si un dato no está en el artículo, no lo inventes. El output debe ser SOLO el JSON, sin texto adicional.

**EJEMPLOS (estudia cada uno cuidadosamente):**

Ejemplo 1 (composición de órgano — SÍ resumen, NO vacío):
ARTÍCULO: El Consejo de Administración estará compuesto por un mínimo de cinco y un máximo de quince miembros, nombrados por el Consejo de Gobierno por un período de cuatro años, con posibilidad de reelegirles.
RESUMEN: El Consejo de Administración tiene entre 5 y 15 miembros, nombrados por el Consejo de Gobierno por 4 años con posibilidad de reelección.

Ejemplo 2 (plazos de prescripción — SÍ resumen, NO vacío):
ARTÍCULO: Las infracciones muy graves prescribirán a los tres años, las graves a los dos y las leves a los doce meses, contado desde el día en que se cometió la infracción.
RESUMEN: Las infracciones prescriben en: 3 años (muy graves), 2 años (graves), 12 meses (leves), desde la fecha de la infracción.

Ejemplo 3 (procedimiento administrativo — SÍ resumen, NO vacío):
ARTÍCULO: La solicitud de beca deberá presentarse en el registro del organismo competente junto con la documentación acreditativa de los requisitos económicos y académicos en el plazo del 1 de marzo al 30 de junio.
RESUMEN: La solicitud de beca debe presentarse en el registro del organismo competente, con documentación acreditativa, del 1 de marzo al 30 de junio.

Ejemplo 4 (entrada en vigor — vacío SÍ es correcto):
ARTÍCULO: Esta ley entrará en vigor el día siguiente al de su publicación en el Boletín Oficial del Estado.
RESUMEN: _(vacío)_

Ejemplo 5 (derechos procesales — SÍ resumen, NO vacío):
ARTÍCULO: La defensa de una persona investigada podrá solicitar que se practiquen diligencias de investigación que complementen las ya practicadas. El Fiscal Europeo acordará las diligencias si son relevantes para la investigación. Si las deniega, se podrán impugnar ante el Juez de Garantías.
RESUMEN: La persona investigada puede solicitar diligencias complementarias. El Fiscal Europeo las acordará si son relevantes. La denegación se puede impugnar ante el Juez de Garantías.`;

const SCHEMA = {
	name: "citizen_metadata",
	strict: true,
	schema: {
		type: "object",
		properties: {
			citizen_tags: { type: "array", items: { type: "string" } },
			citizen_summary: { type: "string" },
		},
		required: ["citizen_tags", "citizen_summary"],
		additionalProperties: false,
	},
};

interface Summary {
	citizen_summary: string;
	citizen_tags: string[];
}

// ── CLI Arguments ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIMIT = args.includes("--limit")
	? Number(args[args.indexOf("--limit") + 1] ?? 100)
	: 0;
const DRY_RUN = args.includes("--dry-run");
const _FORCE = args.includes("--force");

if ((LIMIT > 0 && !Number.isInteger(LIMIT)) || LIMIT < 0) {
	console.error("Invalid --limit value. Must be a positive integer.");
	process.exit(1);
}

// ── Database Setup ─────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: false });

// Checkpoint schema
const stmtGetCheckpoint = db.prepare(
	"SELECT last_norm_id, last_block_id, processed_count, last_updated FROM backfill_checkpoint LIMIT 1",
);
const stmtUpsertCheckpoint = db.prepare(
	`INSERT OR REPLACE INTO backfill_checkpoint (id, last_norm_id, last_block_id, processed_count, last_updated)
	 VALUES (1, ?, ?, ?, datetime('now'))
	 ON CONFLICT(id) DO UPDATE SET last_norm_id=excluded.last_norm_id,
	                                last_block_id=excluded.last_block_id,
	                                processed_count=excluded.processed_count,
	                                last_updated=excluded.last_updated`,
);

// Create checkpoint table if not exists
db.exec(`CREATE TABLE IF NOT EXISTS backfill_checkpoint (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	last_norm_id TEXT,
	last_block_id TEXT,
	processed_count INTEGER DEFAULT 0,
	last_updated TEXT
)`);

// ── Article Sampling ───────────────────────────────────────────────────────

interface Article {
	norm_id: string;
	block_id: string;
	norm_title: string;
	block_title: string;
	current_text: string;
}

function sampleArticles(startFrom?: {
	norm_id: string;
	block_id: string;
}): Article[] {
	let query = `
		SELECT n.id AS norm_id, n.title AS norm_title, b.block_id, b.title AS block_title, b.current_text
		FROM norms n
		JOIN blocks b ON b.norm_id = n.id
		WHERE n.status = 'vigente'
		  AND b.block_type = 'precepto'
		  AND length(b.current_text) BETWEEN 200 AND 2000
		  AND NOT EXISTS (
			SELECT 1 FROM citizen_article_summaries c
			WHERE c.norm_id = n.id AND c.block_id = b.block_id
		  )
		ORDER BY n.id, b.block_id
	`;
	let params: (string | number)[] = [];

	if (startFrom) {
		query += ` AND (n.id > ? OR (n.id = ? AND b.block_id > ?))`;
		params = [startFrom.norm_id, startFrom.norm_id, startFrom.block_id];
	}

	if (LIMIT > 0) {
		query += ` LIMIT ?`;
		params.push(LIMIT);
	}

	return db.prepare(query).all(...params) as Article[];
}

// ── Qwen API ───────────────────────────────────────────────────────────────

async function callQwen(
	article: Article,
): Promise<{ output: Summary | null; error: string | null }> {
	const res = await fetch(`${HERMES_BASE_URL}/chat/completions`, {
		method: "POST",
		signal: AbortSignal.timeout(TIMEOUT_MS),
		headers: {
			Authorization: `Bearer ${HERMES_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "qwen3.6",
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{
					role: "user",
					content: `LEY: ${article.norm_title}\n\nARTÍCULO:\n${article.block_title}\n${article.current_text.slice(0, 2000)}`,
				},
			],
			temperature: 0.2,
			max_tokens: 32000,
			response_format: { type: "json_schema", json_schema: SCHEMA },
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		return { output: null, error: `http_${res.status}: ${body.slice(0, 200)}` };
	}

	const data = (await res.json()) as {
		choices?: { message?: { content?: string } }[];
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};

	const text = data.choices?.[0]?.message?.content ?? "";
	let parsed: Summary | null = null;
	try {
		parsed = JSON.parse(
			text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""),
		);
	} catch (e) {
		return {
			output: null,
			error: `json_parse: ${(e as Error).message}: ${text.slice(0, 200)}`,
		};
	}

	return { output: parsed, error: null };
}

async function callQwenWithRetry(
	article: Article,
): Promise<{ output: Summary | null; error: string | null }> {
	const result = await callQwen(article);

	if (result.error) {
		// Retry on 524 (gateway timeout) — 2s wait
		if (result.error.includes("524")) {
			await new Promise((r) => setTimeout(r, 2000));
			const r2 = await callQwen(article);
			if (r2.error) {
				await new Promise((r) => setTimeout(r, 2000));
				return callQwen(article); // final attempt
			}
			return r2;
		}
		// Retry on 429 (rate limit) — 65s wait
		if (result.error.includes("429")) {
			await new Promise((r) => setTimeout(r, 65_000));
			return callQwen(article);
		}
		// Other errors — retry once
		await new Promise((r) => setTimeout(r, 1000));
		return callQwen(article);
	}

	// Retry on empty for substantive articles (>200 chars)
	if (
		result.output &&
		result.output.citizen_summary === "" &&
		article.current_text.length > 200
	) {
		const retryPrompt = `Este artículo SÍ es sustantivo. Genera un resumen obligatorio.

LEY: ${article.norm_title}

ARTÍCULO:
${article.block_title}
${article.current_text.slice(0, 2000)}`;

		const retryRes = await fetch(`${HERMES_BASE_URL}/chat/completions`, {
			method: "POST",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: {
				Authorization: `Bearer ${HERMES_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "qwen3.6",
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: retryPrompt },
				],
				temperature: 0.2,
				max_tokens: 32000,
				response_format: { type: "json_schema", json_schema: SCHEMA },
			}),
		});

		if (retryRes.ok) {
			const data = (await retryRes.json()) as {
				choices?: { message?: { content?: string } }[];
			};
			const text = data.choices?.[0]?.message?.content ?? "";
			try {
				const parsed = JSON.parse(
					text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""),
				);
				return { output: parsed, error: null };
			} catch {
				// Return original empty result
			}
		}
	}

	return result;
}

// ── Concurrency Pool ───────────────────────────────────────────────────────

async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const i = cursor++;
				if (i >= items.length) return;
				results[i] = await fn(items[i], i);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

// ── Progress Tracking ──────────────────────────────────────────────────────

interface Progress {
	total: number;
	processed: number;
	success: number;
	empty: number;
	errors: number;
	startedAt: string;
	finishedAt?: string;
}

function loadProgress(): Progress {
	const existing = readFileSync(PROGRESS_FILE, "utf-8");
	return JSON.parse(existing) as Progress;
}

function saveProgress(p: Progress) {
	writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function createProgress(total: number): Progress {
	return {
		total,
		processed: 0,
		success: 0,
		empty: 0,
		errors: 0,
		startedAt: new Date().toISOString(),
	};
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
	console.log(`=== Citizen Summaries Backfill ===`);
	console.log(`Limit: ${LIMIT > 0 ? LIMIT : "all (~433K)"}`);
	console.log(`Dry run: ${DRY_RUN}`);
	console.log(`Concurrency: ${CONCURRENCY}`);
	console.log(``);

	// Load checkpoint
	interface CheckpointRow {
		last_norm_id: string;
		last_block_id: string;
		processed_count: number;
	}

	const checkpoint = stmtGetCheckpoint.get() as CheckpointRow | null;

	const startFrom = checkpoint
		? { norm_id: checkpoint.last_norm_id, block_id: checkpoint.last_block_id }
		: undefined;

	if (startFrom) {
		console.log(
			`Resuming from checkpoint: ${startFrom.norm_id}::${startFrom.block_id} (processed ${checkpoint.processed_count})`,
		);
	}

	// Sample articles
	const articles = sampleArticles(startFrom);
	console.log(`Found ${articles.length} articles to process.`);

	if (articles.length === 0) {
		console.log("No articles to process. Done.");
		return;
	}

	// Load or create progress
	let progress: Progress;
	if (existsSync(PROGRESS_FILE)) {
		progress = loadProgress();
		console.log(
			`Resuming progress: ${progress.success} success, ${progress.errors} errors, ${progress.empty} empty`,
		);
	} else {
		progress = createProgress(articles.length);
	}

	// Process in batches
	for (
		let batchStart = 0;
		batchStart < articles.length;
		batchStart += BATCH_SIZE
	) {
		const batchEnd = Math.min(batchStart + BATCH_SIZE, articles.length);
		const batch = articles.slice(batchStart, batchEnd);

		console.log(
			`\nBatch ${Math.floor(batchStart / BATCH_SIZE) + 1}: processing ${batch.length} articles (${batchStart + 1}–${batchEnd} of ${articles.length})`,
		);

		// Generate summaries
		const results = await mapPool(batch, CONCURRENCY, async (article) => {
			const result = await callQwenWithRetry(article);
			return { article, result };
		});

		// Write results
		for (const { article, result } of results) {
			progress.processed++;

			if (result.error) {
				progress.errors++;
				// Log failure
				writeFileSync(
					FAILURE_LOG,
					`${JSON.stringify({
						norm_id: article.norm_id,
						block_id: article.block_id,
						error: result.error,
						timestamp: new Date().toISOString(),
					})}\n`,
					{ flag: "a" },
				);
				console.log(
					`  ✗ ${article.norm_id}::${article.block_id}: ${result.error.slice(0, 60)}`,
				);
			} else if (!result.output || result.output.citizen_summary === "") {
				progress.empty++;
				console.log(
					`  ○ ${article.norm_id}::${article.block_id}: empty (valid for procedural)`,
				);
			} else {
				progress.success++;

				if (!DRY_RUN) {
					// Write to DB
					db.prepare(
						"INSERT OR REPLACE INTO citizen_article_summaries (norm_id, block_id, summary) VALUES (?, ?, ?)",
					).run(
						article.norm_id,
						article.block_id,
						result.output.citizen_summary,
					);

					// Write tags
					for (const tag of result.output.citizen_tags) {
						db.prepare(
							"INSERT OR REPLACE INTO citizen_tags (norm_id, block_id, tag) VALUES (?, ?, ?)",
						).run(article.norm_id, article.block_id, tag);
					}
				}

				// Progress indicator every 10 articles
				if (progress.processed % 10 === 0) {
					console.log(
						`  ✓ ${progress.processed}/${articles.length} processed (${progress.success} success, ${progress.errors} errors, ${progress.empty} empty)`,
					);
				}
			}
		}

		// Checkpoint
		const lastArticle = batch[batch.length - 1];
		if (!DRY_RUN) {
			const totalProcessed = (checkpoint?.processed_count ?? 0) + batchEnd;
			stmtUpsertCheckpoint.run(
				lastArticle.norm_id,
				lastArticle.block_id,
				totalProcessed,
			);
		}

		saveProgress(progress);

		// ETA
		const elapsed =
			(Date.now() - new Date(progress.startedAt).getTime()) / 1000;
		const rate = progress.processed / elapsed;
		const remaining = articles.length - progress.processed;
		const etaSeconds = remaining / rate;
		const etaHours = etaSeconds / 3600;
		console.log(`  ETA: ${etaHours.toFixed(1)}h remaining`);
	}

	// Final summary
	console.log(`\n=== Backfill Complete ===`);
	console.log(`Total: ${articles.length}`);
	console.log(
		`Success: ${progress.success} (${((progress.success / articles.length) * 100).toFixed(1)}%)`,
	);
	console.log(
		`Empty: ${progress.empty} (${((progress.empty / articles.length) * 100).toFixed(1)}%)`,
	);
	console.log(
		`Errors: ${progress.errors} (${((progress.errors / articles.length) * 100).toFixed(1)}%)`,
	);
	console.log(`Failure log: ${FAILURE_LOG}`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
