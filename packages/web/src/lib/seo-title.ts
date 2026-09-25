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
 * The fix: the disambiguator (rank + own number, or the full BOE/regional id
 * when there is no own number, + jurisdiction when relevant) is now NEVER
 * dropped to make room for the subject — the subject is shortened instead,
 * down to nothing if it must. See `shortLawTitle`.
 * `scripts/check-seo-title-uniqueness.ts` verifies this against the full
 * corpus (not part of `bun test`/CI — the DB isn't available there).
 *
 * Second review (same day): raw ELI codes ("es-pv", "es-md") read as
 * database internals, not something a citizen recognizes — fixed by mapping
 * to the same jurisdiction names the site already shows elsewhere
 * (`JURISDICTION_LABELS` in `law-search.ts`), and skipping the mention
 * entirely when the subject already names the community. And the date+id
 * fallback for number-less norms ("Res 2/7/2021 10959") was replaced with
 * the plain BOE identifier ("BOE-A-2021-10959") — unique, recognizable, and
 * literally what people search for a specific norm by.
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

import { JURISDICTION_LABELS } from "./law-search.ts";
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
 * Lowercased substrings that mean "this subject already names the
 * community" — checked before appending the jurisdiction to the
 * disambiguator (e.g. "Museos de Euskadi (L 7/2006)" doesn't need
 * ", País Vasco" appended; "Museos (L 7/2006)" would). Reuses
 * `JURISDICTION_LABELS`' own names plus a couple of well-known synonyms
 * citizens use (Euskadi, Comunitat Valenciana) — kept short and specific on
 * purpose: a false match here only makes a title *less* explicit, and if it
 * ever caused a real collision, `check-seo-title-uniqueness.ts` catches it.
 */
const JURISDICTION_NAME_ALIASES: Record<string, string[]> = {
	"es-an": ["andalucía"],
	"es-ar": ["aragón"],
	"es-as": ["asturias"],
	"es-cb": ["cantabria"],
	"es-cl": ["castilla y león"],
	"es-cm": ["castilla-la mancha", "castilla la mancha"],
	"es-cn": ["canarias"],
	"es-ct": ["cataluña", "catalunya"],
	"es-ex": ["extremadura"],
	"es-ga": ["galicia"],
	"es-ib": ["illes balears", "islas baleares"],
	"es-mc": ["murcia"],
	"es-md": ["madrid"],
	"es-nc": ["navarra"],
	"es-pv": ["país vasco", "euskadi"],
	"es-ri": ["la rioja"],
	"es-vc": ["comunidad valenciana", "comunitat valenciana"],
};

/**
 * Curated short names for laws citizens commonly search for by name, keyed
 * by BOE/regional id. Only for the handful where a popular short name is
 * clearly better than the heuristic below (e.g. well-known acronyms, or a
 * pre-1900 flagship code with no own number for the heuristic to anchor on)
 * — the heuristic alone must handle the other ~12k laws, and most of these
 * entries exist for clarity/consistency rather than because the heuristic
 * fails. None of these may contain "(" — `shortLawTitle` always appends its
 * own "(disambiguator)"; a curated name with its own parens would read as
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
	// Código Civil (1889, no own number — the heuristic has nothing to anchor on)
	"BOE-A-1889-4763": "Código Civil",
	// Código de Comercio (1885, same reason)
	"BOE-A-1885-6627": "Código de Comercio",
	// Ley Hipotecaria (1946, same reason)
	"BOE-A-1946-2453": "Ley Hipotecaria",
	// Ley Concursal (RDLeg 1/2020) — "el texto refundido de la Ley Concursal"
	// has no del/de la/sobre connector for the heuristic to strip cleanly
	"BOE-A-2020-4859": "Ley Concursal",
	// Constitución Española — no own number (curated so `shortLawTitle` can
	// drop the id disambiguator below: the name is unique on its own)
	"BOE-A-1978-31229": "Constitución Española",
};
if (Object.values(POPULAR_LAW_NAMES).some((name) => name.includes("("))) {
	throw new Error(
		"POPULAR_LAW_NAMES entries must not contain '(' — shortLawTitle always appends its own disambiguator in parens",
	);
}
{
	const names = Object.values(POPULAR_LAW_NAMES);
	const dupe = names.find((name, i) => names.indexOf(name) !== i);
	if (dupe) {
		throw new Error(
			`POPULAR_LAW_NAMES has a duplicate value ("${dupe}") — shortLawTitle drops the id disambiguator for curated names with no own number, so two ids sharing one curated name would collide`,
		);
	}
}

const MONTH_NAME =
	"enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre";

/**
 * ", de 23 de octubre," / "de 23 de octubre" / ", de 5 de diciembre de
 * 2018," → removed. Both the leading and trailing comma are optional: pre-
 * 2000 BOE titles routinely have neither ("Real Decreto de 24 de julio de
 * 1889 por el que se publica el Código Civil", "Orden de 18 de junio de
 * 1998 por la que…") — requiring a trailing comma left 551 such titles
 * completely unstripped (#211 second review). Global: some titles embed
 * several such clauses (e.g. a law amending several other dated laws in one
 * sentence), and only removing the first would leave the rest to eat into
 * the truncation budget — or, worse, read as the norm's own second date.
 */
const DATE_CLAUSE = new RegExp(
	`,?\\s*de\\s+\\d{1,2}\\s+de\\s+(?:${MONTH_NAME})(?:\\s+de\\s+\\d{4})?\\s*,?`,
	"gi",
);

/** A "DD de MES[ de AAAA]" phrase, for the corpus check's "no two dates left
 * in one title" assertion (a second match means `DATE_CLAUSE` missed one). */
export const DATE_PHRASE = new RegExp(
	`\\d{1,2}\\s+de\\s+(?:${MONTH_NAME})(?:\\s+de\\s+\\d{4})?`,
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

/**
 * "…de la Comunidad Autónoma de Aragón…" / "…de la Comunidad de Madrid…"
 * appearing mid-subject (not the `TRASPASO` shape, which handles its own):
 * low information once the jurisdiction is already named or implied
 * elsewhere, and one of the largest sources of otherwise-avoidable
 * truncation (#211 second review: 79% of titles ended in "…"). Dropped
 * outright — the community is regional context, not the point of the law.
 * The " y " stop must not split "Castilla y León" (it left "…Farmacéutica
 * y León" behind).
 */
const COMUNIDAD_AUTONOMA_ASIDE =
	/\s+de\s+la\s+Comunidad(?:\s+Aut[oó]noma)?\s+de\s+[\p{L}][\p{L}\s'-]*?(?=[,.;]|\s+(?:en|para|y(?!\s+Le[oó]n\b))\s|$)/giu;

/**
 * "Orden ECC/1251/2012 por la que se…" — a ministerial code (uppercase
 * letters) before the number. Deliberately case-SENSITIVE and separate from
 * `BOILERPLATE_PREFIXES` (which is case-insensitive throughout): under `/i`,
 * `[A-Z]` also matches lowercase, so folding this into that shared list would
 * make the "code" part match any run of letters at all — silently eating the
 * entire rest of the subject. Applied first: without it, the rank word was
 * either left completely unstripped (letters break the plain-digits `\d./`
 * match in the mandatory-number form) or, once the number became optional,
 * stripped alone and left the bare code dangling ("ECC/1251/2012 por la que
 * se…", #211 second review).
 */
const MINISTERIAL_CODE_PREFIX =
	/^(?:Orden|Resoluci[oó]n|Circular|Instrucci[oó]n)\s+[A-ZÁÉÍÓÚÑ]{2,6}\/\d+\/\d{4}\s*/;

/** The rank words BOE titles start with (same list `RANK_ABBREVS` covers). */
const RANK_WORDS =
	"ley\\s+org[aá]nica|ley|real\\s+decreto\\s+legislativo|real\\s+decreto[- ]ley|real\\s+decreto|decreto[- ]ley|decreto|orden|resoluci[oó]n|instrucci[oó]n|reglamento|acuerdo|circular";

/**
 * Strips JUST the bare leading rank word, with no attempt at the number or a
 * following connector — those are handled separately (see
 * `BOILERPLATE_PREFIXES`'s number+connector entry below) precisely because
 * they mean different things depending on whether a number follows. Always
 * applied, whether or not the title has its own number: for a numbered
 * title ("Ley 27/2014 del Impuesto…" → "27/2014 del Impuesto…") the number
 * stage below immediately continues the strip; for a numberless one issued
 * by an office ("Resolución de la Dirección General de X, sobre Y" → "de la
 * Dirección General de X, sobre Y") it deliberately does NOT also eat the
 * "de la" that follows — that's the issuing body, not the subject, and
 * `extractIntroClause`'s comma-anchored match reaches the real content ("Y")
 * instead. Folding this into a single "rank + optional number + optional
 * connector" pattern (an earlier version of this fix) got that wrong: for
 * numberless resoluciones/órdenes it greedily swallowed "de la <issuing
 * body>" as if it were the connector into the subject, and the truncated
 * head went back to being the issuing body instead of the content (#211
 * second review).
 */
const RANK_WORD_ONLY = new RegExp(`^(?:${RANK_WORDS})\\s+`, "i");

// Applied in order — first match wins. Each strips a BOE boilerplate prefix
// down to the law's subject.
const BOILERPLATE_PREFIXES = [
	// "…por el que se aprueba/publica el texto refundido de la Ley [del/de la/sobre] X" → "X"
	/^.*?\bpor\s+el\s+que\s+se\s+(?:aprueba|publica)\s+el\s+texto\s+refundido\s+de\s+la\s+ley\s+(?:del?\s+|de\s+la\s+|de\s+los\s+|de\s+las\s+|sobre\s+)?/i,
	// "…por el que se aprueba/publica el/la/los/las X" (regulations, not a "Ley") → "X"
	/^.*?\bpor\s+el\s+que\s+se\s+(?:aprueban?|publican?)\s+(?:el|la|los|las)\s+/i,
	// The norm's own number (already at the start — `RANK_WORD_ONLY` ran
	// first) + an optional [del/de la/sobre] connector → "X". Mandatory
	// number, on purpose: this is what tells "Ley 27/2014 del Impuesto…"
	// (connector introduces the subject) apart from "de la Dirección
	// General…" on a numberless resolución (connector introduces the
	// issuing body, left to `extractIntroClause` — see `RANK_WORD_ONLY`).
	/^[\d./]+\s*(?:del?\s+|de\s+la\s+|de\s+los\s+|de\s+las\s+|sobre\s+)?/,
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
const CONTENT_INTRO_INLINE =
	/,\s*(sobre|relativa?\s+a|por\s+(?:el|la|los|las)\s+que\s+se)\s+(.+)$/is;
const CONTENT_INTRO_LEADING =
	/^(sobre|relativa?\s+a|por\s+(?:el|la|los|las)\s+que\s+se)\s+(.+)$/is;

/**
 * A conjugated verb clause is a fine SUBJECT ("por la que se establece X")
 * but a terrible short TITLE ("Establece X" reads like a fragment, no
 * subject — #211 third review). "sobre X" / "relativa a X" always introduce
 * a noun phrase (Spanish prepositions never take a verb), so those are
 * always safe to drop outright. "por que se X" always introduces a VERB
 * clause, so X's leading word is nominalized via `VERB_NOMINALIZATION` —
 * "regula Y" → "Regulación de Y", "establece Y" → "Y" (verb dropped, object
 * kept) — or, for a verb the table doesn't cover, the whole "por la/el que
 * se X" clause is kept AS IS rather than leaving a bare conjugated verb.
 * `null` = drop the verb, keep only the object. A string = the nominal noun
 * phrase to prepend to the object ("Y" → "<nominal> Y").
 * Built from the corpus: the first-word distribution of `heuristicSubject`
 * output over all ~12k norms, every verb-like word with ≥20 occurrences
 * (`bun run packages/web/scripts/check-seo-title-uniqueness.ts` reports the
 * current distribution), plus a few explicitly requested in review.
 */
export const VERB_NOMINALIZATION: Record<string, string | null> = {
	// Verb consumed entirely, only the object remains.
	establece: null,
	establecen: null,
	aprueba: null,
	aprueban: null,
	adopta: null,
	adoptan: null,
	fija: null,
	fijan: null,
	dicta: null,
	dictan: null,
	publica: null,
	publican: null,
	dispone: null,
	disponen: null,
	// Nominalized: "regula X" → "regulación de X".
	regula: "regulación de",
	regulan: "regulación de",
	// "modifica X" → "modificación de X" — MUST keep: a norm that modifies
	// another must never read as if it *were* the norm it modifies.
	modifica: "modificación de",
	modifican: "modificación de",
	deroga: "derogación de",
	derogan: "derogación de",
	crea: "creación de",
	crean: "creación de",
	desarrolla: "desarrollo de",
	desarrollan: "desarrollo de",
	declara: "declaración de",
	declaran: "declaración de",
	convoca: "convocatoria de",
	convocan: "convocatoria de",
	activa: "activación de",
	activan: "activación de",
	reestructura: "reestructuración de",
	reestructuran: "reestructuración de",
	determina: "determinación de",
	determinan: "determinación de",
	actualiza: "actualización de",
	actualizan: "actualización de",
	autoriza: "autorización de",
	autorizan: "autorización de",
	aplaza: "aplazamiento de",
	aplazan: "aplazamiento de",
	prorroga: "prórroga de",
	prorrogan: "prórroga de",
	suspende: "suspensión de",
	suspenden: "suspensión de",
	amplía: "ampliación de",
	amplian: "ampliación de",
	amplían: "ampliación de",
	// Leftover verbs of the "por que se X" clause after round 4, every one
	// with ≥2 occurrences whose noun reads naturally before the object.
	// Deliberately left out (kept as "Por la que se …"): acuerda, hace, da,
	// emite, procede, registra, incluye, completa, complementa, exceptúa,
	// reforma (also a noun: "Reforma del Estatuto…" must not be flagged) —
	// no noun reads well in front of their usual objects ("hace público…").
	ordena: "ordenación de",
	ordenan: "ordenación de",
	reordena: "reordenación de",
	reordenan: "reordenación de",
	delimita: "delimitación de",
	delimitan: "delimitación de",
	constituye: "constitución de",
	constituyen: "constitución de",
	reconoce: "reconocimiento de",
	reconocen: "reconocimiento de",
	designa: "designación de",
	designan: "designación de",
	adapta: "adaptación de",
	adaptan: "adaptación de",
	adecua: "adecuación de",
	adecuan: "adecuación de",
	reduce: "reducción de",
	reducen: "reducción de",
	delega: "delegación de",
	delegan: "delegación de",
	define: "definición de",
	definen: "definición de",
	reorganiza: "reorganización de",
	reorganizan: "reorganización de",
	organiza: "organización de",
	organizan: "organización de",
	revisa: "revisión de",
	revisan: "revisión de",
	incorpora: "incorporación de",
	incorporan: "incorporación de",
	integra: "integración de",
	integran: "integración de",
	suprime: "supresión de",
	suprimen: "supresión de",
	reglamenta: "reglamentación de",
	reglamentan: "reglamentación de",
	habilita: "habilitación de",
	habilitan: "habilitación de",
	extiende: "extensión de",
	extienden: "extensión de",
	especifica: "especificación de",
	especifican: "especificación de",
	articula: "articulación de",
	articulan: "articulación de",
	restablece: "restablecimiento de",
	restablecen: "restablecimiento de",
	extingue: "extinción de",
	extinguen: "extinción de",
	concreta: "concreción de",
	concretan: "concreción de",
	concede: "concesión de",
	conceden: "concesión de",
	aclara: "aclaración de",
	aclaran: "aclaración de",
	transpone: "transposición de",
	transponen: "transposición de",
	refunde: "refundición de",
	refunden: "refundición de",
	recupera: "recuperación de",
	recuperan: "recuperación de",
	promueve: "promoción de",
	promueven: "promoción de",
	normaliza: "normalización de",
	normalizan: "normalización de",
	implanta: "implantación de",
	implantan: "implantación de",
	homologa: "homologación de",
	homologan: "homologación de",
	flexibiliza: "flexibilización de",
	flexibilizan: "flexibilización de",
	eleva: "elevación de",
	elevan: "elevación de",
	convalida: "convalidación de",
	convalidan: "convalidación de",
	califica: "calificación de",
	califican: "calificación de",
	atribuye: "atribución de",
	atribuyen: "atribución de",
	aplica: "aplicación de",
	aplican: "aplicación de",
	garantiza: "garantía de",
	garantizan: "garantía de",
	prohíbe: "prohibición de",
	prohibe: "prohibición de",
	prohíben: "prohibición de",
	prohiben: "prohibición de",
};

/** "regula la asignación de recursos…" → "regulación de la asignación de
 * recursos…"; "establece medidas…" → "medidas…"; an unrecognized verb (not
 * in `VERB_NOMINALIZATION`) → `${intro} ${tail}` unchanged, so the clause
 * reads as "Por la que se fomenta…" rather than a bare "Fomenta…". */
/** "regulación de" + "el Observatorio…" → "regulación del Observatorio…"
 * (never the ungrammatical "de el Observatorio…" — Spanish always contracts
 * "de" + "el" to "del"). */
function joinNominal(nominal: string, rest: string): string {
	if (/^el\s+/i.test(rest)) {
		return `${nominal.replace(/\s+de$/i, " del")} ${rest.replace(/^el\s+/i, "")}`;
	}
	return `${nominal} ${rest}`;
}

/**
 * An object that starts with a preposition or an "-mente" adverb can't follow
 * a nominalization ("desarrolla parcialmente la Ley…" → "Desarrollo de
 * parcialmente…", "incorpora al ordenamiento…" → "Incorporación de al…") nor
 * stand on its own once the verb is dropped ("establecen para los lagomorfos
 * medidas…" → "Para los lagomorfos medidas…"): the clause is kept as is.
 * "con carácter urgente…" is the exception: `LEADING_FILLER` drops it.
 */
const NON_NOMINAL_OBJECT_START =
	/^(?:a|al|como|en|con(?!\s+car[aá]cter\b)|para|por|entre|sobre|desde|hasta|mediante|durante|sin|bajo|tras|ante|hacia|seg[uú]n|contra|\p{L}+mente)(?:\s|$)/iu;

function resolveVerbClause(intro: string, tail: string): string {
	const m = tail.match(/^(\p{L}+)((?:\s+.+)?)$/su);
	if (!m) return `${intro} ${tail}`;
	const verb = m[1]!.toLowerCase();
	const rest = (m[2] ?? "").trim();
	if (!(verb in VERB_NOMINALIZATION)) return `${intro} ${tail}`;
	if (NON_NOMINAL_OBJECT_START.test(rest)) return `${intro} ${tail}`;
	const nominal = VERB_NOMINALIZATION[verb];
	if (nominal === null) return rest || `${intro} ${tail}`;
	return rest ? joinNominal(nominal, rest) : `${intro} ${tail}`;
}

/**
 * Finds and resolves the FIRST "sobre X" / "relativa a X" / "por que se X"
 * clause in `text` — comma-anchored (searches anywhere) or, with
 * `leading: true`, only at the very start (no comma needed: the clause is
 * already the entire remaining string). Returns `undefined` when there's no
 * such clause at all.
 */
function extractIntroClause(text: string, leading = false): string | undefined {
	const m = text.match(leading ? CONTENT_INTRO_LEADING : CONTENT_INTRO_INLINE);
	if (!m) return undefined;
	const intro = m[1]!;
	const tail = m[2]!;
	return /^por/i.test(intro) ? resolveVerbClause(intro, tail) : tail;
}

/**
 * A subject starting with a bare preposition ("A entidades adscritas a un
 * fondo…", "De la Ley…") reads as a cut-off fragment, not a title — real bug
 * found in review (`BOILERPLATE_PREFIXES`'s number+connector entry can strip
 * just the number, e.g. "Circular 3/2011 a entidades…, sobre aportaciones…"
 * → "a entidades…" instead of reaching the real ", sobre aportaciones…"
 * clause). "para X" and "en materia de X" read as natural title starts
 * (purpose/topic clauses) and are deliberately NOT included here.
 */
export const BARE_PREPOSITION_START =
	/^(?:a|de|con|sin|ante|bajo|desde|hasta|seg[uú]n|tras)\s+/i;

// Leading filler that reads oddly as the first word of a short title and
// carries no meaning on its own — dropped once, only at the very start. A
// bare leading article ("La declaración de…" → "Declaración de…") is the
// same headline convention newspapers use — buys back characters on a
// meaningful share of subjects (#211 second review: 79% of titles truncated
// with "…"). "por la que se…" is NOT here — see `extractIntroClause`, which
// nominalizes or keeps it, but never blindly drops it (#211 third review).
// A single filler word at a time — applied in a loop (see
// `stripLeadingFiller`) rather than one multi-word alternative each, so a
// stray leading preposition on its own ("De Organización y Funcionamiento
// del Defensor del Pueblo…", `RANK_WORD_ONLY` having already dropped
// "Reglamento ") gets caught too, not just the "de la"/"del" combos it
// happens to precede (#211 third review).
// "con carácter definitivo/urgente/extraordinario y urgente/temporal" is an
// adverbial aside BOE titles insert BETWEEN the verb and its real object
// ("aprueba con carácter definitivo el Reglamento…") — without stripping it
// too, `resolveVerbClause`'s "drop the verb, keep the object" left it
// dangling as the new leading fragment ("Con carácter definitivo el
// Reglamento…", #211 third review).
const LEADING_FILLER =
	/^(?:sobre|relativa?\s+a|con\s+car[aá]cter\s+\p{L}+(?:\s+y\s+\p{L}+)?|del?|el|la|los|las)\s+/iu;

/** Repeatedly strips `LEADING_FILLER` until nothing more matches. */
function stripLeadingFiller(text: string): string {
	let out = text;
	let prev: string;
	do {
		prev = out;
		out = out.replace(LEADING_FILLER, "");
	} while (out !== prev);
	return out;
}

// A short connector word right before the ellipsis reads badly ("…de la Ley
// 25/1983, de…") — `truncateAtWordBoundary` only guarantees a word boundary,
// not that the last word is meaningful. Strip these once more before
// settling on the final cut.
const DANGLING_CONNECTOR =
	/\s+(?:de|del|la|el|los|las|y|o|en|a|al|que|para|por|con|su|sus|un|una|unos|unas|se|sobre|desde|hasta|ante)…$/i;

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

/**
 * A handful of BOE titles have a stray space around the number's slash
 * ("Ley 8 /1999, de 27 de abril, de Creación de…") — a source typo, not a
 * different format. Left alone, `\d+\/\d{4}` doesn't match "8 /1999" at all,
 * so the number was silently dropped from both `extractNumber` and the
 * `BOILERPLATE_PREFIXES` rank+number strip, leaving a mangled subject
 * ("/1999 de Creación de…"). Normalized once, up front.
 */
function normalizeSlashSpacing(s: string): string {
	return s
		.replace(/(\d)\s+\/\s*(\d)/g, "$1/$2")
		.replace(/(\d)\/\s+(\d)/g, "$1/$2");
}

/** Extract "2/2015" / "27/2014" (rank+number) from a BOE title, if present
 * and close enough to the start to plausibly be the norm's own number. */
function extractNumber(titulo: string): string | undefined {
	const clean = normalizeSlashSpacing(cleanText(titulo));
	const m = clean.match(/(\d+\/\d{4})/);
	if (!m || m.index === undefined || m.index > OWN_NUMBER_WINDOW) {
		return undefined;
	}
	return m[1];
}

/**
 * Whether `subject` already names the jurisdiction's community — checked
 * before appending it to the disambiguator (see `JURISDICTION_NAME_ALIASES`).
 */
function subjectNamesJurisdiction(
	subject: string,
	jurisdiccion: string,
): boolean {
	const aliases = JURISDICTION_NAME_ALIASES[jurisdiccion];
	if (!aliases) return false;
	const lower = subject.toLowerCase();
	return aliases.some((alias) => lower.includes(alias));
}

/**
 * The disambiguator: rank + the norm's own number (never dropped by
 * `shortLawTitle` to make room for the subject — see module docs), plus the
 * jurisdiction's name when it's not "es" and the subject doesn't already
 * name it — every autonomous community numbers its own laws independently
 * (Murcia's "Ley 4/2022" and Aragón's "Ley 4/2022" are unrelated — 810
 * colliding rank+number keys across 3,894 norms in the corpus before the
 * jurisdiction was added, #211 review).
 *
 * When the title carries no number close to its start (most resoluciones/
 * órdenes: they are identified by date, not by a N/AAAA number), the full
 * BOE/regional id is used instead — unique by construction (it's the DB
 * primary key), recognizable, and literally what a citizen searches for a
 * specific norm ("BOE-A-2021-10959"), unlike a bare rank+date+id-fragment.
 */
export function lawAbbreviation(
	rango: string,
	titulo: string,
	id: string,
	subject: string,
	jurisdiccion?: string,
): string {
	const number = extractNumber(titulo);
	if (!number) return id;

	const abbrev = RANK_ABBREVS[rango] ?? DEFAULT_RANK_ABBREV;
	const base = `${abbrev} ${number}`;
	if (!jurisdiccion || jurisdiccion === "es") return base;
	if (subjectNamesJurisdiction(subject, jurisdiccion)) return base;
	const label = JURISDICTION_LABELS[jurisdiccion] ?? jurisdiccion;
	return `${base}, ${label}`;
}

/**
 * Heuristic subject extraction from a BOE title: strip the date clause, any
 * parenthetical aside (never left in — it would collide with the
 * disambiguator's own parens), the "traspaso de funciones…" pattern (see
 * `TRASPASO`), a mid-subject "de la Comunidad Autónoma de X" aside (see
 * `COMUNIDAD_AUTONOMA_ASIDE`), the "por el que se aprueba/publica…" /
 * rank+number boilerplate down to the subject (or, failing that, the
 * "por el/la que se…" tail — see `extractIntroClause`), and trailing "y otras
 * leyes complementarias". Titles with none of that boilerplate (e.g.
 * "Constitución Española", "Código Civil") are returned unchanged.
 */
export function heuristicSubject(titulo: string): string {
	let s = normalizeSlashSpacing(cleanText(titulo))
		.replace(DATE_CLAUSE, " ")
		.replace(/\s*\([^()]*\)/g, " ")
		.replace(MINISTERIAL_CODE_PREFIX, "")
		.replace(RANK_WORD_ONLY, "");
	for (const re of TRAILING_BOILERPLATE) s = s.replace(re, "");

	const traspaso = s.match(TRASPASO);
	if (traspaso) {
		const community = traspaso[1]!.trim();
		const materia = traspaso[2]?.trim();
		s = materia
			? `Traspaso a ${community}: ${materia}`
			: `Traspaso a ${community}`;
	} else {
		s = s.replace(COMUNIDAD_AUTONOMA_ASIDE, "");
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
			const rescued = extractIntroClause(s);
			if (rescued !== undefined) s = rescued;
		}
	}

	// Rescue: `BOILERPLATE_PREFIXES`' number+connector entry can strip just
	// the number and leave a bare-preposition fragment ("a entidades…") when
	// no connector followed — the real content is a later ", sobre…" clause.
	if (BARE_PREPOSITION_START.test(s)) {
		const rescued = extractIntroClause(s);
		if (rescued !== undefined) s = rescued;
	}

	// A "sobre X" / "relativa a X" / "por que se X" clause directly at the
	// start (no comma before it — e.g. `RANK_WORD_ONLY` left "por la que se
	// X" as the entire remaining string): same resolution as the inline case.
	const leadingClause = extractIntroClause(s, true);
	if (leadingClause !== undefined) s = leadingClause;

	s = stripLeadingFiller(s);
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
	},
	maxCore: number = SEO_TITLE_MAX,
): string {
	const curatedName = POPULAR_LAW_NAMES[law.id];
	const subject = curatedName ?? heuristicSubject(law.titulo);

	// A curated name is unique by construction (guarded by the duplicate-value
	// check above) — when the norm also has no own number, the disambiguator
	// would just be its bare id ("Constitución Española (BOE-A-1978-31229)"),
	// which adds nothing a citizen would search for. Dropped in that case
	// only; a curated law WITH a number (Estatuto de los Trabajadores,
	// LOPDGDD…) keeps it — people do search by number (#211 third review).
	if (curatedName && extractNumber(law.titulo) === undefined) {
		return codePointLength(subject) <= maxCore
			? subject
			: truncateSubject(subject, maxCore);
	}

	const disambig = lawAbbreviation(
		law.rango,
		law.titulo,
		law.id,
		subject,
		law.jurisdiccion,
	);

	const suffix = ` (${disambig})`;
	const suffixLen = codePointLength(suffix);
	if (suffixLen >= maxCore) {
		// Pathological (unreachable with real ranks/numbers/jurisdiction names):
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
}): string {
	return composeSeoTitle(shortLawTitle(law));
}
