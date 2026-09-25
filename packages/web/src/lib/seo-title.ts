/**
 * Short, search-friendly `<title>` for a law page.
 *
 * Bing Webmaster Tools flags a `<title>` over ~70 characters as "Title too
 * long"; Google truncates around 60 characters (~580px) in the SERP. The BOE
 * title is the *official* name of the norm — long, legally precise, full of
 * subordinate clauses ("Real Decreto Legislativo 2/2015, de 23 de octubre,
 * por el que se aprueba el texto refundido de la Ley del Estatuto de los
 * Trabajadores") — and is never shortened on the page itself (the `<h1>` and
 * `og:title` keep it in full, see below). This module derives a short,
 * human, still-recognizable form for `<title>` only.
 *
 * Pipeline: `shortLawTitle` → a curated popular name (a handful of laws
 * people search for by name) or a heuristic strip of the BOE's boilerplate
 * (date clause, "por el que se aprueba el texto refundido de la Ley…",
 * "y otras leyes complementarias…") down to the subject, combined with a
 * short rank+number abbreviation in parentheses ("RDLeg 2/2015") when it
 * fits. `composeSeoTitle` then decides whether " — Ley Abierta" fits after
 * that within `SEO_TITLE_MAX`; if not, the suffix is dropped rather than
 * truncating the law's name (a citizen scanning search results needs the
 * name, not our brand).
 *
 * `og:title` is NOT shortened by this module — see `[id].astro`, which
 * passes the full official `law.titulo` as `ogTitle`. Social/chat previews
 * render the full og:title without truncation concerns the way a SERP
 * <title> does, and losing the official name there would make link previews
 * less trustworthy for an institutional site. Only the SERP-facing
 * `<title>` (and therefore `document.title`) is shortened.
 */

import {
	cleanText,
	codePointLength,
	truncateAtWordBoundary,
} from "./meta-description.ts";

export const SEO_TITLE_TARGET = 60;
export const SEO_TITLE_MAX = 70;
export const SEO_TITLE_SUFFIX = " — Ley Abierta";

/** Same abbreviations used for the ficha page's `alternateName`/description. */
const RANK_ABBREVS: Record<string, string> = {
	constitucion: "CE",
	real_decreto: "RD",
	ley_organica: "LO",
	ley: "L",
	real_decreto_ley: "RDL",
	real_decreto_legislativo: "RDLeg",
	orden: "O",
	decreto: "D",
	resolucion: "Res",
};

/**
 * Curated short names for laws citizens commonly search for by name, keyed
 * by BOE/regional id. Only for the handful where a popular short name is
 * clearly better than the heuristic below (e.g. well-known acronyms) — the
 * heuristic alone must handle the other ~12k laws, and most of these entries
 * exist for clarity/consistency rather than because the heuristic fails.
 */
export const POPULAR_LAW_NAMES: Record<string, string> = {
	// Estatuto de los Trabajadores (RDLeg 2/2015)
	"BOE-A-2015-11430": "Estatuto de los Trabajadores",
	// Ley General Tributaria (L 58/2003)
	"BOE-A-2003-23186": "Ley General Tributaria",
	// LOPDGDD (LO 3/2018) — well-known by its acronym
	"BOE-A-2018-16673": "LOPDGDD (protección de datos)",
	// Ley de Enjuiciamiento Civil (L 1/2000)
	"BOE-A-2000-323": "Ley de Enjuiciamiento Civil",
	// Ley de Enjuiciamiento Criminal (1882)
	"BOE-A-1882-6036": "Ley de Enjuiciamiento Criminal",
	// Código Penal (LO 10/1995)
	"BOE-A-1995-25444": "Código Penal",
	// LPAC (L 39/2015)
	"BOE-A-2015-10565": "Ley del Procedimiento Administrativo Común",
	// IRPF (L 35/2006)
	"BOE-A-2006-20764": "Ley del IRPF",
	// IVA (L 37/1992)
	"BOE-A-1992-28740": "Ley del IVA",
	// Ley General de la Seguridad Social (RDLeg 8/2015)
	"BOE-A-2015-11724": "Ley General de la Seguridad Social",
	// LAU (L 29/1994)
	"BOE-A-1994-26003": "Ley de Arrendamientos Urbanos",
	// Ley de Tráfico (RDLeg 6/2015)
	"BOE-A-2015-11722": "Ley de Tráfico y Seguridad Vial",
	// Ley General para la Defensa de los Consumidores y Usuarios (RDLeg 1/2007)
	"BOE-A-2007-20555": "Ley de Consumidores y Usuarios",
	// Impuesto sobre Sociedades (L 27/2014)
	"BOE-A-2014-12328": "Ley del Impuesto sobre Sociedades",
};

const MONTH_NAME =
	"enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre";

/**
 * ", de 23 de octubre," / ", de 5 de diciembre de 2018," → removed. Global:
 * some titles embed several such clauses (e.g. a law amending several other
 * dated laws in one sentence), and only removing the first would leave the
 * rest to eat into the truncation budget for no benefit.
 */
const DATE_CLAUSE = new RegExp(
	`,?\\s*de\\s+\\d{1,2}\\s+de\\s+(?:${MONTH_NAME})(?:\\s+de\\s+\\d{4})?\\s*,`,
	"gi",
);

/** Trailing boilerplate that adds nothing to a short name. */
const TRAILING_BOILERPLATE = [
	/\s*,?\s*y\s+otras\s+leyes\s+complementarias\.?$/i,
	/\s*,?\s*y\s+otras\s+normas\s+complementarias\.?$/i,
];

// Applied in order — first match wins. Each strips a BOE boilerplate prefix
// down to the law's subject.
const BOILERPLATE_PREFIXES = [
	// "…por el que se aprueba el texto refundido de la Ley [del/de la/sobre] X" → "X"
	/^.*?\bpor\s+el\s+que\s+se\s+aprueba\s+el\s+texto\s+refundido\s+de\s+la\s+ley\s+(?:del?\s+|de\s+la\s+|de\s+los\s+|de\s+las\s+|sobre\s+)?/i,
	// "…por el que se aprueba el/la/los/las X" (regulations, not a "Ley") → "X"
	/^.*?\bpor\s+el\s+que\s+se\s+aprueban?\s+(?:el|la|los|las)\s+/i,
	// Direct "Ley/Real Decreto/… N/AAAA [del/de la/sobre] X" → "X"
	/^(?:ley\s+org[aá]nica|ley|real\s+decreto\s+legislativo|real\s+decreto[- ]ley|real\s+decreto|decreto[- ]ley|decreto|orden|resoluci[oó]n|instrucci[oó]n|reglamento|acuerdo|circular)\s+[\d./]+\s*(?:del?\s+|de\s+la\s+|de\s+los\s+|de\s+las\s+|sobre\s+)?/i,
];

// A short connector word right before the ellipsis reads badly ("…de la Ley
// 25/1983, de…") — `truncateAtWordBoundary` only guarantees a word boundary,
// not that the last word is meaningful. Strip these once more before
// settling on the final cut.
const DANGLING_CONNECTOR =
	/\s+(?:de|del|la|el|los|las|y|o|en|a|al|que|para|por|con|su|sus|un|una|unos|unas|se)…$/i;

/** `truncateAtWordBoundary`, then drop a dangling connector word before "…". */
function truncateSubject(text: string, max: number): string {
	let out = truncateAtWordBoundary(text, max);
	let prev: string;
	do {
		prev = out;
		out = out.replace(DANGLING_CONNECTOR, "…");
	} while (out !== prev);
	return out;
}

/** Extract "2/2015" / "27/2014" (rank+number) from a BOE title, if present. */
function extractNumber(titulo: string): string | undefined {
	return titulo.match(/(\d+\/\d{4})/)?.[1];
}

/**
 * Short rank+number abbreviation, e.g. "RDLeg 2/2015", or undefined when the
 * rank has no abbreviation or the title carries no N/AAAA number (e.g. the
 * 1882 Ley de Enjuiciamiento Criminal, dated instead of numbered).
 */
export function lawAbbreviation(
	rango: string,
	titulo: string,
): string | undefined {
	const abbrev = RANK_ABBREVS[rango];
	if (!abbrev) return undefined;
	const number = extractNumber(titulo);
	return number ? `${abbrev} ${number}` : undefined;
}

/**
 * Heuristic subject extraction from a BOE title: strip the date clause,
 * the "por el que se aprueba…" / rank+number boilerplate down to the
 * subject, and trailing "y otras leyes complementarias". Titles with none
 * of that boilerplate (e.g. "Constitución Española", "Código Civil") are
 * returned unchanged.
 */
export function heuristicSubject(titulo: string): string {
	let s = cleanText(titulo).replace(DATE_CLAUSE, " ");
	for (const re of TRAILING_BOILERPLATE) s = s.replace(re, "");
	for (const re of BOILERPLATE_PREFIXES) {
		const stripped = s.replace(re, "");
		if (stripped !== s) {
			s = stripped;
			break;
		}
	}
	s = s
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.,;:]+$/, "");
	if (s) s = s.charAt(0).toUpperCase() + s.slice(1);
	return s || cleanText(titulo);
}

/**
 * The short "core" title for a law: a curated popular name, or the
 * heuristic subject, with the rank+number abbreviation appended in
 * parentheses when both are present and it still fits within `maxCore`
 * (leaves room for `composeSeoTitle`'s " — Ley Abierta" suffix and the
 * hard cap). Never includes the site suffix — that's `composeSeoTitle`'s
 * job, applied once at the page level.
 */
export function shortLawTitle(
	law: { id: string; titulo: string; rango: string },
	maxCore: number = SEO_TITLE_MAX,
): string {
	const subject = POPULAR_LAW_NAMES[law.id] ?? heuristicSubject(law.titulo);
	const abbrev = lawAbbreviation(law.rango, law.titulo);
	const withAbbrev = abbrev ? `${subject} (${abbrev})` : subject;

	if (codePointLength(withAbbrev) <= maxCore) return withAbbrev;
	// Abbreviation alone doesn't push it over budget in practice (short), but
	// if the subject is long, drop the abbreviation before truncating a name.
	if (abbrev && codePointLength(subject) <= maxCore) return subject;
	return truncateSubject(subject, maxCore);
}

/**
 * Compose the final `<title>` from a short core title: append
 * `SEO_TITLE_SUFFIX` when it fits within `max`, otherwise return the core
 * title alone (never truncate the law's name to make room for the brand
 * suffix).
 */
export function composeSeoTitle(
	core: string,
	max: number = SEO_TITLE_MAX,
	suffix: string = SEO_TITLE_SUFFIX,
): string {
	const clean = cleanText(core);
	const withSuffix = `${clean}${suffix}`;
	if (codePointLength(withSuffix) <= max) return withSuffix;
	if (codePointLength(clean) <= max) return clean;
	return truncateSubject(clean, max);
}

/** The full `<title>` for a law ficha page, in one call. */
export function seoLawPageTitle(law: {
	id: string;
	titulo: string;
	rango: string;
}): string {
	return composeSeoTitle(shortLawTitle(law));
}
