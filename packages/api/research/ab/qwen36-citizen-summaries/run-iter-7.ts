/**
 * A/B harness iteration 7: Few-shot examples targeting empty-article failure mode.
 * Gemini outputs loaded from cache (gemini-cache.json) — no API calls.
 *
 * Change from iter-6: Add 4 few-shot examples in the system prompt showing
 * borderline articles that MUST get a summary (not empty), including:
 *   - Procedural articles with real citizen impact (compositions, deadlines)
 *   - Articles about organizational rules that affect rights
 *   - Borderline "empty" articles that should still get a short summary
 *   - A clear "truly empty" example for contrast
 *
 * This tests whether few-shot learning can override Qwen's tendency to over-apply
 * the "return empty" rule to substantive articles.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Iteration 7: Few-shot examples targeting empty-article failure mode.
// Added 4 examples: 3 borderline cases that MUST get summaries + 1 clear empty case.
const SYSTEM_PROMPT = `Eres un redactor institucional que traduce artículos legales españoles a lenguaje accesible para ciudadanos.

**REGISTRO OBLIGATORIO — TERCERA PERSONA:**
El resumen SIEMPRE debe escribirse en tercera persona. PROHIBIDO usar segunda persona (tú, tu, tienes, puedes, te, le, les). Usa construcciones impersonales o de tercera persona:
- ✅ "El ciudadano tiene derecho a..." / "La persona investigada puede solicitar..." / "Se establece que..."
- ✅ "Los funcionarios que falseen..." / "Las sanciones se gradúan..."
- ❌ "Tienes derecho a..." / "Puedes ejercer..." / "tus datos personales"
- ❌ "Usted tiene derecho a..." (tampoco, usa tercera persona)

**NO AÑADIR COMENTARIOS EDITORIALES:**
El resumen debe contener ÚNICAMENTE información presente en el artículo original. PROHIBIDO:
- Añadir frases de conclusión o interpretación que no estén en el texto (ej. "Estas inspecciones garantizan el control...")
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
	maxTokens: number;
}

async function callChat(
	cfg: ProviderConfig,
	systemPrompt: string,
	userPrompt: string,
	timeoutMs: number = 180_000,
): Promise<ProviderResult> {
	const start = Date.now();
	try {
		const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
			method: "POST",
			signal: AbortSignal.timeout(timeoutMs),
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
					json_schema: {
						name: "citizen_metadata",
						strict: true,
						schema: SCHEMA,
					},
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
			choices?: { message?: { content?: string } };
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		const text = data.choices?.[0]?.message?.content ?? "";
		let parsed: Output | null = null;
		let parseErr: string | null = null;
		try {
			parsed = JSON.parse(
				text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, ""),
			);
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

function userPromptFor(row: SampleRow): string {
	return `LEY: ${row.norm_title}\n\nARTÍCULO:\n${row.block_title}\n${row.current_text.slice(0, 2000)}`;
}

async function main() {
	const openrouterKey = process.env.OPENROUTER_API_KEY;
	const hermesKey = process.env.HERMES_API_KEY ?? "";
	const hermesUrl =
		process.env.HERMES_BASE_URL ?? "https://api.nan.builders/v1";
	if (!openrouterKey) throw new Error("OPENROUTER_API_KEY required");

	const gemini: ProviderConfig = {
		id: "gemini",
		baseUrl: "https://openrouter.ai/api/v1",
		apiKey: openrouterKey,
		model: "google/gemini-2.5-flash-lite",
		extraHeaders: {
			"HTTP-Referer": "https://leyabierta.es",
			"X-Title": "Ley Abierta AB",
		},
		maxTokens: 500,
	};
	const qwen: ProviderConfig = {
		id: "qwen",
		baseUrl: hermesUrl,
		apiKey: hermesKey,
		model: "qwen3.6",
		maxTokens: 32000, // thinking model; no token limit on Qwen endpoint
	};

	console.log(`Sampling ${N_TOTAL} articles...`);
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

	// Load Gemini cache
	const cachePath = join(OUT_DIR_BASE, "gemini-cache.json");
	let geminiCache: Record<
		string,
		{ citizen_summary: string; citizen_tags: string[] }
	> = {};
	if (existsSync(cachePath)) {
		geminiCache = JSON.parse(readFileSync(cachePath, "utf-8"));
		console.log(
			`  Loaded ${Object.keys(geminiCache).length} cached Gemini outputs.`,
		);
	}

	// Generate Gemini from cache (no API calls)
	console.log("\nGenerating Gemini from cache...");
	const geminiResults: ProviderResult[] = [];
	let cached = 0;
	let miss = 0;
	for (const row of sample) {
		const key = `${row.norm_id}::${row.block_id}`;
		const cachedData = geminiCache[key];
		if (cachedData) {
			geminiResults.push({
				output: {
					citizen_summary: cachedData.citizen_summary,
					citizen_tags: cachedData.citizen_tags,
				},
				error: null,
				latency_ms: 0,
				tokens_in: 0,
				tokens_out: 0,
			});
			cached++;
		} else {
			// Cache miss — call API as fallback
			console.log(`  Cache miss for ${key}, calling API...`);
			const r = await callChat(gemini, SYSTEM_PROMPT, userPromptFor(row));
			geminiResults.push(r);
			miss++;
		}
	}
	console.log(`  Cached: ${cached}, API fallback: ${miss}`);

	// Retry wrapper for Qwen
	async function callQwenWithRetry(row: SampleRow): Promise<ProviderResult> {
		const result = await callChat(
			qwen,
			SYSTEM_PROMPT,
			userPromptFor(row),
			180_000,
		);
		if (result.error) {
			const idx = sample.indexOf(row) + 1;
			const isRateLimit = result.error.includes("429");
			const is524 = result.error.includes("524");
			console.log(
				`  Case ${idx}: Qwen error (${result.error.slice(0, 60)}), retrying${isRateLimit ? " (65s wait)" : ""}...`,
			);
			if (isRateLimit) {
				await new Promise((r) => setTimeout(r, 65_000));
			}
			const result2 = await callChat(
				qwen,
				SYSTEM_PROMPT,
				userPromptFor(row),
				180_000,
			);
			if (result2.error) {
				if (is524) {
					console.log(
						`  Case ${idx}: Retry 2 failed (${result2.error.slice(0, 40)}), trying once more...`,
					);
					await new Promise((r) => setTimeout(r, 2000));
					return callChat(qwen, SYSTEM_PROMPT, userPromptFor(row), 180_000);
				}
			}
			return result2;
		}
		return result;
	}

	// Generate Qwen
	console.log(
		"Generating Qwen (max 5 concurrent, rate-limit safe, with retry)...",
	);
	const qwenResults = await mapPool(sample, 5, (row) => callQwenWithRetry(row));

	// Random-blind A/B label assignment per case
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

	// outputs.jsonl
	writeFileSync(
		join(outDir, "outputs.jsonl"),
		cases.map((c) => JSON.stringify(c)).join("\n"),
	);

	// report-key.json
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

	// report-blind.md
	const lines: string[] = [];
	lines.push("# A/B blind report -- Citizen Summaries");
	lines.push("");
	lines.push(`Run: ${runId}`);
	lines.push(`Cases: ${cases.length}`);
	lines.push("");
	lines.push(
		"Each case shows the original article and two candidate summaries (X and Y).",
	);
	lines.push(
		"X / Y mapping is randomized per case and stored in report-key.json.",
	);
	lines.push("");
	lines.push("---");
	lines.push("");
	for (const c of cases) {
		lines.push(
			`## Caso ${c.case_id} -- \`${c.row.norm_id}\` / \`${c.row.block_id}\``,
		);
		lines.push("");
		lines.push(`**Stratum:** ${c.row.stratum}  `);
		lines.push(`**Ley:** ${c.row.norm_title.slice(0, 120)}  `);
		lines.push(
			`**Jurisdicción:** ${c.row.jurisdiction || "es"} · **Rango:** ${c.row.rank}`,
		);
		lines.push("");
		lines.push("### Artículo original");
		lines.push("");
		lines.push(`**${c.row.block_title}**`);
		lines.push("");
		lines.push("```");
		lines.push(c.row.current_text.slice(0, 1500));
		lines.push("```");
		lines.push("");
		lines.push("### Resumen X");
		lines.push("");
		if (c.x_result.error) {
			lines.push(`> Error: ${c.x_result.error}`);
		} else if (!c.x_result.output) {
			lines.push("> Sin output");
		} else {
			lines.push(`> ${c.x_result.output.citizen_summary || "_(vacío)_"}`);
			lines.push("");
			lines.push(
				`Tags: ${(c.x_result.output.citizen_tags ?? []).map((t) => `\`${t}\``).join(", ") || "_(ninguno)_"}`,
			);
		}
		lines.push("");
		lines.push("### Resumen Y");
		lines.push("");
		if (c.y_result.error) {
			lines.push(`> Error: ${c.y_result.error}`);
		} else if (!c.y_result.output) {
			lines.push("> Sin output");
		} else {
			lines.push(`> ${c.y_result.output.citizen_summary || "_(vacío)_"}`);
			lines.push("");
			lines.push(
				`Tags: ${(c.y_result.output.citizen_tags ?? []).map((t) => `\`${t}\``).join(", ") || "_(ninguno)_"}`,
			);
		}
		lines.push("");
		lines.push("### Veredicto");
		lines.push("");
		lines.push("- [ ] X claramente mejor");
		lines.push("- [ ] Y claramente mejor");
		lines.push("- [ ] Empate aceptable (ambos válidos)");
		lines.push("- [ ] Empate malo (ambos fallan)");
		lines.push("");
		lines.push("**Notas:** _(qué chirría en cada uno)_");
		lines.push("");
		lines.push("---");
		lines.push("");
	}
	writeFileSync(join(outDir, "report-blind.md"), lines.join("\n"));

	// Summary stats
	const errs = (rs: ProviderResult[]) => rs.filter((r) => r.error).length;
	const lat = (rs: ProviderResult[]) =>
		rs.length === 0
			? 0
			: Math.round(rs.reduce((a, r) => a + r.latency_ms, 0) / rs.length);
	const tok = (rs: ProviderResult[]) =>
		rs.length === 0
			? 0
			: Math.round(rs.reduce((a, r) => a + r.tokens_out, 0) / rs.length);

	console.log(`\nDone. Output: ${outDir}/`);
	console.log("");
	console.log(
		`Gemini  errors: ${errs(geminiResults)}/${cases.length}  · avg latency: ${lat(geminiResults)}ms · avg tokens_out: ${tok(geminiResults)}`,
	);
	console.log(
		`Qwen    errors: ${errs(qwenResults)}/${cases.length}  · avg latency: ${lat(qwenResults)}ms · avg tokens_out: ${tok(qwenResults)}`,
	);
}

await main();
