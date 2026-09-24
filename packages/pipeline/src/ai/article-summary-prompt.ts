/**
 * Prompt (v10), output schema and response parser for per-article citizen
 * summaries. Every path that writes one uses them: the daily cron
 * (generate-citizen-tags.ts), the lazy API route (citizen-summary.ts), the
 * RAG background fill, and the offline/backfill scripts in packages/api.
 *
 * Lives in the pipeline package because the cron does and cannot import from
 * packages/api; packages/api/src/scripts/citizen-summary-backfill-prompt.ts
 * re-exports it for the scripts, tests and model evaluations that use it.
 */

/**
 * Version of the prompt below, stored in
 * citizen_article_summaries.prompt_version. Bump it whenever SYSTEM_PROMPT,
 * the schema or buildBatchPrompt change.
 */
export const ARTICLE_SUMMARY_PROMPT_VERSION = "v10";

export interface BackfillArticle {
	norm_id: string;
	block_id: string;
	norm_title: string;
	block_title: string;
	current_text: string;
}

// ── Qwen 3.6 Prompt v10 (anti-invention + force detail) ──────────────────────

export const SYSTEM_PROMPT = `Eres un redactor institucional que traduce artículos legales españoles a lenguaje accesible para ciudadanos.

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

export interface BatchSummary {
	article_id: string;
	citizen_summary: string;
	citizen_tags: string[];
}

// Structured outputs require an object at the top level (OpenAI-style
// providers reject a bare array), so the batch is wrapped in { articles }.
// No minLength/maxLength/minItems: length and tag count are validated
// downstream and reinforced via the prompt (ADR 2026-05-06).
export const BATCH_SCHEMA = {
	name: "citizen_metadata_batch",
	strict: true,
	schema: {
		type: "object",
		properties: {
			articles: {
				type: "array",
				items: {
					type: "object",
					properties: {
						article_id: { type: "string" },
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
		},
		required: ["articles"],
		additionalProperties: false,
	},
};

export function buildBatchPrompt(articles: BackfillArticle[]): string {
	// No artificial truncation: Qwen 3.6 has 256K-token context, the longest
	// vigente article in the corpus is ~327K chars (~110K tokens). Long articles
	// are dispatched solo (see SOLO_THRESHOLD_CHARS) so a single huge article
	// never has to share the call with others.
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

/**
 * Parses the model's reply for a batch of `articleCount` articles. Tolerates
 * code fences and text around the JSON; maps items back by `ARTÍCULO_n` id
 * (`null` = the model dropped that article).
 */
export function parseBatchContent(
	text: string,
	articleCount: number,
): { outputs: (BatchSummary | null)[] } | { error: string } {
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
			// Unwrap the { articles: [...] } envelope from BATCH_SCHEMA
			if (
				parsed &&
				!Array.isArray(parsed) &&
				typeof parsed === "object" &&
				Array.isArray((parsed as { articles?: unknown }).articles)
			) {
				parsed = (parsed as unknown as { articles: BatchSummary[] }).articles;
			}
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
		return { error: `json_parse: ${parseError}: ${text.slice(0, 300)}` };
	}

	// Map by article_id (the model returns "ARTÍCULO_1", "ARTÍCULO_2", ...).
	// Position-based mapping silently dropped trailing articles when the
	// model returned fewer items than were sent — that's how 18% of the
	// corpus ended up as fake "empty" rows.
	// Single-article calls have no position-drift risk: if exactly one
	// item came back, use it regardless of article_id (the model often
	// returns the article number from the TÍTULO line, e.g. "118",
	// instead of the requested "ARTÍCULO_1" prefix).
	const list = parsed;
	const outputs: (BatchSummary | null)[] = (() => {
		if (articleCount === 1 && list.length === 1 && list[0]) {
			return [
				{
					article_id: list[0].article_id,
					citizen_summary: list[0].citizen_summary,
					citizen_tags: list[0].citizen_tags,
				},
			];
		}
		const byId = new Map<string, BatchSummary>();
		for (const p of list) {
			if (p.article_id) byId.set(p.article_id, p);
		}
		return Array.from({ length: articleCount }, (_a, i) => {
			const key = `ARTÍCULO_${i + 1}`;
			const hit = byId.get(key);
			if (!hit) return null;
			return {
				article_id: hit.article_id,
				citizen_summary: hit.citizen_summary,
				citizen_tags: hit.citizen_tags,
			};
		});
	})();

	return { outputs };
}
