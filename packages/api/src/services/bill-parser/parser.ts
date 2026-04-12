/**
 * Bill Parser — extracts modification structure from BOCG PDFs.
 *
 * Handles five strategies for group detection:
 * 1. Disposiciones finales with "Modificación de..." (LO 10/2022 pattern)
 * 2. "Artículo primero/segundo" with "Modificación de..." (LO 14/2022 pattern)
 * 3. "Artículo único" — with or without "Modificación" keyword (LO 1/2015, B-40-1)
 * 4. Disposiciones adicionales with modification keywords in body (Amnistía pattern)
 * 5. Catch-all: any section (DF, DA, Artículo) with mod keywords not caught above
 *
 * Priority: fiabilidad > coste > rendimiento.
 * The parser uses regex for ~99% of work (free, deterministic) and LLM structured
 * output as fallback for sections without ordinals (~$0.001/section).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOpenRouter } from "../openrouter.ts";

// ── Types ──

export interface BillModification {
	/** Ordinal in the bill (Uno, Dos, Primero, etc.) */
	ordinal: string;
	/** Type of change */
	changeType:
		| "modify"
		| "add"
		| "delete"
		| "derogate"
		| "renumber"
		| "suppress_chapter";
	/** Target provision (e.g., "artículo 178") */
	targetProvision: string;
	/** New text proposed (for modify/add) */
	newText: string;
	/** Raw source text from the bill */
	sourceText: string;
}

export interface ModificationGroup {
	/** Group title (e.g., "Disposición final cuarta. Modificación del CP") */
	title: string;
	/** Target law name */
	targetLaw: string;
	/** Resolved BOE norm ID (filled by analyzer) */
	normId?: string;
	/** Individual modifications */
	modifications: BillModification[];
}

export interface ParsedBill {
	/** BOCG identifier, e.g., "BOCG-14-A-62-1" */
	bocgId: string;
	/** Bill title from header */
	title: string;
	/** Publication date from header (ISO format) */
	publicationDate: string;
	/** All modification groups found */
	modificationGroups: ModificationGroup[];
	/** Raw text of each transitional provision */
	transitionalProvisions: string[];
	/** Full cleaned text */
	rawText: string;
}

// ── Ordinal lists ──

/** Lowercase ordinals used inside disposiciones finales (Uno, Dos...) */
const LOWERCASE_ORDINALS = [
	"Uno",
	"Dos",
	"Tres",
	"Cuatro",
	"Cinco",
	"Seis",
	"Siete",
	"Ocho",
	"Nueve",
	"Diez",
	"Once",
	"Doce",
	"Trece",
	"Catorce",
	"Quince",
	"Dieciséis",
	"Diecisiete",
	"Dieciocho",
	"Diecinueve",
	"Veinte",
	"Veintiuno",
	"Veintidós",
	"Veintitrés",
	"Veinticuatro",
	"Veinticinco",
	"Veintiséis",
	"Veintisiete",
	"Veintiocho",
	"Veintinueve",
	"Treinta",
	"Único",
	"Única",
];

/**
 * Title-case ordinals used in "Artículo único" bills (LO 1/2015 pattern).
 * These go up to ~240 in the largest Spanish reform bills.
 *
 * We don't enumerate all 240+ — instead we use a regex pattern that matches
 * the compositional structure: base + optional compound.
 */
const TITLECASE_ORDINAL_BASES = [
	"Primero",
	"Segundo",
	"Tercero",
	"Cuarto",
	"Quinto",
	"Sexto",
	"Séptimo",
	"Octavo",
	"Noveno",
	"Décimo",
	"Undécimo",
	"Duodécimo",
	"Decimotercero",
	"Decimocuarto",
	"Decimoquinto",
	"Decimosexto",
	"Decimoséptimo",
	"Decimoctavo",
	"Decimonoveno",
	"Vigésimo",
	"Trigésimo",
	"Cuadragésimo",
	"Quincuagésimo",
	"Sexagésimo",
	"Septuagésimo",
	"Octogésimo",
	"Nonagésimo",
	"Centésimo",
	"Ducentésimo",
];

/**
 * Build a regex that matches both lowercase ordinals (Uno. Dos. ...) and
 * title-case ordinals (Primero. Vigésimo segundo. Centésimo nonagésimo noveno.)
 *
 * Title-case ordinals can be compound: "Centésimo nonagésimo noveno"
 * so we match: BASE (optional SPACE + WORD)* followed by a period.
 */
function buildOrdinalPattern(): RegExp {
	const lowercasePart = LOWERCASE_ORDINALS.join("|");
	const titlecasePart = TITLECASE_ORDINAL_BASES.join("|");

	// Match either:
	// - A lowercase ordinal followed by "."
	// - A title-case base followed by 0-3 compound words and "."
	//   Compound words include both title-case and lowercase ordinals
	//   Examples: "Centésimo trigésimo primero", "Ducentésimo cuarto"
	const compoundWords = [
		...LOWERCASE_ORDINALS.map((o) => o.toLowerCase()),
		"primero", "segundo", "tercero", "cuarto", "quinto",
		"sexto", "séptimo", "octavo", "noveno",
		"décimo", "undécimo", "duodécimo",
		"trigésimo", "cuadragésimo", "quincuagésimo",
		"sexagésimo", "septuagésimo", "octogésimo", "nonagésimo",
		"centésimo", "ducentésimo",
	];
	const compoundPart = compoundWords.join("|");
	return new RegExp(
		`(?:^|\\n)((?:${lowercasePart})|(?:(?:${titlecasePart})(?:\\s+(?:${compoundPart}))*))\\.\\s+`,
		"gi",
	);
}

// ── PDF extraction ──

export function extractTextFromPdf(pdfPath: string): string {
	if (!existsSync(pdfPath)) {
		throw new Error(`PDF not found: ${pdfPath}`);
	}

	// Write to temp file instead of stdout to work around bun worker thread bug
	// where execSync stdout capture is broken in bun test workspace mode.
	const tmpFile = join(tmpdir(), `pdftotext-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
	try {
		execSync(`pdftotext -raw "${pdfPath}" "${tmpFile}"`, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		});
		var text = readFileSync(tmpFile, "utf-8");
	} finally {
		try { unlinkSync(tmpFile); } catch { /* ignore */ }
	}

	return text
		.replace(/cve: BOCG-\d+-[A-Z]-\d+-\d+/g, "")
		.replace(
			/BOLETÍN OFICIAL DE LAS CORTES GENERALES\nCONGRESO DE LOS DIPUTADOS\n/g,
			"",
		)
		.replace(
			/Serie [AB] Núm\. \d+-\d+\s+\d+ de \w+ de \d+\s+Pág\. \d+/g,
			"",
		)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ── Roman numeral conversion ──

const ROMAN_VALUES: Record<string, number> = {
	I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000,
};

function romanToArabic(roman: string): string | null {
	if (!roman || !/^[IVXLCDM]+$/i.test(roman)) return null;
	const upper = roman.toUpperCase();
	let result = 0;
	for (let i = 0; i < upper.length; i++) {
		const current = ROMAN_VALUES[upper[i]!]!;
		const next = i + 1 < upper.length ? ROMAN_VALUES[upper[i + 1]!]! : 0;
		result += current < next ? -current : current;
	}
	return String(result);
}

// ── Header extraction ──

const SPANISH_MONTHS: Record<string, string> = {
	enero: "01",
	febrero: "02",
	marzo: "03",
	abril: "04",
	mayo: "05",
	junio: "06",
	julio: "07",
	agosto: "08",
	septiembre: "09",
	octubre: "10",
	noviembre: "11",
	diciembre: "12",
};

function extractBocgId(text: string): string {
	// Look for BOCG ID in CVE references or header
	const cveMatch = text.match(/BOCG-(\d+-[A-Z]-\d+-\d+)/);
	if (cveMatch) return `BOCG-${cveMatch[1]}`;

	// Fallback: extract from "Serie A/B Núm. XX-Y"
	const serieMatch = text.match(
		/(\w+) LEGISLATURA\nSerie ([AB]):\n[\s\S]*?Núm\. (\d+-\d+)/,
	);
	if (serieMatch) {
		const legislatura = romanToArabic(serieMatch[1] ?? "") ?? serieMatch[1];
		return `BOCG-${legislatura}-${serieMatch[2]}-${serieMatch[3]}`;
	}

	return "unknown";
}

function extractPublicationDate(text: string): string {
	// Match "DD de MONTH de YYYY" in the header area (first ~500 chars)
	const header = text.slice(0, 500);
	const dateMatch = header.match(/(\d{1,2}) de (\w+) de (\d{4})/);
	if (dateMatch) {
		const day = dateMatch[1]!.padStart(2, "0");
		const month = SPANISH_MONTHS[dateMatch[2]!.toLowerCase()];
		const year = dateMatch[3]!
		if (month) return `${year}-${month}-${day}`;
	}
	return "unknown";
}

function extractTitle(text: string): string {
	// Look for "PROYECTO DE LEY" or "PROPOSICIÓN DE LEY" followed by the title
	const titleMatch = text.match(
		/(?:PROYECTO|PROPOSICIÓN) DE LEY.*?\n\d+\/\d+\s+(.+?)(?:\n(?:La Mesa|Presentad))/s,
	);
	if (titleMatch) return titleMatch[1]!.replace(/\n/g, " ").trim();

	// Fallback: look for the title pattern after the reference number
	const fallback = text.match(
		/\d+\/\d+\s+(?:Proyecto|Proposición) de Ley (.+?)(?:\.\n|\nLa Mesa)/s,
	);
	if (fallback) return fallback[1]!.replace(/\n/g, " ").trim();

	return "unknown";
}

// ── Transitional provisions extraction ──

function extractTransitionalProvisions(text: string): string[] {
	const provisions: string[] = [];

	// Find all "Disposición transitoria X. Title.\nBody..."
	const dtRegex =
		/Disposición transitoria [\p{L}\d]+\.\s+(.+?)(?=\nDisposición (?:transitoria|derogatoria|final|adicional) [\p{L}\d]+\.|$)/gsu;

	for (const match of text.matchAll(dtRegex)) {
		provisions.push(match[1]!.trim());
	}

	return provisions;
}

// ── Modification classification ──

function classifyModification(
	ordinal: string,
	text: string,
): BillModification | null {
	const firstLine = text.split("\n")[0] ?? "";
	// Some patterns span 2-3 lines (e.g., "Se introduce, dentro de\nla sección..., un nuevo X")
	// Use the text up to the first «» block or first 500 chars as the "header"
	const quoteStart = text.indexOf("«");
	const header = (quoteStart > 0 ? text.slice(0, quoteStart) : text.slice(0, 500)).replace(/\n/g, " ");

	// "Se suprime el Capítulo/Título X" → suppress_chapter
	const suppressChapterMatch = firstLine.match(
		/Se suprime[n]? (?:el |la )?(?:Capítulo|Título|Sección) .+/i,
	);
	if (suppressChapterMatch) {
		return {
			ordinal,
			changeType: "suppress_chapter",
			targetProvision: suppressChapterMatch[0]
				.replace(/^Se suprime[n]? (?:el |la )?/, "")
				.trim()
				.replace(/\.$/, ""),
			newText: "",
			sourceText: text,
		};
	}

	// "Se modifica el artículo X, que quedan? redactado como sigue:" / "...en los siguientes términos:"
	// Also handles parenthetical: "Se modifica, en su cuarto párrafo, el apartado 2 del artículo X"
	// Try firstLine first, then header for multiline cases
	const modifyMatch = firstLine.match(
		/Se modifica[n]?(?:,\s+[^,]+,)?\s+(?:el |la |los |las )?(.+?),?\s+(?:que )?(?:queda(?:n|ndo)?|pasa[n]? a (?:tener|ser|denominarse))[\s\S]*?(?:redactad|siguiente|tenor|como|sigue|establece|modo|contenido|términos|forma)/i,
	) || header.match(
		/Se modifica[n]?(?:,\s+[^,]+,)?\s+(?:el |la |los |las )?(.+?),?\s+(?:que )?(?:queda(?:n|ndo)?|pasa[n]? a (?:tener|ser|denominarse))[\s\S]*?(?:redactad|siguiente|tenor|como|sigue|establece|modo|contenido|términos|forma)/i,
	);
	if (modifyMatch) {
		return {
			ordinal,
			changeType: "modify",
			targetProvision: modifyMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Se añade/introduce/adiciona un nuevo X" or "Se incorpora un nuevo X"
	// Allows optional parenthetical location: "Se introduce, dentro de ..., un nuevo X"
	// Uses header (multiline) because location clauses often span line breaks
	const addMatch = header.match(
		/Se (?:añade[n]?|introduce[n]?|incorpora[n]?|adiciona[n]?)(?:,\s+(?:dentro de|en) .+?,\s+| )(?:un(?:a|o)? (?:nuevo?|nueva)? )?(.+?)(?:,?\s+(?:con (?:la siguiente|el siguiente)|que queda|integrado)|$)/i,
	);
	if (addMatch) {
		return {
			ordinal,
			changeType: "add",
			targetProvision: addMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Se añade/adiciona un segundo párrafo al apartado X" (longer add pattern)
	const addParrafoMatch = header.match(
		/Se (?:añade|introduce|adiciona)[n]? (.+?)(?:,?\s+(?:con (?:la siguiente redacción|el siguiente tenor)|que quedan? redactad))/i,
	);
	if (addParrafoMatch) {
		return {
			ordinal,
			changeType: "add",
			targetProvision: addParrafoMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Se suprime X" (single article/paragraph — not chapter)
	const deleteMatch = firstLine.match(
		/Se suprime[n]? (?:el |la |los |las )?(.+)/i,
	);
	if (deleteMatch) {
		return {
			ordinal,
			changeType: "delete",
			targetProvision: deleteMatch[1]!.trim().replace(/\.$/, ""),
			newText: "",
			sourceText: text,
		};
	}

	// "Se modifica la numeración y contenido del artículo X, que pasa a ser..."
	const renumberMatch = firstLine.match(
		/Se modifica la (?:numeración|ubicación)(?: y (?:el )?contenido)? (?:de|del) (?:el |la )?(.+?), que pasa/i,
	);
	if (renumberMatch) {
		return {
			ordinal,
			changeType: "renumber",
			targetProvision: renumberMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "los actuales artículos X y Y se renumeran como artículos Z y W"
	// Uses header (multiline) because text often wraps across lines
	const passiveRenumberMatch = header.match(
		/(?:los actuales |el actual )(.+?)\s+se renumeran? como/i,
	);
	if (passiveRenumberMatch) {
		return {
			ordinal,
			changeType: "renumber",
			targetProvision: passiveRenumberMatch[1]!.trim(),
			newText: "",
			sourceText: text,
		};
	}

	// "El artículo X pasa a numerarse/ser Y, y se introduce un nuevo Z"
	// Compound renumber+add — classify as add (the introduction is the substantive change)
	// Uses header (multiline) because these patterns often wrap
	const compoundRenumberAddMatch = header.match(
		/^(?:El |La |Los |Las )(.+?)\s+(?:actual\s+)?pasa[n]?\s+a\s+(?:numerarse|ser)/i,
	);
	if (compoundRenumberAddMatch) {
		return {
			ordinal,
			changeType: "add",
			targetProvision: compoundRenumberAddMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// Fallback: any "Se modifica" pattern
	const genericModify = firstLine.match(
		/Se modifica[n]? (.+?)(?:\.|,|$)/i,
	);
	if (genericModify) {
		return {
			ordinal,
			changeType: "modify",
			targetProvision: genericModify[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "El/La [target] quedan? redactado/a ..." — many variants:
	// "en los siguientes términos", "de la siguiente forma/manera", "del siguiente modo",
	// "con el siguiente tenor literal", "con la siguiente redacción", "como sigue"
	// Also: "En el artículo X quedan? redactado...", "X se redacta con el siguiente tenor"
	// Uses header (multiline) because target+verb often span lines
	const directRedactMatch = header.match(
		/^(?:En )?(?:el |la |los |las )(.+?)\s+(?:queda(?:n|rá[n]?)?\s+(?:redactad[oa]s?|modificad[oa]s?)|tendrá[n]?\s+la siguiente redacción|se redacta[n]?)\s+(?:en los siguientes términos|de la siguiente (?:forma|manera)|del siguiente modo|con (?:el siguiente tenor(?: literal)?|la siguiente redacción|el siguiente contenido)|como sigue|en sus apart)/i,
	);
	// Variant: "X queda con la siguiente redacción:" / "X queda como sigue:"
	const directQuedaMatch = !directRedactMatch && header.match(
		/^(?:En )?(?:el |la |los |las )(.+?)\s+queda[n]?\s+(?:con la siguiente redacción|como sigue|con el siguiente tenor(?: literal)?)/i,
	);
	const redactMatch = directRedactMatch || directQuedaMatch;
	if (redactMatch) {
		return {
			ordinal,
			changeType: "modify",
			targetProvision: redactMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Artículo cuarto." as direct target (LOMLOE pattern)
	// When the modification just names the target article without "Se modifica..."
	const directArticleMatch = firstLine.match(
		/^(?:Artículo|Apartado|Párrafo|Letra|Sección|Capítulo|Título|Disposición) .+/i,
	);
	if (directArticleMatch) {
		return {
			ordinal,
			changeType: "modify",
			targetProvision: firstLine!.trim().replace(/[.:]+$/, ""),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Se dota de contenido al artículo X" (variant of add — article existed but was empty)
	const dotaMatch = header.match(
		/Se dota de contenido (?:al |a la |a los |a las )(.+?)(?:,|\.|$)/i,
	);
	if (dotaMatch) {
		return {
			ordinal,
			changeType: "add",
			targetProvision: dotaMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Todas las referencias que [ley] hace a X se entenderán hechas a Y" (textual substitution)
	const referenciasMatch = header.match(
		/Todas las referencias/i,
	);
	if (referenciasMatch) {
		return {
			ordinal,
			changeType: "modify",
			targetProvision: header.slice(0, 80).trim(),
			newText: "",
			sourceText: text,
		};
	}

	// "Se crea un nuevo artículo X" / "Se crea, dentro de ..., un «Capítulo»" (variant of add)
	const createMatch = header.match(
		/Se crea[n]?(?:,\s+(?:dentro de|en) .+?,\s+| )(?:un(?:a|o)? (?:nuevo?|nueva?)? )?(.+?)(?:,?\s+(?:con (?:la siguiente|el siguiente)|que queda)|$)/i,
	) || firstLine!.match(
		/Se crea[n]?(?:,\s+[^,]+,\s+| )(?:un(?:a|o)? )?(.+?)(?:\s+(?:con (?:la|el)|que queda|en el que)|$)/i,
	);
	if (createMatch) {
		return {
			ordinal,
			changeType: "add",
			targetProvision: createMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// Unrecognized — will be retried with LLM if apiKey is available
	return null;
}

function extractQuotedText(text: string): string {
	const quoted = text.match(/«([\s\S]*?)»/);
	return quoted ? quoted[1]!.trim() : "";
}

// ── Ordinal splitting ──

function splitByOrdinals(text: string): Array<{ ordinal: string; text: string }> {
	const pattern = buildOrdinalPattern();
	const parts: Array<{ ordinal: string; text: string }> = [];

	// Replace «...» quoted blocks with placeholders to avoid matching ordinals
	// inside replacement text (e.g., "«Uno. Los seguros...»" is content, not an ordinal)
	const PLACEHOLDER = "\x00QUOTED\x00";
	const quotedRanges: Array<[number, number]> = [];
	for (const m of text.matchAll(/«[\s\S]*?»/g)) {
		quotedRanges.push([m.index!, m.index! + m[0].length]);
	}
	let masked = text;
	// Replace from end to preserve indices
	for (let i = quotedRanges.length - 1; i >= 0; i--) {
		const [start, end] = quotedRanges[i]!;
		masked = masked.slice(0, start) + PLACEHOLDER.repeat(Math.ceil((end - start) / PLACEHOLDER.length)).slice(0, end - start) + masked.slice(end);
	}

	const matches = [...masked.matchAll(pattern)];

	for (let i = 0; i < matches.length; i++) {
		const start = matches[i]!.index! + matches[i]![0].length;
		const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
		// Use original text (not masked) for the actual content
		parts.push({
			ordinal: matches[i]![1]!,
			text: text.slice(start, end).trim(),
		});
	}

	return parts;
}

/** Split by numeric ordinals (1. 2. 3.) — fallback when text ordinals yield 0 results */
function splitByNumericOrdinals(text: string): Array<{ ordinal: string; text: string }> {
	const parts: Array<{ ordinal: string; text: string }> = [];

	// Mask «...» blocks first
	const quotedRanges: Array<[number, number]> = [];
	for (const m of text.matchAll(/«[\s\S]*?»/g)) {
		quotedRanges.push([m.index!, m.index! + m[0].length]);
	}
	let masked = text;
	for (let i = quotedRanges.length - 1; i >= 0; i--) {
		const [start, end] = quotedRanges[i]!;
		masked = masked.slice(0, start) + " ".repeat(end - start) + masked.slice(end);
	}

	// Match "N. " at start of line where N is a number
	const pattern = /(?:^|\n)(\d+)\.\s+/g;
	const matches = [...masked.matchAll(pattern)];

	// Validate: numeric ordinals should be sequential (1, 2, 3...) to avoid false positives
	if (matches.length < 2) return [];
	const nums = matches.map((m) => Number.parseInt(m[1]!));
	if (nums[0] !== 1 || nums[1] !== 2) return []; // Must start with 1, 2

	for (let i = 0; i < matches.length; i++) {
		const start = matches[i]!.index! + matches[i]![0].length;
		const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
		parts.push({
			ordinal: matches[i]![1]!,
			text: text.slice(start, end).trim(),
		});
	}

	// Final validation: at least 50% of ordinals must look like MODIFICATION instructions
	// (not just any sentence — must contain modification verbs/patterns)
	const modLikeParts = parts.filter((p) => {
		const chunk = p.text.slice(0, 200);
		return /Se modifica|Se añade|Se introduce|Se adiciona|Se suprime|Se crea|Se deroga|queda(?:n)?\s+(?:redactad|modificad|con la siguiente)|pasa a (?:ser|tener|denominarse)/i.test(chunk);
	});
	if (modLikeParts.length < parts.length * 0.5) return []; // Too many non-modification ordinals

	return parts;
}

function parseModifications(text: string, apiKey?: string): BillModification[] {
	// Try text ordinals first (Uno. Dos. Tres.)
	let parts = splitByOrdinals(text);

	// Fallback: numeric ordinals (1. 2. 3.) — used by some Serie B bills
	if (parts.length === 0) {
		parts = splitByNumericOrdinals(text);
	}

	const modifications: BillModification[] = [];
	const unclassifiedParts: Array<{ ordinal: string; text: string }> = [];

	for (const part of parts) {
		const mod = classifyModification(part.ordinal, part.text);
		if (mod) {
			modifications.push(mod);
		} else {
			unclassifiedParts.push(part);
		}
	}

	// Fallback: no ordinals at all, but body IS a modification statement
	// E.g., "Los apartados 2 y 4 del artículo 23 quedan redactados del siguiente modo:"
	if (modifications.length === 0 && parts.length === 0) {
		const directModMatch = text.match(
			/(?:Se modifica[n]?\s+(?:el |la |los |las )?|(?:Los? |Las? |El |La ))((?:artículo|apartado|párrafo|letra|número|disposición).+?)(?:,?\s+(?:que )?quedan?\s+(?:redactad|modificad)|,?\s+que pasa)/is,
		);
		if (directModMatch) {
			const mod = classifyModification("direct", text.slice(text.indexOf(directModMatch[0])));
			if (mod) {
				modifications.push(mod);
			} else {
				unclassifiedParts.push({ ordinal: "direct", text: text.slice(text.indexOf(directModMatch[0])) });
			}
		}
	}

	// Store unclassified for LLM fallback (resolved in parseModificationsAsync)
	(modifications as any).__unclassified = unclassifiedParts;

	return modifications;
}

/** Async wrapper that resolves unclassified ordinals with LLM */
async function parseModificationsAsync(text: string, apiKey?: string): Promise<BillModification[]> {
	const modifications = parseModifications(text, apiKey);
	const unclassified: Array<{ ordinal: string; text: string }> = (modifications as any).__unclassified ?? [];
	delete (modifications as any).__unclassified;

	// LLM per-ordinal fallback: classify any ordinals regex couldn't handle
	if (unclassified.length > 0 && apiKey) {
		for (const part of unclassified) {
			const llmMods = await classifyWithLLM(apiKey, part.text);
			if (llmMods.length > 0) {
				for (const lm of llmMods) {
					lm.ordinal = part.ordinal;
				}
				modifications.push(...llmMods);
			} else {
				// Both regex AND LLM failed — this is a genuine unclassifiable ordinal
				console.warn(
					`  [warn] Could not classify ordinal "${part.ordinal}": ${part.text.split("\n")[0]!.slice(0, 80)}`,
				);
			}
		}
	} else if (unclassified.length > 0) {
		// No API key — warn about unclassified ordinals
		for (const part of unclassified) {
			console.warn(
				`  [warn] Could not classify ordinal "${part.ordinal}": ${part.text.split("\n")[0]!.slice(0, 80)}`,
			);
		}
	}

	return modifications;
}

// ── Modification group detection ──

/**
 * Strategy 1: Disposiciones finales with "Modificación de..." (LO 10/2022 pattern)
 */
async function extractDFGroups(
	text: string,
	apiKey?: string,
): Promise<ModificationGroup[]> {
	const groups: ModificationGroup[] = [];

	// Match DF headers that mention modification
	// Broad lookahead: body can start with Se/Uno/Único/El/La/Los/Las/digit or next Disposición
	const dfHeaderRegex =
		/Disposición final ([\p{L}\d]+)\. (Modificación (?:de|del) [\s\S]+?)(?=\n(?:Se |Uno\.|Único\.|El |La |Los |Las |\d+\.\s|Disposición ))/gu;

	const quotedRanges = buildQuotedRanges(text);
	const headers: Array<{ title: string; startIndex: number }> = [];
	for (const match of text.matchAll(dfHeaderRegex)) {
		if (isInsideQuotedBlock(match.index!, quotedRanges)) continue;
		headers.push({
			title: match[0].split("\n")[0]!,
			startIndex: match.index!,
		});
	}

	// Find all disposición boundaries
	const anyDisposicionRegex =
		/\nDisposición (?:final|transitoria|derogatoria|adicional) [\p{L}\d]+\./gu;
	const boundaries: number[] = [];
	for (const match of text.matchAll(anyDisposicionRegex)) {
		boundaries.push(match.index!);
	}
	boundaries.push(text.length);

	for (const header of headers) {
		const nextBoundary = boundaries.find((b) => b > header.startIndex + 10);
		if (!nextBoundary) continue;

		const fullText = text.slice(header.startIndex, nextBoundary);

		// Extract target law
		const lawMatch = fullText.match(
			/Modificación (?:de|del) (?:la |el |los |las )?(.+?)(?:\.\n|\n(?:Se |Uno\.|Único\.|El |La |Los |Las |\d+\.\s))/s,
		);
		const targetLaw = lawMatch
			? lawMatch[1]!.replace(/\n/g, " ").trim()
			: header.title;

		let modifications = apiKey
			? await parseModificationsAsync(fullText, apiKey)
			: parseModifications(fullText);

		// LLM fallback: if no ordinals found but DF has content, use LLM
		if (modifications.length === 0 && apiKey && fullText.length > 200) {
			modifications = await classifyWithLLM(apiKey, fullText);
		}

		if (modifications.length > 0) {
			groups.push({
				title: header.title,
				targetLaw,
				modifications,
			});
		}
	}

	return groups;
}

/**
 * Strategy 2: "Artículo primero/segundo/etc. Modificación de..." (LO 14/2022 pattern)
 */
async function extractArticuloGroups(text: string, apiKey?: string): Promise<ModificationGroup[]> {
	const groups: ModificationGroup[] = [];

	// Match "Artículo primero/segundo/1/2/etc. Modificación de..."
	// Broad lookahead covers all common body-start patterns
	const artHeaderRegex =
		/Artículo ([\p{L}\d]+)\. (Modificación (?:de|del) [\s\S]+?)(?=\n(?:Se |Uno\.|Único\.|El |La |Los |Las |\d+\.\s))/gu;

	const quotedRanges = buildQuotedRanges(text);
	const headers: Array<{
		title: string;
		targetLaw: string;
		startIndex: number;
	}> = [];

	for (const match of text.matchAll(artHeaderRegex)) {
		if (isInsideQuotedBlock(match.index!, quotedRanges)) continue;
		const lawMatch = match[2]!.match(
			/Modificación (?:de|del) (?:la |el |los |las )?(.+)/s,
		);
		headers.push({
			title: `Artículo ${match[1]!}. ${match[2]!.replace(/\n/g, " ").trim()}`,
			targetLaw: lawMatch
				? lawMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "")
				: match[2]!.replace(/\n/g, " ").trim(),
			startIndex: match.index!,
		});
	}

	if (headers.length === 0) return [];

	// Find boundaries: next "Artículo X." or "Disposición" or end
	const boundaryRegex =
		/\n(?:Artículo [\p{L}\d]+\.|Disposición (?:transitoria|derogatoria|final|adicional) [\p{L}\d]+\.)/gu;
	const boundaries: number[] = [];
	for (const match of text.matchAll(boundaryRegex)) {
		boundaries.push(match.index!);
	}
	boundaries.push(text.length);

	for (const header of headers) {
		const nextBoundary = boundaries.find((b) => b > header.startIndex + 10);
		if (!nextBoundary) continue;

		const fullText = text.slice(header.startIndex, nextBoundary);
		const modifications = apiKey
			? await parseModificationsAsync(fullText, apiKey)
			: parseModifications(fullText);

		if (modifications.length > 0) {
			groups.push({
				title: header.title,
				targetLaw: header.targetLaw,
				modifications,
			});
		}
	}

	return groups;
}

/**
 * Strategy 3: "Artículo único" (LO 1/2015 pattern)
 * The entire bill body (between "Artículo único" and "Disposición") is one big group.
 *
 * Handles two sub-patterns:
 * a) "Artículo único. Modificación de la LO 10/1995..." — keyword in header
 * b) "Artículo único.\nSe modifican los siguientes artículos de la Ley 49/2002..." — keyword in body
 * c) "Artículo único.\nUno. El artículo 87 de la Constitución quedan? redactado..." — no keyword, just mods
 */
async function extractArticuloUnicoGroup(text: string, apiKey?: string): Promise<ModificationGroup[]> {
	// Find "Artículo único." anywhere in text, but not inside «» quoted blocks
	const quotedRanges = buildQuotedRanges(text);
	const artUnicoMatch = text.match(/Artículo único\./);
	if (!artUnicoMatch) return [];
	if (isInsideQuotedBlock(artUnicoMatch.index!, quotedRanges)) return [];

	const artUnicoStart = artUnicoMatch.index!;

	// Find the end: first "Disposición" after the artículo único
	const disposicionMatch = text
		.slice(artUnicoStart + 20)
		.match(/\nDisposición (?:adicional|transitoria|derogatoria|final) [\p{L}\d]+\./u);
	const endIndex = disposicionMatch
		? artUnicoStart + 20 + disposicionMatch.index!
		: text.length;

	const bodyText = text.slice(artUnicoStart, endIndex);

	// Check if the body contains modification keywords
	const hasModKeywords = /Se modifica|quedan? redactad|Se añade|Se introduce|Se adiciona|Se suprime|Se propone (?:la )?(?:adecuación|modificación)/i.test(bodyText);
	if (!hasModKeywords) return [];

	// Extract target law name
	let targetLaw = "unknown";

	// Pattern a: "Artículo único. Modificación de la LO 10/1995..."
	const modTitleMatch = bodyText.match(
		/Artículo único\.\s+(Modificación (?:de|del) (?:la |el |los |las )?(.+?))(?:\.\n|\n(?:Se |Uno\.|Único\.|El |La |Los |Las |\d+\.\s))/s,
	);
	if (modTitleMatch) {
		targetLaw = modTitleMatch[2]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
	}

	// Pattern b: "Se modifican los siguientes artículos de la Ley X..."
	if (targetLaw === "unknown") {
		const seModMatch = bodyText.match(
			/Se modifica[n]?\s+(?:los siguientes (?:artículos|preceptos|apartados) (?:de|del) (?:la |el |los |las )?)?(.+?)(?:,|\.\n|\n(?:en los siguientes|como sigue|\d+\.\s|Uno\.))/s,
		);
		if (seModMatch) {
			targetLaw = seModMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
		}
	}

	// Pattern c: look for law name in "del artículo X de la [LEY]"
	if (targetLaw === "unknown") {
		const lawRefMatch = bodyText.match(
			/(?:del artículo|de la disposición) .+? (?:de|del) (?:la |el )(.+?)(?:\s+queda| que )/s,
		);
		if (lawRefMatch) {
			targetLaw = lawRefMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
		}
	}

	const title = modTitleMatch
		? `Artículo único. ${modTitleMatch[1]!.replace(/\n/g, " ").trim()}`
		: `Artículo único. Modificación de ${targetLaw}`;

	const modifications = apiKey
		? await parseModificationsAsync(bodyText, apiKey)
		: parseModifications(bodyText);

	if (modifications.length === 0) return [];

	return [
		{
			title,
			targetLaw,
			modifications,
		},
	];
}

// ── LLM fallback for unclassifiable modifications ──

const LLM_MODEL = "google/gemini-2.5-flash-lite";

/** JSON Schema for structured LLM output — guarantees valid JSON */
const LLM_MODIFICATIONS_SCHEMA = {
	type: "object" as const,
	properties: {
		modifications: {
			type: "array" as const,
			items: {
				type: "object" as const,
				properties: {
					change_type: {
						type: "string" as const,
						enum: ["modify", "add", "delete", "renumber", "suppress_chapter"],
					},
					target_provision: { type: "string" as const },
				},
				required: ["change_type", "target_provision"],
				additionalProperties: false,
			},
		},
	},
	required: ["modifications"],
	additionalProperties: false,
};

async function classifyWithLLM(
	apiKey: string,
	sectionText: string,
): Promise<BillModification[]> {
	const truncated = sectionText.slice(0, 6000); // ~1500 tokens
	try {
		const result = await callOpenRouter<{
			modifications: Array<{
				change_type: string;
				target_provision: string;
			}>;
		}>(apiKey, {
			model: LLM_MODEL,
			messages: [
				{
					role: "system",
					content: `Eres un parser de textos legislativos españoles. Extrae las modificaciones de esta sección legislativa.
Para cada modificación, indica:
- "change_type": "modify" | "add" | "delete" | "renumber" | "suppress_chapter"
- "target_provision": qué se modifica (ej: "párrafo m) del artículo 31 bis", "apartado 2 del artículo 83")
No incluyas texto del articulado, solo el tipo y target.`,
				},
				{ role: "user", content: truncated },
			],
			temperature: 0,
			maxTokens: 1000,
			jsonSchema: {
				name: "bill_modifications",
				schema: LLM_MODIFICATIONS_SCHEMA,
			},
		});
		return (result.data.modifications ?? []).map((m, i) => ({
			ordinal: `llm-${i + 1}`,
			changeType: (m.change_type as BillModification["changeType"]) || "modify",
			targetProvision: m.target_provision || "unknown",
			newText: extractQuotedText(sectionText),
			sourceText: sectionText.slice(0, 500),
		}));
	} catch (err) {
		console.warn(`  [llm-fallback] Failed: ${err}`);
		return [];
	}
}

// ── Strategy 4: Disposiciones adicionales with modification keywords ──

async function extractDAGroups(
	text: string,
	apiKey?: string,
): Promise<ModificationGroup[]> {
	const groups: ModificationGroup[] = [];

	// Find all DA boundaries, excluding those inside «» quoted blocks
	const quotedRanges = buildQuotedRanges(text);
	const daHeaderRegex =
		/Disposición adicional ([\p{L}\d]+)\.\s+/gu;
	const headers: Array<{ ordinal: string; startIndex: number }> = [];
	for (const match of text.matchAll(daHeaderRegex)) {
		if (isInsideQuotedBlock(match.index!, quotedRanges)) continue;
		headers.push({ ordinal: match[1]!, startIndex: match.index! });
	}

	if (headers.length === 0) return [];

	// Find all section boundaries (any Disposición or Artículo)
	const boundaries = findSectionBoundaries(text);

	for (const header of headers) {
		const nextBoundary = boundaries.find((b) => b > header.startIndex + 10);
		if (!nextBoundary) continue;

		const fullText = text.slice(header.startIndex, nextBoundary);

		// Check if body contains modification keywords
		const hasModKeywords = /Se modifica|quedan? redactad|Se añade|Se introduce|Se adiciona/i.test(fullText);
		if (!hasModKeywords) continue;

		// Extract target law from body
		const lawMatch = fullText.match(
			/(?:Se modifica[n]?\s+(?:el |la |los |las )?(?:artículo|apartado|párrafo|letra|número).+?(?:de|del) (?:la |el |los |las )?|(?:de|del) (?:la |el |los |las )?)(.+?)(?:,\s+que queda|\.\n|\n«)/s,
		);
		const targetLaw = lawMatch
			? lawMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "")
			: `DA ${header.ordinal}`;

		let modifications = apiKey
			? await parseModificationsAsync(fullText, apiKey)
			: parseModifications(fullText);

		// LLM fallback for DAs without ordinals
		if (modifications.length === 0 && apiKey && fullText.length > 200) {
			modifications = await classifyWithLLM(apiKey, fullText);
		}

		if (modifications.length > 0) {
			groups.push({
				title: `Disposición adicional ${header.ordinal}. Modificación de ${targetLaw}`,
				targetLaw,
				modifications,
			});
		}
	}

	return groups;
}

// ── Strategy 5: Catch-all — any section with implicit modifications ──

/**
 * Scans ALL sections (Artículo N, DF, DA) for modification keywords.
 * Catches groups that strategies 1-4 miss: articles without "Modificación" in title
 * but with "Se modifica" in body (e.g., BOCG-15-A-3-1 omnibus hidden mods).
 */
async function extractImplicitModGroups(
	text: string,
	existingGroupRanges: Array<[number, number]>,
	apiKey?: string,
): Promise<ModificationGroup[]> {
	const groups: ModificationGroup[] = [];
	const boundaries = findSectionBoundaries(text);
	const quotedRanges = buildQuotedRanges(text);

	// Find Artículo and DF/DA section headers (exclude transitorias and derogatorias)
	const sectionRegex =
		/(?:^|\n)((?:Artículo [\p{L}\d]+|Disposición (?:final|adicional) [\p{L}\d]+)\.)\s+/gu;

	for (const match of text.matchAll(sectionRegex)) {
		const startIndex = match.index!;

		// Skip headers inside «» quoted blocks (proposed law text, not bill structure)
		if (isInsideQuotedBlock(startIndex, quotedRanges)) continue;

		// Skip if this range is already covered by a found group
		if (existingGroupRanges.some(([s, e]) => startIndex >= s && startIndex < e)) {
			continue;
		}

		const nextBoundary = boundaries.find((b) => b > startIndex + 10);
		if (!nextBoundary) continue;

		const fullText = text.slice(startIndex, nextBoundary);

		// Skip very short sections (boilerplate like "Entrada en vigor", "Título competencial")
		if (fullText.length < 150) continue;

		// Strict check: modification keywords must appear in the FIRST 500 chars
		// (not buried deep in article body text)
		const firstChunk = fullText.slice(0, 500);
		const hasModInHeader =
			/Se modifica[n]?\s+(?:el |la |los |las )?(?:artículo|apartado|párrafo|letra|número|disposición)/i.test(firstChunk) ||
			/queda(?:n)?\s+(?:redactad|modificad)/i.test(firstChunk) ||
			/Se (?:añade|introduce|adiciona)[n]?\s/i.test(firstChunk) ||
			/Se suprime/i.test(firstChunk);

		if (!hasModInHeader) continue;

		// Must reference a specific external law (Ley, RD, Código, Estatuto, etc.)
		const referencesExternalLaw =
			/(?:Ley|Real Decreto|Código|Estatuto|Constitución|Reglamento|texto refundido)/i.test(fullText.slice(0, 1000));
		if (!referencesExternalLaw) continue;

		// Extract target law
		const sectionTitle = match[1];
		let targetLaw = "unknown";

		// Check header for law name
		const titleLawMatch = fullText.match(
			/(?:Modificación|modificación) (?:de|del) (?:la |el |los |las )?(.+?)(?:\.\n|\n)/,
		);
		if (titleLawMatch) {
			targetLaw = titleLawMatch[1]!.replace(/\n/g, " ").trim();
		}

		// Check body for law reference
		if (targetLaw === "unknown") {
			const bodyLawMatch = fullText.match(
				/(?:de|del) (?:la |el |los |las )?((?:Ley|Real Decreto|texto refundido|Constitución|Reglamento|Código|Estatuto).+?)(?:,\s+(?:que|en |aprobad)|\.\n)/s,
			);
			if (bodyLawMatch) {
				targetLaw = bodyLawMatch[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
			}
		}

		let modifications = apiKey
			? await parseModificationsAsync(fullText, apiKey)
			: parseModifications(fullText);

		// LLM fallback for sections with 0 mods
		if (modifications.length === 0 && apiKey && fullText.length > 200) {
			modifications = await classifyWithLLM(apiKey, fullText);
		}

		if (modifications.length > 0) {
			groups.push({
				title: `${sectionTitle} Modificación de ${targetLaw}`,
				targetLaw,
				modifications,
			});
		}
	}

	return groups;
}

// ── Quote range detection (shared utility) ──

/**
 * Build sorted list of [start, end] ranges for «...» quoted blocks.
 * Text inside «» is proposed law text, not bill structure — any headers
 * found inside (e.g., "Disposición adicional séptima") are NOT real sections.
 */
function buildQuotedRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let searchFrom = 0;
	while (true) {
		const open = text.indexOf("«", searchFrom);
		if (open === -1) break;
		const close = text.indexOf("»", open + 1);
		if (close === -1) break;
		ranges.push([open, close]);
		searchFrom = close + 1;
	}
	return ranges;
}

/** Check if a character index falls inside any «...» quoted block. */
function isInsideQuotedBlock(
	index: number,
	quotedRanges: Array<[number, number]>,
): boolean {
	// Binary search would be faster but linear is fine for typical bill sizes
	for (const [start, end] of quotedRanges) {
		if (index > start && index < end) return true;
		if (start > index) break; // ranges are sorted, no point continuing
	}
	return false;
}

// ── Section boundary finder (shared utility) ──

function findSectionBoundaries(text: string): number[] {
	const boundaryRegex =
		/\n(?:Artículo [\p{L}\d]+\.|Disposición (?:final|transitoria|derogatoria|adicional) [\p{L}\d]+\.)/gu;
	const boundaries: number[] = [];
	for (const match of text.matchAll(boundaryRegex)) {
		boundaries.push(match.index!);
	}
	boundaries.push(text.length);
	return boundaries;
}

// ── Main parser ──

export async function parseBill(
	text: string,
	options?: { apiKey?: string },
): Promise<ParsedBill> {
	const bocgId = extractBocgId(text);
	const publicationDate = extractPublicationDate(text);
	const title = extractTitle(text);
	const transitionalProvisions = extractTransitionalProvisions(text);

	// Run all strategies and combine results
	let modificationGroups: ModificationGroup[] = [];

	// Strategy 1: Disposiciones finales with "Modificación de..." (LO 10/2022)
	const dfGroups = await extractDFGroups(text, options?.apiKey);
	modificationGroups.push(...dfGroups);

	// Strategy 2: "Artículo primero/segundo" with "Modificación de..." (LO 14/2022)
	const artGroups = await extractArticuloGroups(text, options?.apiKey);
	modificationGroups.push(...artGroups);

	// Strategy 3: "Artículo único" — with or without "Modificación" (LO 1/2015, B-40-1)
	const unicoGroups = await extractArticuloUnicoGroup(text, options?.apiKey);
	modificationGroups.push(...unicoGroups);

	// Strategy 4: Disposiciones adicionales with modification keywords (Amnistía pattern)
	const daGroups = await extractDAGroups(text, options?.apiKey);
	modificationGroups.push(...daGroups);

	// Strategy 5: Catch-all — any section with implicit modifications not caught above
	// Build ranges of already-found groups to avoid duplicates
	const existingRanges: Array<[number, number]> = [];
	for (const group of modificationGroups) {
		// Find approximate position of each group in the text
		const titleSnippet = group.title.slice(0, 40);
		const idx = text.indexOf(titleSnippet);
		if (idx >= 0) {
			// Estimate end as start + reasonable section size
			const nextSectionIdx = text.indexOf("\nDisposición ", idx + 100);
			const nextArticleIdx = text.indexOf("\nArtículo ", idx + 100);
			const end = Math.min(
				nextSectionIdx > 0 ? nextSectionIdx : text.length,
				nextArticleIdx > 0 ? nextArticleIdx : text.length,
			);
			existingRanges.push([idx, end]);
		}
	}
	const implicitGroups = await extractImplicitModGroups(text, existingRanges, options?.apiKey);
	modificationGroups.push(...implicitGroups);

	// Deduplicate groups with overlapping target laws
	modificationGroups = deduplicateGroups(modificationGroups);

	// Strategy 7: Last resort — bill title says "modificación" but no groups found
	// Some Serie B proposiciones use informal structure (no Artículos, no DFs)
	// with ordinals (Uno. Dos.) directly in the body after exposición de motivos
	if (modificationGroups.length === 0) {
		const titleMod = title.match(/modificación (?:de|del) (?:la |el |los |las )?(.+)/i)
			?? text.match(/Proposición de Ley de modificación (?:de|del) (?:la |el |los |las )?(.+?)(?:\.\n|\n(?:Present|Acuerdo))/is);
		if (titleMod) {
			const targetLaw = titleMod[1]!.replace(/\n/g, " ").trim().replace(/\.$/, "");
			// Find body: after "Exposición de motivos" section ends, look for ordinals
			const bodyStart = text.search(/\n(?:Uno|Primero|1)\.\s/);
			if (bodyStart > 0) {
				const bodyText = text.slice(bodyStart);
				const modifications = options?.apiKey
					? await parseModificationsAsync(bodyText, options.apiKey)
					: parseModifications(bodyText);
				if (modifications.length > 0) {
					modificationGroups.push({
						title: `Modificación de ${targetLaw}`,
						targetLaw,
						modifications,
					});
				}
			}
		}
	}

	// Strategy 8: LLM verification — independent extraction to catch gaps
	if (options?.apiKey) {
		const llmGapGroups = await verifyWithLLM(text, modificationGroups, options.apiKey);
		if (llmGapGroups.length > 0) {
			modificationGroups.push(...llmGapGroups);
			modificationGroups = deduplicateGroups(modificationGroups);
		}
	}

	return {
		bocgId,
		title,
		publicationDate,
		modificationGroups,
		transitionalProvisions,
		rawText: text,
	};
}

// ── Strategy 6: LLM verification — independent second opinion ──

/** JSON Schema for LLM verification response */
const LLM_VERIFICATION_SCHEMA = {
	type: "object" as const,
	properties: {
		modified_laws: {
			type: "array" as const,
			items: {
				type: "object" as const,
				properties: {
					target_law: { type: "string" as const },
					section_in_bill: { type: "string" as const },
				},
				required: ["target_law", "section_in_bill"] as const,
				additionalProperties: false,
			},
		},
	},
	required: ["modified_laws"] as const,
	additionalProperties: false,
};

/**
 * Extract a "skeleton" of the bill: headers + modification keywords with context.
 * Much smaller than the full text, enough for the LLM to identify all modified laws.
 */
function extractBillSkeleton(text: string): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	const patterns = [
		/^Artículo/i, /^Disposición/i, /Se modifica/i, /Modificación/i,
		/queda(?:n)?\s+redactad/i, /Se añade/i, /Se suprime/i, /Se introduce/i,
		/Se adiciona/i, /Se deroga/i, /Se crea/i,
	];

	for (let i = 0; i < lines.length; i++) {
		if (patterns.some((p) => p.test(lines[i]!))) {
			kept.push(lines[i]!);
			if (i + 1 < lines.length) kept.push(lines[i + 1]!);
			kept.push("");
		}
	}

	return kept.join("\n").slice(0, 60_000);
}

/** Normalize a law name for fuzzy comparison */
function normalizeLawName(name: string): string {
	return name
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/ley orgánica/g, "lo")
		.replace(/real decreto[- ]ley/g, "rdl")
		.replace(/real decreto legislativo/g, "rdl")
		.replace(/real decreto/g, "rd")
		.replace(/texto refundido de la /g, "")
		.replace(/texto refundido del /g, "")
		.replace(/,? de \d+ de \w+ de \d+/g, "")
		.replace(/[.,;:()"'«»]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Check if two law names refer to the same law */
function lawNamesMatch(a: string, b: string): boolean {
	const na = normalizeLawName(a);
	const nb = normalizeLawName(b);
	if (na === nb) return true;

	// Check if significant words overlap (>50%)
	const wordsA = na.split(" ").filter((w) => w.length > 3);
	const wordsB = nb.split(" ").filter((w) => w.length > 3);
	if (wordsA.length === 0 || wordsB.length === 0) return false;

	const matchedAB = wordsA.filter((w) => nb.includes(w)).length;
	const matchedBA = wordsB.filter((w) => na.includes(w)).length;
	return matchedAB >= wordsA.length * 0.5 || matchedBA >= wordsB.length * 0.5;
}

/**
 * LLM verification: ask the LLM to independently list all laws the bill modifies.
 * For any law the LLM finds that the regex parser missed, try to locate and extract
 * the modifications from the bill text.
 */
async function verifyWithLLM(
	text: string,
	existingGroups: ModificationGroup[],
	apiKey: string,
): Promise<ModificationGroup[]> {
	const skeleton = text.length > 30_000 ? extractBillSkeleton(text) : text;
	const gapGroups: ModificationGroup[] = [];

	try {
		const result = await callOpenRouter<{
			modified_laws: Array<{ target_law: string; section_in_bill: string }>;
		}>(apiKey, {
			model: LLM_MODEL,
			messages: [
				{
					role: "system",
					content: `Eres un analista legislativo. Dado un proyecto de ley español (BOCG), lista TODAS las leyes que este proyecto modifica.

Incluye SOLO leyes que se modifican (Se modifica, quedan? redactado, Se añade, Se suprime).
NO incluyas leyes que solo se citan o referencian sin modificar.
NO incluyas la propia ley del proyecto.
NO incluyas directivas europeas ni tratados internacionales.

Para cada ley modificada indica:
- "target_law": nombre de la ley (ej: "Código Penal", "Ley 39/2015 de Procedimiento Administrativo")
- "section_in_bill": dónde aparece la modificación (ej: "DF cuarta", "DA primera", "Artículo 3")`,
				},
				{
					role: "user",
					content: `${text.length > 30_000 ? "Esqueleto estructural del proyecto de ley (headers y líneas de modificación):" : "Texto del proyecto de ley:"}\n\n${skeleton}`,
				},
			],
			temperature: 0,
			maxTokens: 4000,
			jsonSchema: { name: "bill_verification", schema: LLM_VERIFICATION_SCHEMA },
		});

		const llmLaws = result.data.modified_laws ?? [];
		const existingLawNames = existingGroups.map((g) => g.targetLaw);

		// Find laws the LLM found that the parser missed
		for (const llmLaw of llmLaws) {
			const alreadyFound = existingLawNames.some((name) =>
				lawNamesMatch(name, llmLaw.target_law),
			);
			if (alreadyFound) continue;

			// Locate the section in text
			const sectionText = locateSection(text, llmLaw.section_in_bill, llmLaw.target_law);
			if (!sectionText) continue;

			// Validate: the section must actually contain modification keywords
			// (the LLM sometimes confuses "cites law" with "modifies law")
			const firstChunk = sectionText.slice(0, 500);
			const hasModKeywords =
				/Se modifica[n]?\s+/i.test(firstChunk) ||
				/queda(?:n)?\s+(?:redactad|modificad)/i.test(firstChunk) ||
				/Se (?:añade|introduce|adiciona|suprime)[n]?\s/i.test(firstChunk) ||
				/Se crea[n]?\s/i.test(firstChunk);
			if (!hasModKeywords) continue;

			console.log(`  [llm-verify] Gap detected: "${llmLaw.target_law}" in ${llmLaw.section_in_bill}`);

			let modifications = await parseModificationsAsync(sectionText, apiKey);
			if (modifications.length === 0 && sectionText.length > 200) {
				modifications = await classifyWithLLM(apiKey, sectionText);
			}

			if (modifications.length > 0) {
				gapGroups.push({
					title: `${llmLaw.section_in_bill}. Modificación de ${llmLaw.target_law} (LLM-verified)`,
					targetLaw: llmLaw.target_law,
					modifications,
				});
			}
		}
	} catch (err) {
		console.log(`  [llm-verify] Verification failed: ${err}`);
	}

	return gapGroups;
}

/** Try to locate a section in the bill text by its identifier (e.g., "DF cuarta", "Artículo 3") */
function locateSection(text: string, sectionRef: string | undefined, targetLaw: string): string | null {
	if (!sectionRef) sectionRef = "";
	const boundaries = findSectionBoundaries(text);

	// Try to find by section reference
	const patterns = [
		// "DF cuarta" → "Disposición final cuarta"
		sectionRef.replace(/^DF /i, "Disposición final "),
		// "DA primera" → "Disposición adicional primera"
		sectionRef.replace(/^DA /i, "Disposición adicional "),
		// "Artículo 3" → "Artículo 3."
		sectionRef.replace(/^(Artículo \d+)$/i, "$1."),
		// Direct match
		sectionRef,
	];

	for (const pattern of patterns) {
		const idx = text.indexOf(pattern);
		if (idx < 0) continue;

		const nextBoundary = boundaries.find((b) => b > idx + 10);
		if (!nextBoundary) continue;

		const section = text.slice(idx, nextBoundary);
		// Validate: section should reference the target law
		if (section.length > 100) return section;
	}

	// Fallback: search for the target law name near modification keywords
	const lawIdx = text.indexOf(targetLaw.slice(0, 30));
	if (lawIdx >= 0) {
		// Find the containing section
		const sectionStart = boundaries.filter((b) => b < lawIdx).pop() ?? 0;
		const sectionEnd = boundaries.find((b) => b > lawIdx + 10) ?? text.length;
		const section = text.slice(sectionStart, sectionEnd);
		if (section.length > 100 && section.length < 50_000) return section;
	}

	return null;
}

/** Remove duplicate groups that target the same law with overlapping modifications */
function deduplicateGroups(groups: ModificationGroup[]): ModificationGroup[] {
	const seen = new Map<string, number>(); // key → index of first occurrence
	const result: ModificationGroup[] = [];

	for (const group of groups) {
		// Create a dedup key from the first 50 chars of target law + first mod target
		const firstMod = group.modifications[0]?.targetProvision ?? "";
		const key = `${group.targetLaw.slice(0, 50).toLowerCase()}|${firstMod.slice(0, 30).toLowerCase()}`;

		if (seen.has(key)) {
			// Keep the one with more modifications
			const existingIdx = seen.get(key)!;
			if (group.modifications.length > result[existingIdx]!.modifications.length) {
				result[existingIdx] = group;
			}
		} else {
			seen.set(key, result.length);
			result.push(group);
		}
	}

	return result;
}
