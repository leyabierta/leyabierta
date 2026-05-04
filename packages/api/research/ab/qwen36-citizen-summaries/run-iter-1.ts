/**
 * A/B harness: Gemini 2.5 Flash Lite (production) vs Qwen 3.6 (hermes / nan.builders)
 * for citizen-article-summary generation.
 *
 * Goal: decide whether Qwen 3.6 produces summaries good enough to backfill the
 * 433K articles that currently have no citizen summary (only 0.7% covered).
 *
 * The harness reuses production SYSTEM_PROMPT + SCHEMA from citizen-summary.ts
 * verbatim — no prompt tuning per model in this round. Same input, same prompt,
 * same schema → fair comparison.
 *
 * Output: blind report (random A/B label per case) + key file (mapping + metrics).
 * A separate judging step (parallel Sonnet sub-agents) reads the blind report.
 *
 * Usage:
 *   bun run packages/api/research/ab/qwen36-citizen-summaries/run.ts [N]
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = "data/leyabierta.db";
const OUT_DIR_BASE = "packages/api/research/ab/qwen36-citizen-summaries";

const N_TOTAL = Number(process.argv[2] ?? 30);

const STRATA: { label: string; where: string; n: number }[] = [
	{
		label: "constitucion-ley_organica",
		where: "n.rank IN ('constitucion','ley_organica')",
		n: 6,
	},
	{
		label: "ley-fiscal-laboral",
		where:
			"n.rank = 'ley' AND (n.title LIKE '%IRPF%' OR n.title LIKE '%Impuesto%' OR n.title LIKE '%Estatuto%' OR n.title LIKE '%Trabajadores%' OR n.title LIKE '%Seguridad Social%')",
		n: 6,
	},
	{
		label: "ley-general",
		where:
			"n.rank = 'ley' AND n.title NOT LIKE '%IRPF%' AND n.title NOT LIKE '%Impuesto%' AND n.title NOT LIKE '%Estatuto%' AND n.title NOT LIKE '%Trabajadores%' AND n.title NOT LIKE '%Seguridad Social%'",
		n: 6,
	},
	{
		label: "real_decreto",
		where: "n.rank = 'real_decreto'",
		n: 6,
	},
	{
		label: "autonomica",
		where: "n.jurisdiction != 'es' AND n.jurisdiction != ''",
		n: 6,
	},
];

interface SampleRow {
	stratum: string;
	norm_id: string;
	norm_title: string;
	jurisdiction: string;
	rank: string;
	block_id: string;
	block_title: string;
	current_text: string;
}

function sampleArticles(): SampleRow[] {
	const db = new Database(DB_PATH, { readonly: true });
	const out: SampleRow[] = [];
	for (const stratum of STRATA) {
		const rows = db
			.prepare(
				`SELECT n.id AS norm_id, n.title AS norm_title, n.jurisdiction, n.rank,
				        b.block_id, b.title AS block_title, b.current_text
				   FROM norms n
				   JOIN blocks b ON b.norm_id = n.id
				  WHERE n.status = 'vigente'
				    AND b.block_type = 'precepto'
				    AND length(b.current_text) BETWEEN 200 AND 2000
				    AND NOT EXISTS (
				          SELECT 1 FROM citizen_article_summaries c
				           WHERE c.norm_id = n.id AND c.block_id = b.block_id)
				    AND ${stratum.where}
				  ORDER BY random()
				  LIMIT ${stratum.n}`,
			)
			.all() as Omit<SampleRow, "stratum">[];
		for (const r of rows) out.push({ stratum: stratum.label, ...r });
	}
	db.close();
	return out;
}

// Production prompt + schema, copied verbatim from packages/api/src/services/citizen-summary.ts
// Keep in sync if production prompt changes.
const SYSTEM_PROMPT = `Eres un redactor institucional que traduce artículos legales españoles a lenguaje accesible para ciudadanos.

Tono: serio e informativo, como una institución pública que explica derechos y obligaciones. NO uses tono coloquial ni de blog. Evita jerga jurídica, pero mantén la seriedad. Ejemplo: "Tienes derecho a..." es correcto; "Puedes..." es demasiado informal.

- citizen_tags: 3-5 tags en español llano, como buscaría un ciudadano normal.
- citizen_summary: Resumen de máximo 280 caracteres. Lenguaje claro y serio, sin jerga legal. Con acentos correctos. Incluye los datos concretos más relevantes (plazos, requisitos, cantidades) cuando los haya.

**CUÁNDO DEVOLVER VACÍO (SOLO estos casos):**
Devuelve citizen_summary vacío Y SOLO si el artículo es una de estas cosas:
  1. Declara la entrada en vigor de la norma (ej. "Esta ley entrará en vigor el día siguiente al de su publicación").
  2. Deroga o modifica otra norma (ej. "Se deroga el artículo X de la Ley Y").
  3. Asigna rango de ley orgánica a algo.
  4. Contenido puramente organizativo interno sin efecto sobre derechos u obligaciones ciudadanas.

**IMPORTANTE — Los siguientes SÍ requieren resumen:**
- Artículos que describen procedimientos, reglas de funcionamiento, composición de órganos, requisitos administrativos, plazos, competencias, o cualquier contenido sustantivo.
- En caso de duda, genera siempre un resumen breve. Es mejor un resumen corto que ninguno.`;

const SCHEMA = {
	type: "object",
	properties: {
		citizen_tags: { type: "array", items: { type: "string" } },
		citizen_summary: { type: "string" },
	},
	required: ["citizen_tags", "citizen_summary"],
	additionalProperties: false,
} as const;

interface Output {
	citizen_summary: string;
	citizen_tags: string[];
}

interface ProviderResult {
	output: Output | null;
	error: string | null;
	latency_ms: number;
	tokens_in: number;
	tokens_out: number;
}

interface ProviderConfig {
	id: "gemini" | "qwen";
	baseUrl: string;
	apiKey: string;
	model: string;
	extraHeaders?: Record<string, string>;
	// Qwen is a thinking model; needs more tokens to fit reasoning + output.
	maxTokens: number;
}

async function callChat(
	cfg: ProviderConfig,
	systemPrompt: string,
	userPrompt: string,
): Promise<ProviderResult> {
	const start = Date.now();
	try {
		const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
			method: "POST",
			signal: AbortSignal.timeout(120_000),
			headers: {
				Authorization: `Bearer ${cfg.apiKey}`,
				"Content-Type": "application/json",
				...(cfg.extraHeaders ?? {}),
			},
			body: JSON.stringify({
				model: cfg.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				temperature: 0.2,
				max_tokens: cfg.maxTokens,
				response_format: {
					type: "json_schema",
					json_schema: { name: "citizen_metadata", strict: true, schema: SCHEMA },
				},
			}),
		});
		if (!res.ok) {
			return {
				output: null,
				error: `http_${res.status}: ${(await res.text()).slice(0, 200)}`,
				latency_ms: Date.now() - start,
				tokens_in: 0,
				tokens_out: 0,
			};
		}
		const data = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		const text = data.choices?.[0]?.message?.content ?? "";
		let parsed: Output | null = null;
		let parseErr: string | null = null;
		try {
			parsed = JSON.parse(text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""));
		} catch (e) {
			parseErr = `json_parse: ${(e as Error).message}: ${text.slice(0, 200)}`;
		}
		return {
			output: parsed,
			error: parseErr,
			latency_ms: Date.now() - start,
			tokens_in: data.usage?.prompt_tokens ?? 0,
			tokens_out: data.usage?.completion_tokens ?? 0,
		};
	} catch (e) {
		return {
			output: null,
			error: `fetch_error: ${(e as Error).message}`,
			latency_ms: Date.now() - start,
			tokens_in: 0,
			tokens_out: 0,
		};
	}
}

// Concurrency limiter: max N in flight
async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const i = cursor++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

function userPromptFor(row: SampleRow): string {
	return `LEY: ${row.norm_title}\n\nARTÍCULO:\n${row.block_title}\n${row.current_text.slice(0, 2000)}`;
}

async function main() {
	const openrouterKey = process.env.OPENROUTER_API_KEY;
	const hermesKey = process.env.HERMES_API_KEY ?? "sk-1WqPsfFrl3YHyBg52xRvTg";
	const hermesUrl = process.env.HERMES_BASE_URL ?? "https://api.nan.builders/v1";
	if (!openrouterKey) throw new Error("OPENROUTER_API_KEY required");

	const gemini: ProviderConfig = {
		id: "gemini",
		baseUrl: "https://openrouter.ai/api/v1",
		apiKey: openrouterKey,
		model: "google/gemini-2.5-flash-lite",
		extraHeaders: { "HTTP-Referer": "https://leyabierta.es", "X-Title": "Ley Abierta AB" },
		maxTokens: 500,
	};
	const qwen: ProviderConfig = {
		id: "qwen",
		baseUrl: hermesUrl,
		apiKey: hermesKey,
		model: "qwen3.6",
		maxTokens: 8000, // thinking model; needs headroom for reasoning + JSON output
	};

	console.log(`Sampling ${N_TOTAL} articles…`);
	const sample = sampleArticles();
	console.log(`  got ${sample.length} (target ${N_TOTAL}).`);
	for (const s of STRATA) {
		const got = sample.filter((r) => r.stratum === s.label).length;
		console.log(`    ${s.label}: ${got}/${s.n}`);
	}

	const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const outDir = join(OUT_DIR_BASE, `run-${runId}`);
	mkdirSync(outDir, { recursive: true });

	writeFileSync(
		join(outDir, "inputs.jsonl"),
		sample.map((r) => JSON.stringify(r)).join("\n"),
	);

	// Generate. Both providers in parallel per case; Qwen capped at 5 concurrent (rate limit).
	console.log(`\nGenerating Gemini (parallel, no concurrency cap on OR side)…`);
	const geminiResults = await mapPool(sample, 10, (row) =>
		callChat(gemini, SYSTEM_PROMPT, userPromptFor(row)),
	);

	console.log(`Generating Qwen (max 5 concurrent, rate-limit safe)…`);
	const qwenResults = await mapPool(sample, 5, (row) =>
		callChat(qwen, SYSTEM_PROMPT, userPromptFor(row)),
	);

	// Random-blind A/B label assignment per case (seed-free; just Math.random).
	const cases = sample.map((row, i) => {
		const gm = geminiResults[i];
		const qw = qwenResults[i];
		const qwenIsX = Math.random() < 0.5;
		return {
			case_id: i + 1,
			row,
			x_provider: qwenIsX ? "qwen" : "gemini",
			y_provider: qwenIsX ? "gemini" : "qwen",
			x_result: qwenIsX ? qw : gm,
			y_result: qwenIsX ? gm : qw,
			gemini: gm,
			qwen: qw,
		};
	});

	// outputs.jsonl: full data including provider mapping
	writeFileSync(
		join(outDir, "outputs.jsonl"),
		cases.map((c) => JSON.stringify(c)).join("\n"),
	);

	// report-key.json: mapping table only (case_id → which side is which)
	const key = cases.map((c) => ({
		case_id: c.case_id,
		x_provider: c.x_provider,
		y_provider: c.y_provider,
		gemini_latency_ms: c.gemini.latency_ms,
		qwen_latency_ms: c.qwen.latency_ms,
		gemini_tokens_out: c.gemini.tokens_out,
		qwen_tokens_out: c.qwen.tokens_out,
		gemini_error: c.gemini.error,
		qwen_error: c.qwen.error,
	}));
	writeFileSync(join(outDir, "report-key.json"), JSON.stringify(key, null, 2));

	// report-blind.md: human-readable, NO provider labels
	const lines: string[] = [];
	lines.push(`# A/B blind report — Citizen Summaries`);
	lines.push(``);
	lines.push(`Run: ${runId}`);
	lines.push(`Cases: ${cases.length}`);
	lines.push(``);
	lines.push(`Each case shows the original article and two candidate summaries (X and Y).`);
	lines.push(`X / Y mapping is randomized per case and stored in report-key.json.`);
	lines.push(``);
	lines.push(`---`);
	lines.push(``);
	for (const c of cases) {
		lines.push(`## Caso ${c.case_id} — \`${c.row.norm_id}\` / \`${c.row.block_id}\``);
		lines.push(``);
		lines.push(`**Stratum:** ${c.row.stratum}  `);
		lines.push(`**Ley:** ${c.row.norm_title.slice(0, 120)}  `);
		lines.push(`**Jurisdicción:** ${c.row.jurisdiction || "es"} · **Rango:** ${c.row.rank}`);
		lines.push(``);
		lines.push(`### Artículo original`);
		lines.push(``);
		lines.push(`**${c.row.block_title}**`);
		lines.push(``);
		lines.push("```");
		lines.push(c.row.current_text.slice(0, 1500));
		lines.push("```");
		lines.push(``);
		lines.push(`### Resumen X`);
		lines.push(``);
		if (c.x_result.error) {
			lines.push(`> ⚠ Error: ${c.x_result.error}`);
		} else if (!c.x_result.output) {
			lines.push(`> ⚠ Sin output`);
		} else {
			lines.push(`> ${c.x_result.output.citizen_summary || "_(vacío)_"}`);
			lines.push(``);
			lines.push(
				`Tags: ${(c.x_result.output.citizen_tags ?? []).map((t) => `\`${t}\``).join(", ") || "_(ninguno)_"}`,
			);
		}
		lines.push(``);
		lines.push(`### Resumen Y`);
		lines.push(``);
		if (c.y_result.error) {
			lines.push(`> ⚠ Error: ${c.y_result.error}`);
		} else if (!c.y_result.output) {
			lines.push(`> ⚠ Sin output`);
		} else {
			lines.push(`> ${c.y_result.output.citizen_summary || "_(vacío)_"}`);
			lines.push(``);
			lines.push(
				`Tags: ${(c.y_result.output.citizen_tags ?? []).map((t) => `\`${t}\``).join(", ") || "_(ninguno)_"}`,
			);
		}
		lines.push(``);
		lines.push(`### Veredicto`);
		lines.push(``);
		lines.push(`- [ ] X claramente mejor`);
		lines.push(`- [ ] Y claramente mejor`);
		lines.push(`- [ ] Empate aceptable (ambos válidos)`);
		lines.push(`- [ ] Empate malo (ambos fallan)`);
		lines.push(``);
		lines.push(`**Notas:** _(qué chirría en cada uno)_`);
		lines.push(``);
		lines.push(`---`);
		lines.push(``);
	}
	writeFileSync(join(outDir, "report-blind.md"), lines.join("\n"));

	// Summary stats
	const errs = (rs: ProviderResult[]) => rs.filter((r) => r.error).length;
	const lat = (rs: ProviderResult[]) =>
		rs.length === 0 ? 0 : Math.round(rs.reduce((a, r) => a + r.latency_ms, 0) / rs.length);
	const tok = (rs: ProviderResult[]) =>
		rs.length === 0 ? 0 : Math.round(rs.reduce((a, r) => a + r.tokens_out, 0) / rs.length);

	console.log(`\nDone. Output: ${outDir}/`);
	console.log(``);
	console.log(`Gemini  errors: ${errs(geminiResults)}/${cases.length}  · avg latency: ${lat(geminiResults)}ms · avg tokens_out: ${tok(geminiResults)}`);
	console.log(`Qwen    errors: ${errs(qwenResults)}/${cases.length}  · avg latency: ${lat(qwenResults)}ms · avg tokens_out: ${tok(qwenResults)}`);
}

await main();
