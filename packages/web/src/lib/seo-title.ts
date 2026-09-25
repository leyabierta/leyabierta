/**
 * Short, search-friendly, UNIQUE `<title>` for a law page.
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
 * Uniqueness (2026-09-25 review, PR #211): an earlier version of this module
 * dropped the rank+number abbreviation whenever the subject alone didn't
 * leave room for it. Two failure modes fell out of that:
 *   1. Many distinct laws share a generic head ("Traspaso de funciones y
 *      servicios de la Administración del Estado a la Comunidad de…", up to
 *      102 "Resolución de la Dirección General de X, por la que se…" norms)
 *      — with the number dropped and only the head kept, hundreds of
 *      DIFFERENT laws collapsed onto the SAME <title>.
 *   2. Rank+number alone is not corpus-unique either: every jurisdiction
 *      numbers its own "Ley N/AAAA" independently (Murcia's Ley 4/2022 and
 *      Aragón's Ley 4/2022 are unrelated laws) — 810 colliding rank+number
 *      keys / 3,894 norms in the corpus before this fix.
 * The fix: the disambiguator (rank + own number-or-date, + jurisdiction when
 * not "es") is now NEVER dropped to make room for the subject — the subject
 * is shortened instead, down to nothing if it must. See `shortLawTitle`.
 * `scripts/check-seo-title-uniqueness.ts` verifies this against the full
 * corpus (not part of `bun test`/CI — the DB isn't available there).
 *
 * Pipeline: `shortLawTitle` → a curated popular name (a handful of laws
 * people search for by name) or a heuristic strip of the BOE's boilerplate
 * down to the subject — combined with the disambiguator, which is always
 * kept. `composeSeoTitle` then decides whether " — Ley Abierta" fits after
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

/** Same abbreviations used for the ficha page's `alternateName`/description,
 * extended to cover every `rank` value seen in the corpus so every law gets
 * a disambiguator — not just the 8 most common ranks. */
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
	circular: "Circ",
	instruccion: "Instr",
	reglamento: "Regl",
	acuerdo: "Ac",
	acuerdo_internacional: "AI",
	otro: "Norma",
};
/** A `rango` value outside the map above (future BOE rank not yet seen). */
const DEFAULT_RANK_ABBREV = "Norma";

/**
 * Curated short names for laws citizens commonly search for by name, keyed
 * by BOE/regional id. Only for the handful where a popular short name is
 * clearly better than the heuristic below (e.g. well-known acronyms) — the
 * heuristic alone must handle the other ~12k laws, and most of these entries
 * exist for clarity/consistency rather than because the heuristic fails.
 * None of these may contain "(" — `shortLawTitle` always appends its own
 * "(disambiguator)"; a curated name with its own parens would read as
 * "LOPDGDD (protección de datos) (LO 3/2018)" (double parens, #211 review).
 */
export const POPULAR_LAW_NAMES: Record<string, string> = {
	// Estatuto de los Trabajadores (RDLeg 2/2015)
	"BOE-A-2015-11430": "Estatuto de los Trabajadores",
	// Ley General Tributaria (L 58/2003)
	"BOE-A-2003-23186": "Ley General Tributaria",
	// LOPDGDD (LO 3/2018) — well-known by its acronym
	"BOE-A-2018-16673": "LOPDGDD: protección de datos",
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
if (Object.values(POPULAR_LAW_NAMES).some((name) => name.includes("("))) {
	throw new Error(
		"POPULAR_LAW_NAMES entries must not contain '(' — shortLawTitle always appends its own disambiguator in parens",
	);
}

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

/**
 * "Real Decreto 1685/1994 sobre traspaso de funciones y servicios de la
 * Administración del Estado a la Comunidad de Castilla y León en materia de
 * espectáculos" → "Traspaso a Castilla y León: espectáculos". These RDs are
 * the single biggest source of same-head collisions in the corpus (~19 norms
 * transferring the same function to 19 different comunidades) — the number
 * already disambiguates them, but the readable fix is to surface the actual
 * distinguishing part (community + subject) instead of the shared head.
 */
const TRASPASO =
	/traspaso\s+de\s+funciones\s+y\s+servicios\s+(?:de\s+la\s+Administraci[oó]n\s+del\s+Estado|del\s+Estado)\s+a\s+la\s+(?:Comunidad(?:\s+Aut[oó]noma)?|Ciudad\s+Aut[oó]noma)\s+de\s+([^,]+?)(?:\s+en\s+materia\s+de\s+([^,.;]+))?\s*[.,;]?\s*$/i;

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

/**
 * Fallback when none of `BOILERPLATE_PREFIXES` matched: a long issuing-body
 * clause ("Resolución de la Dirección General de X, por la que se…" /
 * "…, sobre Y" / "…, relativa a Z") is much less informative — and much less
 * distinguishing between norms from the same office — than the clause that
 * actually names the content. Strips everything up to and including the
 * first ", sobre " / ", relativa/o a " / "por el/la/los/las que se " it
 * finds, keeping only what varies between norms from the same issuing body
 * (#211 review: up to 102 norms from one Dirección General collapsed onto
 * the same truncated head before this).
 */
const CONTENT_INTRO =
	/^.*?,\s*(?:sobre|relativa?\s+a|por\s+(?:el|la|los|las)\s+que\s+se)\s+/i;

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

/**
 * A number is only trusted as the norm's OWN identifier when it appears near
 * the start of the title: BOE titles put it right after the rank name
 * ("Ley 27/2014, de…", "Orden PCI/881/2019, de…"). A number appearing deep in
 * a long title is almost always someone else's — a referenced Real Decreto,
 * an EU Regulation ("… previsto en el Real Decreto 463/2020 …", "(UE)
 * 2013/2013") — and trusting it produced duplicate rank+number keys for
 * unrelated norms (17 same-jurisdiction collisions found in review, e.g.
 * 13 different COVID-era resoluciones all keyed "Res 463/2020").
 */
const OWN_NUMBER_WINDOW = 45;

/** Extract "2/2015" / "27/2014" (rank+number) from a BOE title, if present
 * and close enough to the start to plausibly be the norm's own number. */
function extractNumber(titulo: string): string | undefined {
	const clean = cleanText(titulo);
	const m = clean.match(/(\d+\/\d{4})/);
	if (!m || m.index === undefined || m.index > OWN_NUMBER_WINDOW) {
		return undefined;
	}
	return m[1];
}

/** "1974-08-07" → "7/8/1974" (day/month/year, no leading zeros). */
function compactDate(iso: string): string | undefined {
	const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (!m) return undefined;
	const [, y, mo, d] = m;
	return `${Number(d)}/${Number(mo)}/${y}`;
}

/**
 * The trailing id segment ("BOE-A-2020-4063" → "4063"), used ONLY as a last-
 * resort tiebreaker for the date-fallback disambiguator (see below): ranks
 * that carry no own N/AAAA number (resoluciones, órdenes with no code, …)
 * are identified by date alone, and several are routinely published on the
 * exact same date (e.g. a batch of same-day órdenes, or a resolución and the
 * one that corrects it two days later re-published under the date it
 * refers to). 36 groups / 93 norms in the corpus still collided on
 * rank+date alone (#211 review) — the id is the one field guaranteed unique
 * per norm (DB primary key), so appending it closes the gap completely.
 */
function idTail(id: string): string {
	const parts = id.split("-").filter(Boolean);
	return parts[parts.length - 1] ?? id;
}

/**
 * The disambiguator: rank + the norm's own number, or — when the title
 * carries no number close to its start (most resoluciones/órdenes: they are
 * identified by date, not by a N/AAAA number) — rank + publication date +
 * the id's trailing segment (see `idTail`; guarantees uniqueness even
 * between same-rank, same-date norms). Jurisdiction is appended when not
 * "es": every autonomous community numbers its own laws independently
 * (Murcia's "Ley 4/2022" and Aragón's "Ley 4/2022" are unrelated — 810
 * colliding rank+number keys across 3,894 norms in the corpus before this
 * was added, #211 review). This is NEVER dropped by `shortLawTitle` to make
 * room for the subject — see module docs.
 */
export function lawAbbreviation(
	rango: string,
	titulo: string,
	id: string,
	jurisdiccion?: string,
	fechaPublicacion?: string,
): string | undefined {
	const abbrev = RANK_ABBREVS[rango] ?? DEFAULT_RANK_ABBREV;
	const number = extractNumber(titulo);
	const core = number
		? `${abbrev} ${number}`
		: fechaPublicacion
			? mapUndefined(
					compactDate(fechaPublicacion),
					(d) => `${abbrev} ${d} ${idTail(id)}`,
				)
			: undefined;
	if (!core) return undefined;
	return jurisdiccion && jurisdiccion !== "es"
		? `${core} ${jurisdiccion}`
		: core;
}

function mapUndefined<T, U>(v: T | undefined, f: (v: T) => U): U | undefined {
	return v === undefined ? undefined : f(v);
}

/**
 * Heuristic subject extraction from a BOE title: strip the date clause, any
 * parenthetical aside (never left in — it would collide with the
 * disambiguator's own parens), the "traspaso de funciones…" pattern (see
 * `TRASPASO`), the "por el que se aprueba…" / rank+number boilerplate down
 * to the subject (or, failing that, the "por el/la que se…" tail — see
 * `CONTENT_INTRO`), and trailing "y otras leyes complementarias". Titles
 * with none of that boilerplate (e.g. "Constitución Española", "Código
 * Civil") are returned unchanged.
 */
export function heuristicSubject(titulo: string): string {
	let s = cleanText(titulo)
		.replace(DATE_CLAUSE, " ")
		.replace(/\s*\([^()]*\)/g, " ");
	for (const re of TRAILING_BOILERPLATE) s = s.replace(re, "");

	const traspaso = s.match(TRASPASO);
	if (traspaso) {
		const community = traspaso[1]!.trim();
		const materia = traspaso[2]?.trim();
		s = materia
			? `Traspaso a ${community}: ${materia}`
			: `Traspaso a ${community}`;
	} else {
		let matched = false;
		for (const re of BOILERPLATE_PREFIXES) {
			const stripped = s.replace(re, "");
			if (stripped !== s) {
				s = stripped;
				matched = true;
				break;
			}
		}
		if (!matched) {
			const stripped = s.replace(CONTENT_INTRO, "");
			if (stripped !== s) s = stripped;
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
 * heuristic subject, plus the disambiguator (`lawAbbreviation`) in
 * parentheses. The disambiguator is NEVER dropped — it's the only thing
 * that reliably tells two similarly-titled norms apart (see module docs);
 * the subject is shortened, down to nothing if it has to, to make room for
 * it instead. Never includes the site suffix — that's `composeSeoTitle`'s
 * job, applied once at the page level.
 */
export function shortLawTitle(
	law: {
		id: string;
		titulo: string;
		rango: string;
		jurisdiccion?: string;
		fechaPublicacion?: string;
	},
	maxCore: number = SEO_TITLE_MAX,
): string {
	const subject = POPULAR_LAW_NAMES[law.id] ?? heuristicSubject(law.titulo);
	const disambig = lawAbbreviation(
		law.rango,
		law.titulo,
		law.id,
		law.jurisdiccion,
		law.fechaPublicacion,
	);

	if (!disambig) {
		// No number close to the start and no publication date to fall back on
		// — shouldn't happen with real data (every norm has a publication
		// date), but the function must still degrade gracefully.
		return codePointLength(subject) <= maxCore
			? subject
			: truncateSubject(subject, maxCore);
	}

	const suffix = ` (${disambig})`;
	const suffixLen = codePointLength(suffix);
	if (suffixLen >= maxCore) {
		// Pathological (unreachable with real ranks/numbers/jurisdiction codes):
		// even the bare disambiguator doesn't fit the budget. Still never drop
		// it — the budget loses, not the disambiguator.
		return disambig;
	}

	const budget = maxCore - suffixLen;
	const shortSubject =
		codePointLength(subject) <= budget
			? subject
			: truncateSubject(subject, budget);
	return `${shortSubject}${suffix}`;
}

/**
 * Compose the final `<title>` from a short core title: append
 * `SEO_TITLE_SUFFIX` when it fits within `max`, otherwise return the core
 * title alone (never truncate the law's name — and never its disambiguator,
 * see `shortLawTitle` — to make room for the brand suffix).
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
	jurisdiccion?: string;
	fechaPublicacion?: string;
}): string {
	return composeSeoTitle(shortLawTitle(law));
}
