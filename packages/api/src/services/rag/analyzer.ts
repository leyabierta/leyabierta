/**
 * Query analyzer + text-normalisation helpers.
 *
 * Owns:
 *  - `analyzeQuery` — extracts keywords/synonyms/materias/temporal/jurisdiction
 *    via the cheap LLM (with a deterministic fallback when the LLM call fails).
 *  - `resolveNormsByName` — turns the analyzer's `normNameHint` into concrete
 *    norm IDs by AND-matching the hint words against `norms.title`.
 *  - small helpers used by retrieval/synthesis: rank labels, scope description,
 *    Spanish-number-to-digit normalisation, sectoral / fundamental / modifier
 *    classifiers, periodic-norm family detection.
 *
 * Pure module: no DB or network state lives here. Functions take `db`, `apiKey`,
 * etc. as parameters so they stay testable.
 */

import type { Database } from "bun:sqlite";
import { callOpenRouter } from "../openrouter.ts";
import { JURISDICTION_NAMES } from "./jurisdiction.ts";

/** Analyzer model — cheap and fast, only extracts keywords/materias/flags */
export const ANALYZER_MODEL = "google/gemini-2.5-flash-lite";

export interface AnalyzedQuery {
	keywords: string[];
	/** Legal synonyms — how colloquial terms appear in law text.
	 *  E.g. "paternidad" → ["nacimiento", "cuidado del menor"]. */
	legalSynonyms: string[];
	materias: string[];
	temporal: boolean;
	/** True if the question is clearly not about legislation (poems, sports, etc.) */
	nonLegal: boolean;
	/** ISO 3166-2:ES jurisdiction code if the question targets a specific autonomous
	 *  community (e.g. "es-ct" for Cataluña). Null for general/national questions. */
	jurisdiction: string | null;
	/** Short phrase identifying a specific named law if the user mentions one.
	 *  E.g. "vivienda Illes Balears", "Código Civil catalán", "cooperativas Euskadi".
	 *  Null when the question is general (not about a specific named law). */
	normNameHint: string | null;
}

// ── Rank labels & scope description ──

export const RANK_LABELS: Record<string, string> = {
	constitucion: "Constitución",
	ley_organica: "Ley orgánica",
	ley: "Ley",
	real_decreto_ley: "Real decreto-ley",
	real_decreto_legislativo: "Texto refundido de ley",
	real_decreto: "Real decreto",
	decreto: "Decreto",
	orden: "Orden ministerial",
	circular: "Circular",
	instruccion: "Instrucción",
	resolucion: "Resolución",
	reglamento: "Reglamento",
	acuerdo_internacional: "Acuerdo internacional",
	acuerdo: "Acuerdo",
	otro: "Norma",
};

/**
 * Build a human-readable scope description combining norm rank and jurisdiction.
 * Used to enrich the reranker input so it can distinguish general state laws
 * from sectoral/autonomous norms with semantically identical text.
 *
 * Examples:
 *   describeNormScope("ley", "es")      → "Ley estatal"
 *   describeNormScope("ley", "es-ct")   → "Ley de Cataluña"
 *   describeNormScope("instruccion", "es") → "Instrucción estatal"
 */
export function describeNormScope(rank: string, jurisdiction: string): string {
	const label = RANK_LABELS[rank] ?? rank;
	if (jurisdiction === "es") return `${label} estatal`;
	const name = JURISDICTION_NAMES[jurisdiction] ?? jurisdiction;
	return `${label} de ${name}`;
}

// ── Spanish number → digit normalisation ──

/** Convert Spanish written numbers to digits in legal text.
 *  "diecinueve semanas" → "19 semanas". This prevents the synthesis LLM
 *  from "correcting" numbers based on its training data, which may be
 *  outdated relative to recent legislative reforms. */
const SPANISH_NUMBERS: Record<string, string> = {
	uno: "1",
	una: "1",
	dos: "2",
	tres: "3",
	cuatro: "4",
	cinco: "5",
	seis: "6",
	siete: "7",
	ocho: "8",
	nueve: "9",
	diez: "10",
	once: "11",
	doce: "12",
	trece: "13",
	catorce: "14",
	quince: "15",
	dieciséis: "16",
	diecisiete: "17",
	dieciocho: "18",
	diecinueve: "19",
	veinte: "20",
	veintiuno: "21",
	veintiuna: "21",
	veintidós: "22",
	veintitrés: "23",
	veinticuatro: "24",
	veinticinco: "25",
	veintiséis: "26",
	veintisiete: "27",
	veintiocho: "28",
	veintinueve: "29",
	treinta: "30",
	"treinta y uno": "31",
	"treinta y una": "31",
	"treinta y dos": "32",
	"treinta y tres": "33",
	cuarenta: "40",
	cincuenta: "50",
	sesenta: "60",
};

const UNIT_WORDS =
	"semanas?|meses?|días?|años?|horas?|euros?|mensualidades?|jornadas?";
const SINGLE_NUMBER_PATTERNS: Array<[RegExp, string]> = Object.entries(
	SPANISH_NUMBERS,
)
	.filter(([w]) => !w.includes(" "))
	.sort((a, b) => b[0].length - a[0].length)
	.map(([word, digit]) => [
		new RegExp(`\\b${word}\\s+(${UNIT_WORDS})`, "gi"),
		`${digit} $1`,
	]);

export function numbersToDigits(text: string): string {
	let result = text;
	for (const [word, digit] of Object.entries(SPANISH_NUMBERS)) {
		if (word.includes(" ")) {
			result = result.replaceAll(word, digit);
		}
	}
	for (const [pattern, replacement] of SINGLE_NUMBER_PATTERNS) {
		pattern.lastIndex = 0;
		result = result.replace(pattern, replacement);
	}
	return result;
}

// ── Norm-rank classifiers ──

export function isSectoralNorm(rank: string): boolean {
	return (
		rank === "real_decreto" ||
		rank === "decreto" ||
		rank === "orden" ||
		rank === "circular" ||
		rank === "instruccion" ||
		rank === "resolucion" ||
		rank === "reglamento"
	);
}

export function isFundamentalRank(rank: string): boolean {
	return (
		rank === "ley" ||
		rank === "ley_organica" ||
		rank === "real_decreto_legislativo" ||
		rank === "codigo" ||
		rank === "constitucion"
	);
}

export function isModifierNorm(title: string): boolean {
	const t = title.toLowerCase();
	return (
		t.includes("presupuestos generales") ||
		t.includes("medidas urgentes") ||
		t.includes("medidas fiscales") ||
		t.includes("medidas tributarias") ||
		t.includes("acompañamiento")
	);
}

/**
 * Normalize a norm title for periodic family detection.
 * Strips decree type+number, year suffixes, and normalizes whitespace.
 * Returns null if the title doesn't look like a periodic norm.
 *
 * Examples:
 *   "Real Decreto 126/2026, de 18 de febrero, por el que se fija el
 *    salario mínimo interprofesional para 2026"
 *   → "fija el salario mínimo interprofesional"
 *
 *   "Real Decreto 87/2025, de 11 de febrero, por el que se fija el
 *    salario mínimo interprofesional para 2025"
 *   → "fija el salario mínimo interprofesional"  (same family!)
 */
export function normalizePeriodicTitle(title: string): string | null {
	let t = title.toLowerCase();
	t = t.replace(
		/^(?:real\s+decreto(?:-ley)?|decreto(?:-ley)?|orden|resolución)\s+\S+,\s*de\s+\d+\s+de\s+\w+,?\s*/i,
		"",
	);
	t = t.replace(/^por (?:el|la) que se\s+/i, "");
	t = t.replace(/\s+(?:para|del año|en)\s+\d{4}\.?$/i, "");
	t = t.replace(/\s+/g, " ").trim();
	if (t.length < 15) return null;
	return t;
}

// ── Query analysis ──

export async function analyzeQuery(
	apiKey: string,
	question: string,
): Promise<{
	query: AnalyzedQuery;
	cost: number;
	tokensIn: number;
	tokensOut: number;
}> {
	try {
		const result = await callOpenRouter<{
			keywords: string[];
			legal_synonyms?: string[];
			materias: string[];
			temporal: boolean;
			non_legal: boolean;
			jurisdiction: string | null;
			norm_name_hint: string | null;
		}>(apiKey, {
			model: ANALYZER_MODEL,
			messages: [
				{
					role: "system",
					content: `Eres un experto en legislación española. Dado una pregunta de un ciudadano, extrae:
1. "keywords": palabras clave COLOQUIALES del ciudadano para buscar. Máximo 5.
1b. "legal_synonyms": sinónimos LEGALES de los términos coloquiales, es decir, cómo aparecerían en el texto de la ley. Ejemplos: "paternidad" → ["nacimiento", "progenitor distinto de la madre biológica", "cuidado del menor"]; "alquiler" → ["arrendamiento", "arrendatario"]; "paro" → ["desempleo", "prestación contributiva"]; "echar del trabajo" → ["despido", "extinción del contrato"]; "baja" → ["incapacidad temporal", "suspensión del contrato"]; "vacaciones" → ["descanso anual", "periodo vacacional"]; "fianza" → ["garantía arrendaticia", "depósito"]; "media jornada" → ["tiempo parcial", "reducción de jornada"]. Máximo 8.
2. "materias": categorías temáticas BOE. Máximo 3.
3. "temporal": true si pregunta sobre cambios históricos o evolución de la ley. false si pregunta sobre ley vigente.
4. "non_legal": true si la pregunta NO es sobre legislación, derechos u obligaciones legales. Ejemplos: clima, deportes, poemas, recetas, opiniones personales, hackear sistemas, preguntas sobre personas concretas. INCLUSO si la pregunta menciona palabras legales (como "Constitución"), si la INTENCIÓN no es obtener información legal (ej: "escribe un poema sobre la Constitución"), pon non_legal=true.
5. "jurisdiction": código ISO 3166-2 de la comunidad autónoma si la pregunta se refiere ESPECÍFICAMENTE a legislación autonómica. Ejemplos: "en Cataluña" → "es-ct", "ley foral de Navarra" → "es-nc", "Illes Balears" → "es-ib", "País Vasco" / "Euskadi" → "es-pv", "Galicia" → "es-ga", "Andalucía" → "es-an", "Madrid" → "es-md", "Aragón" → "es-ar", "Canarias" → "es-cn", "Castilla y León" → "es-cl", "Castilla-La Mancha" → "es-cm", "Comunitat Valenciana" / "Valencia" → "es-vc", "Extremadura" → "es-ex", "Murcia" → "es-mc", "Cantabria" → "es-cb", "Asturias" → "es-as", "La Rioja" → "es-ri". Si la pregunta es general o no menciona una comunidad concreta, pon null.
6. "norm_name_hint": si el usuario NOMBRA o DESCRIBE una ley específica, extrae palabras clave para identificarla. Ejemplos: "ley de vivienda de las Illes Balears" → "vivienda Illes Balears", "Código Civil catalán" → "Código Civil Cataluña", "ley de cooperativas del País Vasco" → "cooperativas Euskadi", "Estatuto de los Trabajadores" → "Estatuto Trabajadores", "ley foral sobre vivienda" → "vivienda foral". Si la pregunta NO nombra ninguna ley específica (ej: "¿cuántos días de vacaciones tengo?"), pon null.
Responde SOLO con JSON.`,
				},
				{ role: "user", content: question },
			],
			temperature: 0.1,
			maxTokens: 250,
		});
		return {
			query: {
				keywords: result.data.keywords ?? [],
				legalSynonyms: result.data.legal_synonyms ?? [],
				materias: result.data.materias ?? [],
				temporal: result.data.temporal ?? false,
				nonLegal: result.data.non_legal ?? false,
				jurisdiction: result.data.jurisdiction?.toLowerCase() ?? null,
				normNameHint: result.data.norm_name_hint ?? null,
			},
			cost: result.cost,
			tokensIn: result.tokensIn,
			tokensOut: result.tokensOut,
		};
	} catch (err) {
		console.warn(
			"analyzeQuery LLM failed, using fallback:",
			err instanceof Error ? err.message : "unknown",
		);
		const lowerQ = question.toLowerCase();
		const temporalKeywords = [
			"cambio",
			"cambiado",
			"antes",
			"reforma",
			"historial",
			"modificación",
			"evolución",
			"anterior",
			"vigente",
		];
		const isTemporal = temporalKeywords.some((kw) => lowerQ.includes(kw));
		const STOP_WORDS = new Set([
			"de",
			"la",
			"el",
			"en",
			"que",
			"los",
			"las",
			"del",
			"por",
			"con",
			"una",
			"para",
			"son",
			"como",
			"más",
			"pero",
			"sus",
			"ese",
			"esta",
			"ser",
			"está",
			"tiene",
			"hay",
			"puede",
			"qué",
			"cuánto",
			"cuántos",
		]);
		return {
			query: {
				keywords: question
					.split(/\s+/)
					.map((t) => t.toLowerCase().replace(/[¿?¡!.,;:]/g, ""))
					.filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
				legalSynonyms: [],
				materias: [],
				temporal: isTemporal,
				nonLegal: false,
				jurisdiction: null,
				normNameHint: null,
			},
			cost: 0,
			tokensIn: 0,
			tokensOut: 0,
		};
	}
}

/**
 * Resolve specific norms by name hint from the query analyzer.
 * Searches norms.title using AND-style LIKE matching, scoped to embedded norms.
 * Returns norm IDs whose title contains ALL hint words (length > 2 each).
 */
export function resolveNormsByName(
	db: Database,
	hint: string,
	embeddingNormIds: string[],
): string[] {
	if (!hint || embeddingNormIds.length === 0) return [];

	const words = hint
		.split(/\s+/)
		.map((w) => w.toLowerCase().replace(/[¿?¡!.,;:]/g, ""))
		.filter((w) => w.length > 2);
	if (words.length === 0) return [];

	const likeClauses = words.map(() => "LOWER(title) LIKE ?").join(" AND ");
	const likeParams = words.map((w) => `%${w}%`);

	// Scope to embedded norms inline so the LIKE scan never has to materialize
	// the full norms table for short hint words. The post-query Set filter is
	// kept as a safety net in case the embeddings table is empty.
	const sql = `SELECT id FROM norms WHERE ${likeClauses} AND id IN (SELECT DISTINCT norm_id FROM embeddings) LIMIT 200`;
	const rows = db.query<{ id: string }, string[]>(sql).all(...likeParams);

	const embeddingSet = new Set(embeddingNormIds);
	return rows.map((r) => r.id).filter((id) => embeddingSet.has(id));
}
