/**
 * Generate citizen article summaries incrementally for vigente articles.
 *
 * Default mode is incremental: finds vigente articles missing a row in
 * `citizen_article_summaries` and generates them via qwen3.6 on NaN.
 * Safe to run from cron — it's a no-op when all articles are covered.
 *
 * Uses the same prompt, schema, and batching logic as
 * `backfill-citizen-summaries.ts` but is lightweight and cron-friendly:
 * no progress files, no checkpoint tables, no heavy in-process state.
 *
 * Usage:
 *   bun run packages/api/src/scripts/generate-article-summaries.ts
 *   bun run packages/api/src/scripts/generate-article-summaries.ts --dry-run
 *   bun run packages/api/src/scripts/generate-article-summaries.ts --limit 100
 *   bun run packages/api/src/scripts/generate-article-summaries.ts --norm-ids BOE-A-1978-31229,BOE-A-2020-12345
 *
 * Auth: reads NAN_API_KEY only (no HERMES_API_KEY fallback).
 *
 * Target scope: vigente articles (block_type='precepto', length >= 200 chars)
 * not yet present in citizen_article_summaries.
 */

import { Database } from "bun:sqlite";
import { requireNanApiKey } from "../services/nan-api-key.ts";

// ── Configuration ─────────────────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH ?? "data/leyabierta.db";
const NAN_BASE_URL = "https://api.nan.builders/v1";

// Articles > this threshold go solo (1 per API call) instead of being grouped.
// Qwen 3.6 has 256K context so any article fits, but batching huge articles
// wastes retry budget when a truncation breaks one item in the group.
const SOLO_THRESHOLD_CHARS = 5000;

// Max articles per API call for short articles.
// Kept low for qwen3.6 chat (heavier than embedding) to minimise retry waste.
const API_BATCH_SIZE = 4;

const CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 180_000; // 3 minutes per call
const MAX_ATTEMPTS = 8;

// ── CLI Arguments ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1] ?? 100) : 0;
const normIdsIdx = args.indexOf("--norm-ids");
const EXPLICIT_NORM_IDS: string[] | undefined =
	normIdsIdx >= 0
		? args[normIdsIdx + 1]?.split(",").filter(Boolean)
		: undefined;

if (LIMIT < 0 || (LIMIT > 0 && !Number.isInteger(LIMIT))) {
	console.error("Invalid --limit value. Must be a non-negative integer.");
	process.exit(1);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

const NAN_API_KEY = DRY_RUN ? "dry-run" : requireNanApiKey();

// ── Database ──────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 60000");

const stmtInsertSummary = db.prepare(
	"INSERT OR REPLACE INTO citizen_article_summaries (norm_id, block_id, summary) VALUES (?, ?, ?)",
);
const stmtInsertTag = db.prepare(
	"INSERT OR REPLACE INTO citizen_tags (norm_id, block_id, tag) VALUES (?, ?, ?)",
);

// ── Article Discovery ─────────────────────────────────────────────────────────

interface Article {
	norm_id: string;
	block_id: string;
	norm_title: string;
	block_title: string;
	current_text: string;
}

function findMissingArticles(): Article[] {
	const baseWhere = `
		WHERE n.status = 'vigente'
		  AND b.block_type = 'precepto'
		  AND length(b.current_text) >= 200
		  AND NOT EXISTS (
			SELECT 1 FROM citizen_article_summaries c
			WHERE c.norm_id = n.id AND c.block_id = b.block_id
		  )`;

	let query: string;
	let params: (string | number)[];

	if (EXPLICIT_NORM_IDS && EXPLICIT_NORM_IDS.length > 0) {
		const placeholders = EXPLICIT_NORM_IDS.map(() => "?").join(",");
		query = `
			SELECT n.id AS norm_id, n.title AS norm_title,
			       b.block_id, b.title AS block_title, b.current_text
			FROM norms n
			JOIN blocks b ON b.norm_id = n.id
			${baseWhere}
			  AND n.id IN (${placeholders})
			ORDER BY n.id, b.block_id`;
		params = [...EXPLICIT_NORM_IDS];
	} else {
		query = `
			SELECT n.id AS norm_id, n.title AS norm_title,
			       b.block_id, b.title AS block_title, b.current_text
			FROM norms n
			JOIN blocks b ON b.norm_id = n.id
			${baseWhere}
			ORDER BY n.id, b.block_id`;
		params = [];
	}

	if (LIMIT > 0) {
		query += ` LIMIT ?`;
		params.push(LIMIT);
	}

	return db.prepare(query).all(...params) as Article[];
}

// ── Qwen 3.6 Prompt (same as backfill-citizen-summaries.ts v10) ───────────────

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

// ── JSON Schema for batch output ──────────────────────────────────────────────

const BATCH_SCHEMA = {
	name: "citizen_metadata_batch",
	strict: true,
	schema: {
		type: "array",
		items: {
			type: "object",
			properties: {
				article_id: { type: "string" },
				// No minLength/maxLength: NaN endpoint hangs when structural constraints
				// are in the schema. Length validation happens downstream.
				citizen_summary: { type: "string" },
				citizen_tags: {
					type: "array",
					items: { type: "string" },
				},
			},
			required: ["article_id", "citizen_summary", "citizen_tags"],
			additionalProperties: false,
		},
	},
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface BatchSummary {
	article_id: string;
	citizen_summary: string;
	citizen_tags: string[];
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildBatchPrompt(articles: Article[]): string {
	return (
		articles
			.map(
				(a, i) =>
					`ARTÍCULO_${i + 1}:\nLEY: ${a.norm_title}\nTÍTULO: ${a.block_title}\nTEXTO:\n${a.current_text}`,
			)
			.join("\n\n") +
		"\n\nGenera un resumen para cada artículo. Usa article_id como identificador único."
	);
}

// ── API call with retries ─────────────────────────────────────────────────────

async function callQwenBatch(
	articles: Article[],
): Promise<{ outputs: (BatchSummary | null)[]; error: string | null }> {
	const prompt = buildBatchPrompt(articles);
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const res = await fetch(`${NAN_BASE_URL}/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${NAN_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "qwen3.6",
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: prompt },
				],
				temperature: 0.2,
				max_tokens: 2000,
				// Thinking-off: A/B with Sonnet judge showed thinking-OFF is ~9x
				// faster (3s vs 28s), 0% errors vs 20% with thinking, and slightly
				// higher quality. See backfill-citizen-summaries.ts ADR 2026-05-06.
				chat_template_kwargs: { enable_thinking: false },
				response_format: { type: "json_schema", json_schema: BATCH_SCHEMA },
			}),
		});

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
			(t: string) => JSON.parse(t),
			(t: string) =>
				JSON.parse(t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")),
			(t: string) => {
				const first = t.indexOf("[");
				const last = t.lastIndexOf("]");
				if (first !== -1 && last !== -1 && last > first) {
					return JSON.parse(t.slice(first, last + 1));
				}
				throw new Error("No JSON array found");
			},
			(t: string) => {
				const first = t.indexOf("{");
				const last = t.lastIndexOf("}");
				if (first !== -1 && last !== -1 && last > first) {
					return JSON.parse(t.slice(first, last + 1));
				}
				throw new Error("No JSON object found");
			},
		];

		let parseError = "";
		for (const extractor of extractors) {
			try {
				const raw = extractor(text);
				if (Array.isArray(raw)) {
					parsed = raw;
					break;
				}
				if (
					typeof raw === "object" &&
					raw !== null &&
					"citizen_summary" in raw
				) {
					parsed = [raw as BatchSummary];
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

		// Map by article_id. For single-article calls, accept any single result
		// regardless of article_id (model sometimes returns the article number).
		const outputs: (BatchSummary | null)[] = (() => {
			if (articles.length === 1 && parsed.length === 1 && parsed[0]) {
				return [parsed[0]];
			}
			const byId = new Map<string, BatchSummary>();
			for (const p of parsed) {
				if (p.article_id) byId.set(p.article_id, p);
			}
			return articles.map((_a, i) => byId.get(`ARTÍCULO_${i + 1}`) ?? null);
		})();

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

// Single-article fallback for any position the batch left as null.
async function fillMissingSingles(
	articles: Article[],
	outputs: (BatchSummary | null)[],
): Promise<(BatchSummary | null)[]> {
	for (let i = 0; i < articles.length; i++) {
		if (outputs[i] !== null) continue;
		const a = articles[i];
		if (!a) continue;
		const single = await callQwenBatch([a]);
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
		if (result.outputs.some((o) => o === null)) {
			result.outputs = await fillMissingSingles(articles, result.outputs);
		}
		return result;
	}

	let last = result;
	for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
		const err = last.error ?? "";
		let waitMs: number;

		if (err.includes("429")) {
			waitMs = 65_000 + Math.random() * 5_000;
		} else if (
			err.includes("timeout") ||
			err.includes("524") ||
			/http_5\d\d/.test(err)
		) {
			const schedule = [10_000, 30_000, 60_000, 120_000, 180_000, 240_000];
			const base =
				schedule[Math.min(attempt - 1, schedule.length - 1)] ?? 10_000;
			waitMs = base + Math.random() * (base / 4);
		} else if (err.includes("json_parse")) {
			waitMs = 1_500 + Math.random() * 1_500 + attempt * 1_000;
		} else {
			waitMs = 1_000 + Math.random() * 1_000;
		}

		await new Promise((r) => setTimeout(r, waitMs));
		const next = await callQwenBatch(articles);
		if (!next.error) {
			if (next.outputs.some((o) => o === null)) {
				next.outputs = await fillMissingSingles(articles, next.outputs);
			}
			return next;
		}
		last = next;
	}

	// Last resort: individual articles — a persistent 5xx on a batch sometimes
	// succeeds when split (one article may be triggering server-side issues).
	const singles: (BatchSummary | null)[] = articles.map(() => null);
	const filled = await fillMissingSingles(articles, singles);
	if (filled.some((o) => o !== null)) {
		return { outputs: filled, error: null };
	}
	return last;
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function mapPool<T, R>(
	items: T[],
	poolSize: number,
	fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(poolSize, items.length) },
		async () => {
			while (true) {
				const i = cursor++;
				if (i >= items.length) return;
				const item = items[i] as T;
				results[i] = await fn(item, i);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	console.log("=== Incremental citizen article summaries ===");

	const articles = findMissingArticles();
	const distinctNorms = new Set(articles.map((a) => a.norm_id)).size;

	console.log(
		`Found ${articles.length} articles missing summaries across ${distinctNorms} norms`,
	);
	console.log(
		`Dry run: ${DRY_RUN} | Limit: ${LIMIT > 0 ? LIMIT : "all"} | Concurrency: ${CONCURRENCY}`,
	);

	if (articles.length === 0) {
		console.log("Nothing to do. All vigente articles have summaries.");
		return;
	}

	if (DRY_RUN) {
		const totalChars = articles.reduce((s, a) => s + a.current_text.length, 0);
		const estTokens = Math.round(totalChars / 4);
		console.log(
			`\n[dry-run] Would process ${articles.length} articles (~${estTokens.toLocaleString()} input tokens, $0 via NaN)`,
		);
		console.log(
			`Sample: ${articles[0]?.norm_title} — ${articles[0]?.block_title}`,
		);
		return;
	}

	// Split articles into API batches: long ones go solo, short ones group up.
	const apiBatches: Article[][] = [];
	let acc: Article[] = [];
	for (const article of articles) {
		if (article.current_text.length > SOLO_THRESHOLD_CHARS) {
			if (acc.length > 0) {
				apiBatches.push(acc);
				acc = [];
			}
			apiBatches.push([article]);
		} else {
			acc.push(article);
			if (acc.length >= API_BATCH_SIZE) {
				apiBatches.push(acc);
				acc = [];
			}
		}
	}
	if (acc.length > 0) apiBatches.push(acc);

	console.log(
		`Dispatching ${apiBatches.length} API calls (batch size ${API_BATCH_SIZE}, solo threshold ${SOLO_THRESHOLD_CHARS} chars)`,
	);

	let success = 0;
	let errors = 0;
	let empty = 0;
	const startedAt = Date.now();

	const batchResults = await mapPool(
		apiBatches,
		CONCURRENCY,
		async (batch, batchIdx) => {
			const result = await callQwenBatchWithRetry(batch);
			return { batch, result, batchIdx };
		},
	);

	for (const { batch, result } of batchResults) {
		const { outputs, error: batchError } = result;

		for (let i = 0; i < batch.length; i++) {
			const article = batch[i] as Article;
			const output = outputs[i] ?? null;
			const itemError =
				batchError ?? (output === null ? "missing_in_batch_response" : null);

			if (itemError) {
				errors++;
				console.warn(
					`  ✗ ${article.norm_id}::${article.block_id} — ${itemError.slice(0, 120)}`,
				);
				continue;
			}

			if (!output || output.citizen_summary === "") {
				empty++;
				continue;
			}

			// Atomic write per row: if a write fails, we don't lose the rest.
			db.exec("BEGIN IMMEDIATE");
			try {
				stmtInsertSummary.run(
					article.norm_id,
					article.block_id,
					output.citizen_summary,
				);
				for (const tag of output.citizen_tags) {
					stmtInsertTag.run(article.norm_id, article.block_id, tag);
				}
				db.exec("COMMIT");
				success++;
			} catch (writeErr) {
				db.exec("ROLLBACK");
				errors++;
				console.warn(
					`  ✗ DB write failed for ${article.norm_id}::${article.block_id}: ${(writeErr as Error).message}`,
				);
			}
		}
	}

	const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
	console.log(`\n=== Done in ${elapsed}s ===`);
	console.log(
		`Success: ${success}  Empty: ${empty}  Errors: ${errors}  Total: ${articles.length}`,
	);
}

main().catch((err) => {
	console.error(`Fatal: ${(err as Error).message}`);
	process.exit(1);
});
