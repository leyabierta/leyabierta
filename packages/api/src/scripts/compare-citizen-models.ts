/**
 * Qwen vs Gemini citizen-summary comparison — v10 prompt.
 *
 * Goals over v9:
 *  - Eliminate "tiny summaries OK" guidance (drove Qwen too lacónico).
 *  - Force inclusion of secondary factual details (cross-refs, sub-activities,
 *    enumerated conditions) since the judge penalises their omission.
 *  - Drop the explicit <think> instruction — the model occasionally leaked
 *    "Wait, the prompt says..." as trailing text and broke parsing.
 *  - Tighter target length (200-270 chars) that uses the available space.
 *
 * Robustness vs prior runs:
 *  - 180s timeout (was 90s).
 *  - Retry 3x on abort/timeout with 5-10s backoff.
 *  - Retry on 429 with 65s wait.
 *  - Robust JSON parser tolerates trailing prose.
 *
 * No internal judge — pairs are written to disk for an external Claude Sonnet
 * judge dispatched via async agents.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";

const DB_PATH = "data/leyabierta.db";
const HERMES_BASE_URL = "https://api.nan.builders/v1";
const HERMES_API_KEY = process.env.HERMES_API_KEY ?? "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
	console.error("OPENROUTER_API_KEY not set");
	process.exit(1);
}

const args = process.argv.slice(2);
const N = args.includes("--n")
	? Number(args[args.indexOf("--n") + 1] ?? 50)
	: 50;
const OUT = args.includes("--out")
	? args[args.indexOf("--out") + 1]
	: "tmp/v10-pairs.json";

mkdirSync("tmp", { recursive: true });

const SYSTEM_PROMPT_V10 = `Eres un redactor institucional que traduce artículos legales españoles a lenguaje accesible para ciudadanos.

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
Máximo duro: 300 caracteres. Si tu borrador rebasa 300, RECÓRTALO eligiendo los 2-3 datos más relevantes.

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

const SCHEMA = {
	name: "citizen_metadata",
	strict: true,
	schema: {
		type: "object",
		properties: {
			// No minLength/maxLength — the NaN endpoint hangs trying to
			// regenerate until satisfied. Length is enforced in the prompt
			// and post-validated.
			citizen_summary: { type: "string" },
			citizen_tags: {
				type: "array",
				items: { type: "string" },
			},
		},
		required: ["citizen_summary", "citizen_tags"],
		additionalProperties: false,
	},
};

interface Article {
	norm_id: string;
	block_id: string;
	norm_title: string;
	block_title: string;
	current_text: string;
}

interface Summary {
	citizen_summary: string;
	citizen_tags: string[];
}

const db = new Database(DB_PATH);

function stratifiedSample(total: number): Article[] {
	const buckets = ["a", "dt", "da", "df", "dd"];
	const perBucket = Math.ceil(total / buckets.length);
	const out: Article[] = [];
	for (const prefix of buckets) {
		const rows = db
			.prepare(
				`
			SELECT n.id AS norm_id, n.title AS norm_title,
			       b.block_id, b.title AS block_title, b.current_text
			FROM norms n
			JOIN blocks b ON b.norm_id = n.id
			WHERE n.status = 'vigente'
			  AND b.block_type = 'precepto'
			  AND length(b.current_text) BETWEEN 200 AND 2000
			  AND b.block_id LIKE ?
			ORDER BY RANDOM()
			LIMIT ?
		`,
			)
			.all(`${prefix}%`, perBucket) as Article[];
		out.push(...rows);
	}
	return out.slice(0, total);
}

const userPromptFor = (a: Article) =>
	`LEY: ${a.norm_title}\nTÍTULO: ${a.block_title}\nTEXTO:\n${a.current_text.slice(0, 2000)}\n\nGenera el resumen ciudadano de este artículo siguiendo todas las reglas.`;

function robustParse(text: string): Summary | null {
	try {
		const v = JSON.parse(text);
		if (v && typeof v.citizen_summary === "string") return v as Summary;
	} catch {}
	try {
		const stripped = text
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "");
		const v = JSON.parse(stripped);
		if (v && typeof v.citizen_summary === "string") return v as Summary;
	} catch {}
	const first = text.indexOf("{");
	if (first === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = first; i < text.length; i++) {
		const c = text[i];
		if (esc) {
			esc = false;
			continue;
		}
		if (c === "\\") {
			esc = true;
			continue;
		}
		if (c === '"') {
			inStr = !inStr;
			continue;
		}
		if (inStr) continue;
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				try {
					const v = JSON.parse(text.slice(first, i + 1));
					if (v && typeof v.citizen_summary === "string") return v as Summary;
				} catch {}
				break;
			}
		}
	}
	return null;
}

async function callOnce(
	url: string,
	authHeader: string,
	body: object,
	timeoutMs: number,
): Promise<{ text: string | null; status: number; netError: string | null }> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: "POST",
			signal: ctrl.signal,
			headers: {
				Authorization: authHeader,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const errBody = await res.text().catch(() => "");
			return {
				text: errBody.slice(0, 200),
				status: res.status,
				netError: null,
			};
		}
		const data = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		return {
			text: data.choices?.[0]?.message?.content ?? "",
			status: 200,
			netError: null,
		};
	} catch (e) {
		const name = (e as Error).name;
		const msg = (e as Error).message;
		return {
			text: null,
			status: 0,
			netError: name === "AbortError" ? "timeout" : `fetch:${msg}`,
		};
	} finally {
		clearTimeout(t);
	}
}

async function callWithRetry(
	url: string,
	authHeader: string,
	body: object,
): Promise<Summary | { error: string }> {
	const maxAttempts = 4;
	let last: { text: string | null; status: number; netError: string | null } = {
		text: null,
		status: 0,
		netError: "no_attempt",
	};
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const r = await callOnce(url, authHeader, body, 180_000);
		last = r;
		if (r.status === 200 && r.text !== null) {
			const parsed = robustParse(r.text);
			if (parsed) return parsed;
			// parse failure → retry with small backoff
			await new Promise((res) => setTimeout(res, 1500 + Math.random() * 1500));
			continue;
		}
		if (r.status === 429) {
			await new Promise((res) =>
				setTimeout(res, 65_000 + Math.random() * 5000),
			);
			continue;
		}
		if (r.netError === "timeout" || (r.status >= 500 && r.status < 600)) {
			// Aggressive backoff: 5, 10, 20, 40s with jitter
			const base = 5000 * 2 ** (attempt - 1);
			await new Promise((res) =>
				setTimeout(res, base + Math.random() * (base / 2)),
			);
			continue;
		}
		await new Promise((res) => setTimeout(res, 2000 + Math.random() * 1000));
	}
	const tag = last.netError ?? `http_${last.status}`;
	const detail = last.text ? last.text.slice(0, 100) : "";
	return { error: `${tag}: ${detail}` };
}

const callQwen = (a: Article) =>
	callWithRetry(
		`${HERMES_BASE_URL}/chat/completions`,
		`Bearer ${HERMES_API_KEY}`,
		{
			model: "qwen3.6",
			messages: [
				{ role: "system", content: SYSTEM_PROMPT_V10 },
				{ role: "user", content: userPromptFor(a) },
			],
			temperature: 0.2,
			max_tokens: 8000,
			response_format: { type: "json_schema", json_schema: SCHEMA },
		},
	);

const callGemini = (a: Article) =>
	callWithRetry(
		"https://openrouter.ai/api/v1/chat/completions",
		`Bearer ${OPENROUTER_API_KEY}`,
		{
			model: "google/gemini-2.5-flash-lite",
			messages: [
				{ role: "system", content: SYSTEM_PROMPT_V10 },
				{ role: "user", content: userPromptFor(a) },
			],
			temperature: 0.2,
			max_tokens: 8000,
			response_format: { type: "json_schema", json_schema: SCHEMA },
		},
	);

// ── Main ──────────────────────────────────────────────────────────────

const articles = stratifiedSample(N);
console.log(`Sampled ${articles.length} articles. Generating with prompt v10…`);

interface Pair {
	article: Article;
	qwen: Summary | { error: string };
	gemini: Summary | { error: string };
}
const rows: Pair[] = [];
let cursor = 0;
let done = 0;
const startedAt = Date.now();

const CONC = 5; // gentler on the NaN endpoint
async function worker() {
	while (true) {
		const idx = cursor++;
		if (idx >= articles.length) return;
		const a = articles[idx];
		const [q, g] = await Promise.all([callQwen(a), callGemini(a)]);
		rows[idx] = { article: a, qwen: q, gemini: g };
		done++;
		const elapsed = (Date.now() - startedAt) / 1000;
		process.stdout.write(
			`\r  ${done}/${articles.length} (${(done / elapsed).toFixed(2)}/s)   `,
		);
	}
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log();

const summary = {
	total: rows.length,
	qwen_errors: rows.filter((r) => "error" in r.qwen).length,
	gemini_errors: rows.filter((r) => "error" in r.gemini).length,
	qwen_avg_len: 0,
	gemini_avg_len: 0,
	qwen_over_280: 0,
	gemini_over_280: 0,
};
let qN = 0;
let gN = 0;
for (const r of rows) {
	if (!("error" in r.qwen)) {
		summary.qwen_avg_len += r.qwen.citizen_summary.length;
		if (r.qwen.citizen_summary.length > 280) summary.qwen_over_280++;
		qN++;
	}
	if (!("error" in r.gemini)) {
		summary.gemini_avg_len += r.gemini.citizen_summary.length;
		if (r.gemini.citizen_summary.length > 280) summary.gemini_over_280++;
		gN++;
	}
}
summary.qwen_avg_len = qN ? Math.round(summary.qwen_avg_len / qN) : 0;
summary.gemini_avg_len = gN ? Math.round(summary.gemini_avg_len / gN) : 0;

writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
console.log("Summary:", JSON.stringify(summary, null, 2));
console.log("Wrote pairs to", OUT);
