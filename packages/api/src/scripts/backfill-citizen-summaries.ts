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
 * - --force: also reprocess articles that already have a summary (default: skip them)
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

// Qwen rate limit: max 5 concurrent
// Override via QWEN_BATCH_SIZE env var (1-10). Lower batch size avoids the
// position-based-mapping risk when the model returns fewer items than sent.
const API_BATCH_SIZE = Math.max(
	1,
	Math.min(10, Number(process.env.QWEN_BATCH_SIZE ?? 5)),
); // articles per API call (batching)
const CHECKPOINT_INTERVAL = 100; // checkpoint every N articles
const REQUEST_TIMEOUT_MS = 180_000; // 3 minutes per individual request
const HERMES_BASE_URL = "https://api.nan.builders/v1";
const HERMES_API_KEY = process.env.HERMES_API_KEY;
if (!HERMES_API_KEY) {
	console.error("Error: HERMES_API_KEY env var is required");
	process.exit(1);
}

// ── Qwen 3.6 Prompt v10 (anti-invention + force detail) ──────────────────────

const SYSTEM_PROMPT = `Eres un redactor institucional que traduce artículos legales españoles a lenguaje accesible para ciudadanos.

**REGISTRO OBLIGATORIO — TERCERA PERSONA:**
PROHIBIDO segunda persona (tú, tu, tienes, puedes, te, usted). Usa impersonal o tercera persona.
- ✅ "El ciudadano tiene derecho a..." / "Se establece que..." / "La administración debe..."
- ❌ "Tienes derecho..." / "Puedes solicitar..."

**FIDELIDAD ESTRICTA:**
El resumen contiene SOLO información presente en el artículo. PROHIBIDO inventar datos, añadir opiniones, advertencias, o frases de relleno ("Consulte la normativa", "Para más información", "Recuerde que...").

**REGLA ANTI-INVENCIÓN DE REFERENCIAS NORMATIVAS:**
NUNCA añadas números de leyes, decretos, órdenes, reglamentos o normas que no aparezcan LITERALMENTE en el texto del artículo. Si el texto solo dice "esta ley", "esta orden", "el organismo", "esta disposición", el resumen DEBE usar la misma forma genérica — JAMÁS sustituirla por un identificador específico (ej. "Ley 17/2001", "Orden PCI/881/2019", "Servicio Cántabro de Salud") aunque conozcas el dato por otra fuente. La fidelidad al texto literal es prioridad absoluta sobre la información de fondo.

Igualmente, no añadas calificadores que no estén en el texto: si el artículo no menciona "civiles", "estatales", "menores", "europeos" u otros adjetivos restrictivos, no los añadas.

**DETALLE FACTUAL — INCLUIR TODO LO RELEVANTE:**
Incluye SIEMPRE los datos concretos del artículo:
- Cantidades, plazos, porcentajes, fechas exactas
- Referencias normativas citadas (números de artículo, leyes)
- Sub-actividades enumeradas (si el artículo lista varias, nombrarlas todas)
- Condiciones, excepciones, requisitos
- Órganos, autoridades o sujetos específicos mencionados
- Procedimientos accesorios (revisiones, recursos, plazos derivados)

Si el artículo enumera "A, B, C y D", el resumen debe nombrar A, B, C y D — no resumir como "varias actividades".

**LONGITUD:**
Objetivo: 200-250 caracteres. Es la zona ideal para ciudadano: suficiente para datos clave, breve para escanear.
Mínimo: 80 caracteres.
Máximo blando: 280 caracteres. Se permite excederlo hasta ~300 (≈20% sobre el objetivo) si la fidelidad lo requiere para listas o referencias normativas que no se pueden abreviar sin perder información.
Máximo duro: 300 caracteres. Si tu borrador rebasa 300, RECÓRTALO eligiendo los 2-3 datos más relevantes y omitiendo los secundarios. Nunca devuelvas >300.

**FORMATO DE SALIDA:**
SOLO JSON válido conforme al schema. NO añadas razonamiento, comentarios, ni texto antes o después del JSON.

- citizen_tags: 3-5 tags en español llano, como buscaría un ciudadano normal.
- citizen_summary: el resumen siguiendo todas las reglas anteriores.

**EJEMPLOS:**

Ejemplo 1 (composición de órgano — incluir números y autoridad):
ARTÍCULO: El Consejo de Administración estará compuesto por un mínimo de cinco y un máximo de quince miembros, nombrados por el Consejo de Gobierno por un período de cuatro años, con posibilidad de reelegirles.
RESUMEN: El Consejo de Administración tiene entre 5 y 15 miembros, nombrados por el Consejo de Gobierno por un período de 4 años, con posibilidad de reelección.

Ejemplo 2 (plazos enumerados — listar todos):
ARTÍCULO: Las infracciones muy graves prescribirán a los tres años, las graves a los dos y las leves a los doce meses, contado desde el día en que se cometió la infracción.
RESUMEN: Las infracciones prescriben en: 3 años (muy graves), 2 años (graves) y 12 meses (leves), contado desde el día de la infracción.

Ejemplo 3 (procedimiento con plazos diferenciados):
ARTÍCULO: Si se admitiere el recurso en ambos efectos, el Secretario judicial remitirá los autos al Tribunal que hubiere de conocer de la apelación, y emplazará a las partes para que se personen ante éste en quince días si el Tribunal fuere el Supremo, o diez días si fuere inferior.
RESUMEN: El recurso admitido en ambos efectos se remite al Tribunal competente. Las partes deben personarse en 15 días si es el Tribunal Supremo o en 10 días si es un tribunal inferior.

Ejemplo 4 (entrada en vigor — siempre con detalle):
ARTÍCULO: Esta ley entrará en vigor el día siguiente al de su publicación en el Boletín Oficial del Estado.
RESUMEN: La ley entra en vigor el día siguiente al de su publicación en el Boletín Oficial del Estado.

Ejemplo 5 (derogación con referencia normativa):
ARTÍCULO: Se deroga el artículo 45 de la Ley 25/2009, de 22 de diciembre, de obligaciones de facturación.
RESUMEN: Se deroga el artículo 45 de la Ley 25/2009, de 22 de diciembre, sobre obligaciones de facturación.

Ejemplo 6 (derechos procesales — todos los actores):
ARTÍCULO: La defensa de una persona investigada podrá solicitar diligencias de investigación que complementen las ya practicadas. El Fiscal Europeo acordará las diligencias si son relevantes. Si las deniega, se podrán impugnar ante el Juez de Garantías.
RESUMEN: La defensa de la persona investigada puede solicitar diligencias complementarias. El Fiscal Europeo las acuerda si son relevantes. Su denegación se puede impugnar ante el Juez de Garantías.

Ejemplo 7 (modificación normativa con destino):
ARTÍCULO: Se derogan las disposiciones en contrario y se establece que las tarifas de almacenamiento se calcularán conforme al anexo I de esta ley.
RESUMEN: Se derogan las disposiciones en contrario. Las tarifas de almacenamiento se calculan conforme al anexo I de esta ley.

Ejemplo 8 (objeto amplio — enumerar todas las materias):
ARTÍCULO: La presente ley regula la pesca marítima, la acuicultura, el marisqueo, la pesca recreativa, la actividad comercial de productos pesqueros, la investigación pesquera y el régimen de infracciones y sanciones en la Región de Murcia.
RESUMEN: Esta ley regula en la Región de Murcia: pesca marítima, acuicultura, marisqueo, pesca recreativa, actividad comercial de productos pesqueros, investigación pesquera y régimen de infracciones y sanciones.

Ejemplo 9 (procedimiento con ramificación):
ARTÍCULO: El Mapa Farmacéutico se revisará cada cinco años. Excepcionalmente, podrá modificarse antes si concurren circunstancias extraordinarias. Las revisiones y modificaciones siguen el mismo procedimiento de aprobación.
RESUMEN: El Mapa Farmacéutico se revisa cada 5 años. Puede modificarse antes si concurren circunstancias extraordinarias. Las revisiones y modificaciones siguen el mismo procedimiento de aprobación.

Ejemplo 10 (obligaciones plurales):
ARTÍCULO: Los cuerpos policiales deberán informar a las víctimas y a los detenidos de sus derechos y garantías en la forma que reglamentariamente se determine.
RESUMEN: Los cuerpos policiales deben informar a las víctimas y a los detenidos sobre sus derechos y garantías, en la forma que se determine reglamentariamente.`;

// Single-article schema (kept for reference, not used in batch mode)
const _SCHEMA = {
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

// ── CLI Arguments ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIMIT = args.includes("--limit")
	? Number(args[args.indexOf("--limit") + 1] ?? 100)
	: 0;
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const CONCURRENCY = args.includes("--concurrency")
	? Math.max(
			1,
			Math.min(10, Number(args[args.indexOf("--concurrency") + 1] ?? 5)),
		)
	: 5;

if ((LIMIT > 0 && !Number.isInteger(LIMIT)) || LIMIT < 0) {
	console.error("Invalid --limit value. Must be a positive integer.");
	process.exit(1);
}

// ── Database Setup ─────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

// Create checkpoint table if not exists (must be before stmt.prepare)
db.exec(`CREATE TABLE IF NOT EXISTS backfill_checkpoint (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	last_norm_id TEXT,
	last_block_id TEXT,
	processed_count INTEGER DEFAULT 0,
	last_updated TEXT
)`);

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

// Write statements: hoisted to module level so we don't recompile the same SQL
// ~1.5M times during a 433K-article run.
const stmtInsertSummary = db.prepare(
	"INSERT OR REPLACE INTO citizen_article_summaries (norm_id, block_id, summary) VALUES (?, ?, ?)",
);
const stmtInsertTag = db.prepare(
	"INSERT OR REPLACE INTO citizen_tags (norm_id, block_id, tag) VALUES (?, ?, ?)",
);

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
	let where = `
		WHERE n.status = 'vigente'
		  AND b.block_type = 'precepto'
		  AND length(b.current_text) BETWEEN 200 AND 2000`;
	const params: (string | number)[] = [];

	if (!FORCE) {
		where += `
		  AND NOT EXISTS (
			SELECT 1 FROM citizen_article_summaries c
			WHERE c.norm_id = n.id AND c.block_id = b.block_id
		  )`;
	}

	if (startFrom) {
		where += ` AND (n.id > ? OR (n.id = ? AND b.block_id > ?))`;
		params.push(startFrom.norm_id, startFrom.norm_id, startFrom.block_id);
	}

	let query = `
		SELECT n.id AS norm_id, n.title AS norm_title, b.block_id, b.title AS block_title, b.current_text
		FROM norms n
		JOIN blocks b ON b.norm_id = n.id
		${where}
		ORDER BY n.id, b.block_id`;

	if (LIMIT > 0) {
		query += ` LIMIT ?`;
		params.push(LIMIT);
	}

	return db.prepare(query).all(...params) as Article[];
}

// ── Qwen API (Batch Mode) ──────────────────────────────────────────────────

interface BatchSummary {
	article_id: string;
	citizen_summary: string;
	citizen_tags: string[];
}

const BATCH_SCHEMA = {
	name: "citizen_metadata_batch",
	strict: true,
	schema: {
		type: "array",
		items: {
			type: "object",
			properties: {
				article_id: { type: "string" },
				// minLength forces the model to emit a real summary; the schema
				// engine will reject empty strings before we ever see them.
				// maxLength matches the prompt's hard cap (300) so the schema engine
				// rejects overly verbose responses instead of silently storing them.
				citizen_summary: { type: "string", minLength: 10, maxLength: 300 },
				citizen_tags: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
				},
			},
			required: ["article_id", "citizen_summary", "citizen_tags"],
			additionalProperties: false,
		},
	},
};

function buildBatchPrompt(articles: Article[]): string {
	return (
		articles
			.map(
				(a, i) =>
					`ARTÍCULO_${i + 1}:\nLEY: ${a.norm_title}\nTÍTULO: ${a.block_title}\nTEXTO:\n${a.current_text.slice(0, 2000)}`,
			)
			.join("\n\n") +
		"\n\nGenera un resumen para cada artículo. Usa article_id como identificador único."
	);
}

async function callQwenBatch(
	articles: Article[],
): Promise<{ outputs: (BatchSummary | null)[]; error: string | null }> {
	const prompt = buildBatchPrompt(articles);
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const res = await fetch(`${HERMES_BASE_URL}/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${HERMES_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "qwen3.6",
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: prompt },
				],
				temperature: 0.2,
				// 2000 is plenty without thinking. Output content is ~500 tokens
				// max for a batch of 5 summaries; the rest is safety margin.
				max_tokens: 2000,
				// Disable Qwen thinking: A/B with Sonnet judge showed thinking-OFF
				// is ~9x faster (3s vs 28s), 0% errors (vs 20% with 524s), and
				// slightly higher quality (8.56 vs 8.44/10). The reasoning chain
				// added latency without translating into better summaries.
				chat_template_kwargs: { enable_thinking: false },
				response_format: { type: "json_schema", json_schema: BATCH_SCHEMA },
			}),
		});

		console.error(
			`[DEBUG] callQwenBatch: response status ${res.status} (${Date.now()}ms)`,
		);

		if (!res.ok) {
			const body = await res.text();
			return {
				outputs: [],
				error: `http_${res.status}: ${body.slice(0, 200)}`,
			};
		}

		const data = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
		};

		const text = data.choices?.[0]?.message?.content ?? "";
		let parsed: BatchSummary[] | null = null;

		// Robust JSON extraction: try multiple strategies
		const extractors = [
			// 1. Try as-is
			(t: string) => JSON.parse(t),
			// 2. Strip markdown code blocks
			(t: string) =>
				JSON.parse(t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")),
			// 3. Find first { and last } and parse what's between
			(t: string) => {
				const first = t.indexOf("{");
				const last = t.lastIndexOf("}");
				if (first !== -1 && last !== -1 && last > first) {
					return JSON.parse(t.slice(first, last + 1));
				}
				throw new Error("No JSON object found");
			},
			// 4. Find first [ and last ] and parse what's between (for array responses)
			(t: string) => {
				const first = t.indexOf("[");
				const last = t.lastIndexOf("]");
				if (first !== -1 && last !== -1 && last > first) {
					return JSON.parse(t.slice(first, last + 1));
				}
				throw new Error("No JSON array found");
			},
		];

		let parseError = "";
		for (const extractor of extractors) {
			try {
				parsed = extractor(text);
				// Validate it's an array
				if (Array.isArray(parsed)) break;
				// If it's an object, wrap in array (single item)
				if (
					typeof parsed === "object" &&
					parsed !== null &&
					"citizen_summary" in parsed
				) {
					parsed = [parsed as BatchSummary];
					break;
				}
				parseError = "Not an array or expected object";
			} catch (e) {
				parseError = (e as Error).message;
			}
		}

		if (!parsed) {
			return {
				outputs: [],
				error: `json_parse: ${parseError}: ${text.slice(0, 300)}`,
			};
		}

		// Map by article_id (the model returns "ARTÍCULO_1", "ARTÍCULO_2", ...).
		// Position-based mapping silently dropped trailing articles when the
		// model returned fewer items than were sent — that's how 18% of the
		// corpus ended up as fake "empty" rows.
		const byId = new Map<string, BatchSummary>();
		for (const p of parsed) {
			if (p.article_id) byId.set(p.article_id, p);
		}
		const outputs: (BatchSummary | null)[] = articles.map((_a, i) => {
			const key = `ARTÍCULO_${i + 1}`;
			const hit = byId.get(key);
			if (!hit) return null;
			return {
				article_id: hit.article_id,
				citizen_summary: hit.citizen_summary,
				citizen_tags: hit.citizen_tags,
			};
		});

		return { outputs, error: null };
	} catch (e) {
		if ((e as Error).name === "AbortError") {
			return {
				outputs: [],
				error: `timeout: request exceeded ${REQUEST_TIMEOUT_MS}ms`,
			};
		}
		return { outputs: [], error: `fetch_error: ${(e as Error).message}` };
	} finally {
		clearTimeout(timeoutId);
	}
}

// Single-article fallback: if the batch left some positions as null
// (the model occasionally returns N-1 items for a batch of N), retry the
// missing items one by one before giving up.
async function fillMissingWithSingles(
	articles: Article[],
	outputs: (BatchSummary | null)[],
): Promise<(BatchSummary | null)[]> {
	for (let i = 0; i < articles.length; i++) {
		if (outputs[i] !== null) continue;
		// Single-article batch retains the same prompt/schema and lets the
		// id-based mapping resolve the result back into position i.
		const single = await callQwenBatch([articles[i]]);
		if (!single.error && single.outputs[0]) {
			outputs[i] = single.outputs[0];
		}
	}
	return outputs;
}

async function callQwenBatchWithRetry(
	articles: Article[],
): Promise<{ outputs: (BatchSummary | null)[]; error: string | null }> {
	const result = await callQwenBatch(articles);

	if (!result.error) {
		// Fill in any missing items the batch dropped.
		const hasMissing = result.outputs.some((o) => o === null);
		if (hasMissing) {
			result.outputs = await fillMissingWithSingles(articles, result.outputs);
		}
		return result;
	}

	// Aggressive retry strategy: timeout/5xx → long exponential backoff up to
	// 6 attempts (NaN endpoint occasionally serves persistent 502s for ~1-2
	// minutes when the upstream is overloaded); 429 → fixed 65s wait;
	// json_parse → quick retries.
	let last = result;
	for (let attempt = 1; attempt <= 6; attempt++) {
		const err = last.error ?? "";
		let waitMs: number;
		if (err.includes("429")) {
			waitMs = 65_000 + Math.random() * 5000;
		} else if (
			err.includes("timeout") ||
			err.includes("524") ||
			/http_5\d\d/.test(err)
		) {
			// 10s, 30s, 60s, 120s, 180s, 240s with jitter — total ~10min
			const schedule = [10_000, 30_000, 60_000, 120_000, 180_000, 240_000];
			const base =
				schedule[Math.min(attempt - 1, schedule.length - 1)] ?? 10_000;
			waitMs = base + Math.random() * (base / 4);
		} else if (err.includes("json_parse")) {
			waitMs = 1500 + Math.random() * 1500 + attempt * 1000;
		} else {
			waitMs = 1000 + Math.random() * 1000;
		}
		await new Promise((r) => setTimeout(r, waitMs));
		const next = await callQwenBatch(articles);
		if (!next.error) {
			const hasMissing = next.outputs.some((o) => o === null);
			if (hasMissing) {
				next.outputs = await fillMissingWithSingles(articles, next.outputs);
			}
			return next;
		}
		last = next;
	}

	// All batch retries exhausted. Last resort: try each article individually.
	// A persistent 5xx on a 5-item batch sometimes succeeds when split (one
	// of the articles may be triggering server-side issues).
	const singles: (BatchSummary | null)[] = articles.map(() => null);
	const filled = await fillMissingWithSingles(articles, singles);
	const recovered = filled.filter((o) => o !== null).length;
	if (recovered > 0) {
		// At least one recovered → return without error so writes happen.
		// Items still null become per-article errors via the existing
		// missing_in_batch_response path in main.
		return { outputs: filled, error: null };
	}
	return last;
}

// ── Concurrency Pool ───────────────────────────────────────────────────────

interface BatchProgress {
	completed: number;
	total: number;
	processed: number;
	startedAt: number;
}

function _drawProgressBar(p: BatchProgress, width: number = 50): string {
	const frac = p.completed / p.total;
	const filled = Math.round(width * frac);
	const bar = "█".repeat(filled) + "░".repeat(width - filled);
	const pct = (frac * 100).toFixed(1).padStart(5);
	const elapsed = ((Date.now() - p.startedAt) / 1000).toFixed(0);
	const rate =
		p.completed > 0
			? (p.completed / ((Date.now() - p.startedAt) / 1000)).toFixed(2)
			: "0.00";
	const remaining = p.total - p.completed;
	const eta =
		p.completed > 0
			? (
					remaining /
					(p.completed / ((Date.now() - p.startedAt) / 1000)) /
					60
				).toFixed(1)
			: "∞";

	return (
		`[${bar}] ${pct}% ` +
		`(${p.completed}/${p.total}) ` +
		`${rate}/s ` +
		`eta ~${eta}m ` +
		`(${elapsed}s elapsed)`
	);
}

async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, idx: number) => Promise<R>,
	onProgress?: (p: BatchProgress) => void,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	let completed = 0;
	const startedAt = Date.now();

	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const i = cursor++;
				if (i >= items.length) return;
				results[i] = await fn(items[i], i);
				completed++;

				if (onProgress) {
					onProgress({
						completed,
						total: items.length,
						processed: completed,
						startedAt,
					});
				}
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

function loadProgress(): Progress | null {
	try {
		const existing = readFileSync(PROGRESS_FILE, "utf-8");
		return JSON.parse(existing) as Progress;
	} catch (e) {
		// Corrupted/partial file from a crash mid-write: fall back to a fresh
		// Progress instead of crashing the resume.
		console.warn(
			`Could not load progress file (${(e as Error).message}); starting fresh.`,
		);
		return null;
	}
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
	const existing = existsSync(PROGRESS_FILE) ? loadProgress() : null;
	if (existing) {
		progress = existing;
		// Reset startedAt to now so ETA is based on current run
		progress.startedAt = new Date().toISOString();
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
		batchStart += CHECKPOINT_INTERVAL
	) {
		const batchEnd = Math.min(
			batchStart + CHECKPOINT_INTERVAL,
			articles.length,
		);
		const batch = articles.slice(batchStart, batchEnd);

		console.log(
			`\nBatch ${Math.floor(batchStart / CHECKPOINT_INTERVAL) + 1}: processing ${batch.length} articles (${batchStart + 1}–${batchEnd} of ${articles.length})`,
		);

		// Split into API batches of API_BATCH_SIZE articles
		const apiBatches: Article[][] = [];
		for (let i = 0; i < batch.length; i += API_BATCH_SIZE) {
			apiBatches.push(batch.slice(i, i + API_BATCH_SIZE));
		}

		console.log(
			`  ${apiBatches.length} API batch(es) of ${API_BATCH_SIZE} articles`,
		);

		// Process API batches concurrently with live progress bar
		const allResults: {
			article: Article;
			outputs: (BatchSummary | null)[];
			error: string | null;
		}[] = [];
		let completedApiBatches = 0;

		await mapPool(apiBatches, CONCURRENCY, async (apiBatch, idx) => {
			const result = await callQwenBatchWithRetry(apiBatch);
			allResults[idx] = {
				article: apiBatch[0],
				outputs: result.outputs,
				error: result.error,
			};

			// Progress per API batch
			completedApiBatches++;
			const articlesProcessed = Math.min(
				completedApiBatches * API_BATCH_SIZE,
				batch.length,
			);
			const pct = (articlesProcessed / batch.length) * 100;
			const filled = Math.round(50 * (pct / 100));
			const bar = "█".repeat(filled) + "░".repeat(50 - filled);
			const barLine = `[${bar}] ${pct.toFixed(1).padStart(5)}% (${articlesProcessed}/${batch.length})`;
			process.stdout.write(`\r${barLine}   `);

			return allResults[idx];
		});

		// Final newline after progress bar
		console.log();

		// Flatten results: map each article to its summary
		const flatResults: {
			article: Article;
			output: BatchSummary | null;
			error: string | null;
		}[] = [];
		for (let apiBatchIdx = 0; apiBatchIdx < allResults.length; apiBatchIdx++) {
			const apiBatch = apiBatches[apiBatchIdx];
			const { outputs, error } = allResults[apiBatchIdx];

			for (let i = 0; i < apiBatch.length; i++) {
				flatResults.push({
					article: apiBatch[i],
					output: outputs[i] ?? null,
					error: error ?? null,
				});
			}
		}

		// Write results
		for (const { article, output, error } of flatResults) {
			progress.processed++;

			// `null` output means the model dropped this article from the batch
			// (article_id mismatch, partial response, etc). Treat as error so it
			// gets logged and retried — never as a silent "empty".
			const realError =
				error ?? (output === null ? "missing_in_batch_response" : null);

			if (realError) {
				progress.errors++;
				writeFileSync(
					FAILURE_LOG,
					`${JSON.stringify({
						norm_id: article.norm_id,
						block_id: article.block_id,
						error: realError,
						timestamp: new Date().toISOString(),
					})}\n`,
					{ flag: "a" },
				);
				console.log(
					`  ✗ ${article.norm_id}::${article.block_id}: ${realError.slice(0, 60)}`,
				);
			} else if (output && output.citizen_summary === "") {
				// True empty: model explicitly returned "". With minLength:10 in the
				// schema this should be unreachable, but kept as a safety net.
				progress.empty++;
				console.log(
					`  ○ ${article.norm_id}::${article.block_id}: empty (model returned "")`,
				);
			} else if (output) {
				progress.success++;

				if (!DRY_RUN) {
					stmtInsertSummary.run(
						article.norm_id,
						article.block_id,
						output.citizen_summary,
					);
					for (const tag of output.citizen_tags) {
						stmtInsertTag.run(article.norm_id, article.block_id, tag);
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

		if (!DRY_RUN) {
			saveProgress(progress);
		}

		// ETA — guard against zero elapsed (first batch in a fast dry-run can
		// finish in <1ms, which would make rate=Infinity and ETA=NaN).
		const elapsed = Math.max(
			(Date.now() - new Date(progress.startedAt).getTime()) / 1000,
			1,
		);
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

// Write real-time error log for debugging
const ERROR_LOG = "data/backfill-error-debug.log";
function logError(msg: string) {
	try {
		Bun.write(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`, {
			append: true,
		});
	} catch {}
}

main().catch((err) => {
	logError(`Fatal error: ${(err as Error).message}\n${(err as Error).stack}`);
	process.exit(1);
});
