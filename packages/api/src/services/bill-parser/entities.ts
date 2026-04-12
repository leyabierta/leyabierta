/**
 * Bill Parser — new entity extraction from the articulado principal.
 *
 * Detects registries, agencies, procedures, rights, systems, and other
 * legal constructs created by a bill's main body (not modifications to
 * existing laws, which live in DFs/DAs).
 *
 * Regex-first approach, same philosophy as the rest of the parser.
 */

import type { NewEntity } from "./types.ts";

// ── Entity type classification ──

type EntityType = NewEntity["entityType"];

/** Keyword patterns for entity type classification, checked in priority order. */
const TYPE_KEYWORDS: Array<[EntityType, RegExp]> = [
	["registro", /\b(?:registro|fichero|base de datos|catálogo)\b/i],
	["organo", /\b(?:órgano|comisión|comité|consejo|agencia|oficina|punto)\b/i],
	["procedimiento", /\b(?:procedimiento|proceso|trámite|expediente)\b/i],
	["derecho", /\b(?:derecho|garantía)\b/i],
	["sistema", /\b(?:sistema|plataforma|aplicación|servicio|carpeta|sede)\b/i],
];

function classifyEntityType(name: string, description: string): EntityType {
	// Classify primarily on the name; fall back to description
	for (const [type, pattern] of TYPE_KEYWORDS) {
		if (pattern.test(name)) return type;
	}
	for (const [type, pattern] of TYPE_KEYWORDS) {
		if (pattern.test(description)) return type;
	}
	return "otro";
}

// ── Helpers ──

/** Check if text is inside «» quoted blocks (modifications to other laws). */
function isInsideQuotedBlock(text: string, matchIndex: number): boolean {
	const before = text.slice(0, matchIndex);
	const openCount = (before.match(/«/g) || []).length;
	const closeCount = (before.match(/»/g) || []).length;
	return openCount > closeCount;
}

/** Extract the first 1-2 sentences after a match as description. */
function extractDescription(text: string, startIndex: number): string {
	const chunk = text.slice(startIndex, startIndex + 500);
	// Take up to first sentence (ending with period + space/newline)
	const sentence = chunk.match(/^.+?\.(?:\s|$)/s);
	if (sentence) {
		return sentence[0].trim().replace(/\s+/g, " ");
	}
	return chunk.slice(0, 200).trim().replace(/\s+/g, " ");
}

/** Clean entity name: trim, collapse whitespace, remove trailing period. */
function cleanName(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().replace(/\.$/, "").trim();
}

/** Find which article contains a given text position. */
function findArticle(text: string, position: number): string {
	// Only match article headings at the start of a line (not inline references)
	const before = text.slice(0, position);
	const artMatches = [...before.matchAll(/^Artículo\s+(\d+(?:\s*(?:bis|ter))?)\./gim)];
	if (artMatches.length > 0) {
		const last = artMatches[artMatches.length - 1]!;
		return `Artículo ${last[1]}`;
	}
	return "";
}

// ── Name-based entity keywords ──

/**
 * An article title is considered a "named entity" if it contains one of these
 * keywords, indicating it's creating/defining a specific legal construct
 * (not just describing a generic topic like "Efectos" or "Requisitos").
 */
const ENTITY_NAME_KEYWORDS =
	/\b(?:Registro|Carpeta|Punto|Sede|Portal|Sistema|Comité|Consejo|Centro|Esquema|Expediente|Plataforma|Servicio|Licencia|Licencias|Agencia|Oficina|Observatorio|Autoridad|Comisión|Fondo)\b/;

/**
 * Article titles that start with these words are generic descriptions,
 * not entity names: "Uso obligatorio de...", "Efectos de...", etc.
 */
const GENERIC_TITLE_STARTS =
	/^(?:Objeto|Ámbito|Terminología|Definiciones|Principios|Régimen|Disposiciones|Uso|Efectos|Forma|Requisitos|Regla|Reglas|Contenido|Acceso|Admisión|Identificación|Protección|Sobre|Del|De\s+la|De\s+los|Auto|Cómputo|Mejora|Cooperación|Relaciones|Política|Reutilización|Transferencia|Interoperabilidad|Control|Actuaciones|Comunicaciones|Documentos|Presentación|Aportación|Intercambio|Inicio|Tramitación|Cita|Atención|Teletrabajo|Puesto|Entornos|Medios|Actos|Datos|Composición|Funcionamiento|Asistencia|Recursos\s+contra|Competencias|Naturaleza|Estructura|Funciones|Medidas|Inscripción|Reconocimiento|Prestación|Secretaría|Infracciones|Sanciones|Responsabilidad|Graduación|Prescripción|Expedientes|Concesión|Revocación|Comprobación|Notificación|Facultades|Acciones)\b/i;

/** Max allowed entity name length. Longer names are likely sentence fragments. */
const MAX_ENTITY_NAME_LENGTH = 100;

/**
 * Names that are modification instructions or legal-structure references,
 * not real entities.
 */
const MODIFICATION_INSTRUCTION_PATTERN =
	/^(?:nuevo\s+art[ií]culo|art[ií]culo\s+\d|apartado|disposici[oó]n|p[aá]rrafo|letra)\b/i;

/**
 * Strategy B filter: reject names that start with a definite article
 * followed by a lowercase word (not a proper noun).
 * Real entity names have proper-noun-style capitalization:
 *   "Carpeta Justicia" OK, "Los tribunales remitirán" rejected.
 */
function startsWithGenericArticle(name: string): boolean {
	return /^(?:El|La|Los|Las)\s+[a-záéíóúñü]/.test(name);
}

/**
 * Reject names that are clearly sentence fragments rather than entity names.
 * Checks for: list markers (a), b), m)), verb forms mid-name, etc.
 */
function isSentenceFragment(name: string): boolean {
	// Starts with a list marker like "a)", "m)", "1.", "ii)"
	if (/^[a-záéíóú0-9]{1,4}[).]\s/i.test(name)) return true;
	// Contains conjugated verb forms mid-name (sentence indicator)
	if (/\b(?:es\s+un|será|serán|tendrá|podrá|deberá|queda|tienen|remitirán)\b/i.test(name))
		return true;
	// Ends with "que", "de", "al", "del", "a la" (truncated mid-sentence)
	if (/\s+(?:que|de|al|del|a\s+la|a\s+los|en\s+el|en\s+la)\s*$/i.test(name))
		return true;
	return false;
}

// ── Main extractor ──

/**
 * Extract new entities created by the bill's articulado principal.
 * Only scans text BEFORE disposiciones (adicional/transitoria/derogatoria/final).
 */
export function extractNewEntities(text: string): NewEntity[] {
	// 1. Isolate the articulado principal (before disposiciones)
	// Case-SENSITIVE: structural headings always use uppercase "Disposición".
	// Using /i would match lowercase "disposición" in body text (e.g., "sin perjuicio
	// de lo establecido en la disposición transitoria primera"), which truncates the
	// articulado before the real articles even start (see BOCG-14-A-94-1).
	const dispMatch = text.search(
		/\nDisposición\s+(?:adicional|transitoria|derogatoria|final)\s/,
	);
	const articulado = dispMatch > 0 ? text.slice(0, dispMatch) : text;

	// If articulado is very short, this bill probably has no main body
	// (pure modification bills have their body entirely in DFs/DAs)
	if (articulado.length < 500) return [];

	// Also check: if the first article is very close to the disposiciones,
	// the bill has no real articulado principal (it's all modifications).
	const firstArticleMatch = articulado.search(/\nArtículo\s+1\./i);
	if (firstArticleMatch > 0 && dispMatch > 0) {
		const articuladoBody = text.slice(firstArticleMatch, dispMatch).trim();
		if (articuladoBody.length < 500) return [];
	}

	// Check for "Artículo único" pattern — these are almost always pure modification bills
	if (/\bArtículo\s+único\b/i.test(articulado)) return [];

	// Check if the articulado is predominantly «»-quoted text (modification instructions).
	// If >60% of the articulado body (after first article) is inside quotes, skip.
	if (firstArticleMatch > 0) {
		const body = articulado.slice(firstArticleMatch);
		const quotedChars = [...body.matchAll(/«[^»]*»/gs)].reduce(
			(sum, m) => sum + m[0].length,
			0,
		);
		if (quotedChars > body.length * 0.6) return [];
	}

	const entities: NewEntity[] = [];
	const seenNames = new Set<string>();

	// 2. Strategy A: Article titles with entity-naming keywords
	//    e.g., "Artículo 13. La Carpeta en el ámbito de la Administración de Justicia."
	//    e.g., "Artículo 51. Punto Común de Actos de Comunicación."
	const articleTitleRegex = /Artículo\s+(\d+(?:\s*(?:bis|ter))?)\.\s+([^\n]+)/gi;
	for (const match of articulado.matchAll(articleTitleRegex)) {
		const articleNum = match[1]!;
		const titleText = cleanName(match[2]!);

		// Skip generic article titles
		if (GENERIC_TITLE_STARTS.test(titleText)) continue;

		// Must contain a recognized entity keyword
		if (!ENTITY_NAME_KEYWORDS.test(titleText)) continue;

		// Must have at least 2 words
		if (titleText.split(/\s+/).length < 2) continue;

		// Reject modification instructions
		if (MODIFICATION_INSTRUCTION_PATTERN.test(titleText)) continue;

		// Reject names that are too long
		if (titleText.length > MAX_ENTITY_NAME_LENGTH) continue;

		// Reject names starting with "El/La/Los/Las + lowercase" (sentence fragments)
		if (startsWithGenericArticle(titleText)) continue;

		// Reject sentence fragments
		if (isSentenceFragment(titleText)) continue;

		// Get description from article body
		const afterTitle = articulado.slice(match.index! + match[0].length);
		const description = extractDescription(afterTitle, 0);

		const key = titleText.toLowerCase();
		if (seenNames.has(key)) continue;
		seenNames.add(key);

		entities.push({
			name: titleText,
			entityType: classifyEntityType(titleText, description),
			article: `Artículo ${articleNum}`,
			description,
		});
	}

	// 3. Strategy B: Explicit creation patterns — "Se crea/establece el/la [ENTITY]"
	//    Only captures "Se crea" (strongest creation signal, not "Se regula" or "Se establece"
	//    which are too noisy in the exposición de motivos area).
	const creationPatterns = [
		// "Se crea el/la [Entity Name]" — explicit creation
		/Se\s+crea(?:rá)?\s+(?:el|la|un|una)\s+([A-ZÁÉÍÓÚ][\w\sáéíóúñüÁÉÍÓÚÑÜ,()]+?)(?:\.\s|\s+(?:que|para|con|bajo|en\s+el|dentro|gestionad))/gi,
		// "[Entity] tendrá por objeto..." — purpose definition (strong signal)
		/(?:^|\.\s+)(?:El|La)\s+([A-ZÁÉÍÓÚ][\w\sáéíóúñüÁÉÍÓÚÑÜ()]+?)\s+tendrá\s+por\s+objeto\b/gim,
	];

	for (const pattern of creationPatterns) {
		for (const match of articulado.matchAll(pattern)) {
			const matchIdx = match.index!;

			// Skip if inside «» quoted block (modification to another law)
			if (isInsideQuotedBlock(articulado, matchIdx)) continue;

			// Skip if in the exposición de motivos (before Artículo 1)
			const firstArticle = articulado.search(/\nArtículo\s+1\./i);
			if (firstArticle > 0 && matchIdx < firstArticle) continue;

			let rawName = cleanName(match[1]!);

			// Truncate overly long names at natural breaks
			if (rawName.length > MAX_ENTITY_NAME_LENGTH) {
				const truncated = rawName.slice(0, MAX_ENTITY_NAME_LENGTH);
				const breakPoint = Math.max(
					truncated.lastIndexOf(","),
					truncated.lastIndexOf("."),
					truncated.lastIndexOf(" de "),
				);
				rawName = breakPoint > 20 ? truncated.slice(0, breakPoint).trim() : "";
			}
			if (!rawName) continue;

			// Filter: name must have at least 3 words to avoid generic references
			if (rawName.split(/\s+/).length < 3) continue;

			// Filter: skip generic patterns
			if (/^(?:un|una|el|la|los|las|este|esta)\s/i.test(rawName)) continue;

			// Filter: reject modification instructions
			if (MODIFICATION_INSTRUCTION_PATTERN.test(rawName)) continue;

			// Filter: reject names starting with "El/La/Los/Las + lowercase"
			// (sentence fragments, not proper entity names)
			if (startsWithGenericArticle(rawName)) continue;

			// Filter: reject sentence fragments
			if (isSentenceFragment(rawName)) continue;

			const key = rawName.toLowerCase();
			if (seenNames.has(key)) continue;
			seenNames.add(key);

			const article = findArticle(articulado, matchIdx);
			const description = extractDescription(articulado, matchIdx + match[0].length);

			entities.push({
				name: rawName,
				entityType: classifyEntityType(rawName, description),
				article,
				description,
			});
		}
	}

	// 4. Strategy C: Definition patterns — "Se entenderá por [Entity]: ..."
	//    Only in the articulado body, not in exposición de motivos.
	const definitionRegex =
		/Se\s+entenderá\s+por\s+([A-ZÁÉÍÓÚ][\w\sáéíóúñüÁÉÍÓÚÑÜ()]+?)(?:\s*:|\s+(?:el|la|aquel))/gi;

	for (const match of articulado.matchAll(definitionRegex)) {
		const matchIdx = match.index!;
		if (isInsideQuotedBlock(articulado, matchIdx)) continue;

		// Skip exposición de motivos
		const firstArticle = articulado.search(/\nArtículo\s+1\./i);
		if (firstArticle > 0 && matchIdx < firstArticle) continue;

		let rawName = cleanName(match[1]!);
		if (rawName.length > MAX_ENTITY_NAME_LENGTH) {
			const truncated = rawName.slice(0, MAX_ENTITY_NAME_LENGTH);
			const breakPoint = Math.max(
				truncated.lastIndexOf(","),
				truncated.lastIndexOf("."),
				truncated.lastIndexOf(" de "),
			);
			rawName = breakPoint > 20 ? truncated.slice(0, breakPoint).trim() : "";
		}
		if (!rawName) continue;
		if (rawName.split(/\s+/).length < 3) continue;
		if (MODIFICATION_INSTRUCTION_PATTERN.test(rawName)) continue;
		if (startsWithGenericArticle(rawName)) continue;
		if (isSentenceFragment(rawName)) continue;

		const key = rawName.toLowerCase();
		if (seenNames.has(key)) continue;
		seenNames.add(key);

		const article = findArticle(articulado, matchIdx);
		const description = extractDescription(articulado, matchIdx + match[0].length);

		entities.push({
			name: rawName,
			entityType: classifyEntityType(rawName, description),
			article,
			description,
		});
	}

	return entities;
}
