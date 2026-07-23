/**
 * Norm reference parsing — issue #128.
 *
 * BM25 falls apart on the way people actually cite a law: "Real Decreto
 * 1312/2024" dilutes the discriminating token (the number) between two
 * hyper-frequent words ("real", "decreto"), so it loses to unrelated norms
 * whose title happens to contain "real decreto" plus some other number.
 *
 * This module is a pure parser: given a raw search query, detect whether it
 * looks like a citation of a specific norm (BOE/regional bulletin ID, ELI
 * URL, "<rango> <num>/<año>", "Orden <SIGLA>/<num>/<año>", a bare "<num>/<año>",
 * or a well-known acronym) and return a typed, normalized description of it.
 *
 * It does NOT touch the database — `db.ts` uses the result to do an exact,
 * indexed lookup (mainly against `norms.short_title`, which already stores
 * the canonical reference for ~85% of norms) before falling back to BM25/
 * hybrid ranking.
 */

import type { Rank } from "@leyabierta/pipeline";

/** The four things a query can resolve to. */
export type NormReferenceMatch =
	| { kind: "id"; id: string }
	| { kind: "eli"; urls: string[] }
	| { kind: "alias"; id: string }
	| { kind: "ranked"; rank: Rank; shortTitle: string }
	| { kind: "number_year"; number: string; year: string }
	| { kind: "id_suffix"; sequence: string };

/** Existing norm-ID fast path pattern (BOE-A-2024-26931, BORM-s-2026-90179, …). */
const NORM_ID_RE = /^[A-Z]+-[A-Z]+-\d{4}-\d+$/i;

/** ELI URL, e.g. https://www.boe.es/eli/es/rd/2024/12/23/1312 */
const ELI_RE =
	/\/eli\/[a-z0-9-]+\/[a-z0-9-]+\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+/i;

/** Bare "<num>/<año>" — the whole (trimmed) query, nothing else. */
const NUMBER_YEAR_RE = /^(\d{1,5})\s*\/\s*(\d{4})$/;

/**
 * Bare BOE sequence number — 3 to 6 digits, the whole query. Shorter runs
 * (1-2 digits) are far too ambiguous to be worth a fast path.
 */
const BARE_SEQUENCE_RE = /^(\d{3,6})$/;

/**
 * Ministerial order: "Orden HAP/1370/2014", "Orden ETU/615/2017",
 * optionally "Orden Ministerial …". Ministry sigla is 2-6 letters.
 */
const ORDEN_PREFIX_RE =
	/^orden(?:\s+ministerial)?\s+([a-z]{2,6})\s*\/\s*(\d{1,6})\s*\/\s*(\d{4})\b/;

/**
 * Well-known law acronyms → norm id. Each entry was verified against the
 * production database (exact id + short_title/title match) before being
 * hardcoded — see PR description for the queries used. An alias pointing at
 * the wrong norm is worse than no alias, so keep this list conservative.
 */
export const NORM_ALIASES: Record<string, string> = {
	LAU: "BOE-A-1994-26003", // Ley 29/1994, de Arrendamientos Urbanos
	LEC: "BOE-A-2000-323", // Ley 1/2000, de Enjuiciamiento Civil
	LECRIM: "BOE-A-1882-6036", // RD de 14 sept 1882, aprueba la Ley de Enjuiciamiento Criminal
	ET: "BOE-A-2015-11430", // RD Legislativo 2/2015, texto refundido Estatuto de los Trabajadores
	LGSS: "BOE-A-2015-11724", // RD Legislativo 8/2015, texto refundido Ley General de la Seguridad Social
	LOPDGDD: "BOE-A-2018-16673", // LO 3/2018, Protección de Datos Personales y garantía de derechos digitales
	LPACAP: "BOE-A-2015-10565", // Ley 39/2015, Procedimiento Administrativo Común
	LRJSP: "BOE-A-2015-10566", // Ley 40/2015, Régimen Jurídico del Sector Público
	CE: "BOE-A-1978-31229", // Constitución Española
	CC: "BOE-A-1889-4763", // Código Civil
	CP: "BOE-A-1995-25444", // LO 10/1995, Código Penal
};

/**
 * Ordered (longest/most-specific first) list of rango aliases. Matched
 * against a normalized query (lowercase, accents stripped, hyphens folded
 * to spaces, periods removed, whitespace collapsed) so "R.D.", "Real
 * Decreto-ley" and "real decreto ley" all converge to the same lookup.
 *
 * `prefix` is the exact string norms.short_title uses for this rango — see
 * extractShortTitle() in packages/pipeline/src/spain/boe-metadata.ts, the
 * source of truth for how short_title is built at ingest.
 */
const RANGO_ALIASES: Array<{ token: string; rank: Rank; prefix: string }> = [
	{
		token: "real decreto legislativo",
		rank: "real_decreto_legislativo",
		prefix: "Real Decreto Legislativo",
	},
	{
		token: "rdleg",
		rank: "real_decreto_legislativo",
		prefix: "Real Decreto Legislativo",
	},
	{
		token: "real decreto ley",
		rank: "real_decreto_ley",
		prefix: "Real Decreto-ley",
	},
	{ token: "rdl", rank: "real_decreto_ley", prefix: "Real Decreto-ley" },
	{ token: "rd ley", rank: "real_decreto_ley", prefix: "Real Decreto-ley" },
	{ token: "real decreto", rank: "real_decreto", prefix: "Real Decreto" },
	{ token: "rd", rank: "real_decreto", prefix: "Real Decreto" },
	{
		token: "decreto legislativo",
		rank: "decreto",
		prefix: "Decreto Legislativo",
	},
	{ token: "decreto ley", rank: "real_decreto_ley", prefix: "Decreto-ley" },
	{ token: "decreto", rank: "decreto", prefix: "Decreto" },
	{ token: "ley organica", rank: "ley_organica", prefix: "Ley Orgánica" },
	{ token: "lo", rank: "ley_organica", prefix: "Ley Orgánica" },
	{ token: "ley foral", rank: "ley", prefix: "Ley Foral" },
	{ token: "ley", rank: "ley", prefix: "Ley" },
	{ token: "circular", rank: "circular", prefix: "Circular" },
	{ token: "instruccion", rank: "instruccion", prefix: "Instrucción" },
	{
		token: "acuerdo internacional",
		rank: "acuerdo_internacional",
		prefix: "Acuerdo Internacional",
	},
	{ token: "acuerdo", rank: "acuerdo", prefix: "Acuerdo" },
].sort((a, b) => b.token.length - a.token.length);

/**
 * Strip accents, lowercase, drop periods (so "R.D." → "rd"), fold hyphens to
 * spaces (so "Decreto-ley" and "Decreto ley" converge), collapse whitespace.
 */
function normalize(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\./g, "")
		.replace(/[-–]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Parse a raw search query into a norm reference match, or `null` if it
 * doesn't look like one (plain natural-language queries, bare years,
 * single common words like "vivienda" or "real decreto" with no number).
 */
export function parseNormReference(query: string): NormReferenceMatch | null {
	const trimmed = query.trim();
	if (!trimmed) return null;

	// 1. Norm ID (BOE-A-2024-26931, BORM-s-2026-90179, …)
	if (NORM_ID_RE.test(trimmed)) {
		return { kind: "id", id: trimmed.toUpperCase() };
	}

	// 2. ELI URL — accept with/without scheme, http/https, trailing slash.
	const eliMatch = trimmed.match(ELI_RE);
	if (eliMatch) {
		const path = eliMatch[0].replace(/\/$/, "");
		return {
			kind: "eli",
			urls: [`https://www.boe.es${path}`, `http://www.boe.es${path}`, path],
		};
	}

	// 3. Bare number/year — the ENTIRE query, nothing else attached.
	const numberYear = trimmed.match(NUMBER_YEAR_RE);
	if (numberYear) {
		return {
			kind: "number_year",
			number: numberYear[1]!,
			year: numberYear[2]!,
		};
	}

	// 4. Well-known acronym — exact match on the whole (trimmed, uppercased)
	//    query. No partial/substring matching: "LAU" must be the entire
	//    query, not a substring of something else.
	const upper = trimmed.toUpperCase();
	if (Object.hasOwn(NORM_ALIASES, upper)) {
		return { kind: "alias", id: NORM_ALIASES[upper]! };
	}

	const normalized = normalize(trimmed);

	// 5. Ministerial order: "Orden HAP/1370/2014".
	const ordenMatch = normalized.match(ORDEN_PREFIX_RE);
	if (ordenMatch) {
		const ministry = ordenMatch[1]!.toUpperCase();
		const num = ordenMatch[2]!;
		const year = ordenMatch[3]!;
		return {
			kind: "ranked",
			rank: "orden" as Rank,
			shortTitle: `Orden ${ministry}/${num}/${year}`,
		};
	}

	// 6. "<rango> <num>/<año>", tolerating trailing text ("Real Decreto
	//    1312/2024, de 23 de diciembre" — pasting the whole official title).
	for (const { token, rank, prefix } of RANGO_ALIASES) {
		if (normalized === token) continue; // rango alone isn't a reference
		if (!normalized.startsWith(`${token} `)) continue;
		const rest = normalized.slice(token.length).trim();
		const numMatch = rest.match(/^(\d{1,5})\s*\/\s*(\d{4})\b/);
		if (!numMatch) continue;
		return {
			kind: "ranked",
			rank,
			shortTitle: `${prefix} ${numMatch[1]}/${numMatch[2]}`,
		};
	}

	// 7. Bare BOE sequence number ("26931" — the trailing segment of
	//    BOE-A-2024-26931). People paste it after copying half an id, and FTS
	//    can't help: norm_id is UNINDEXED in norms_fts and the digits appear
	//    nowhere in the title, so the query returned ZERO results before this.
	//    Resolved by id suffix; ties (the same sequence reused in different
	//    years, common for regional bulletins) are returned newest-first
	//    rather than dropped.
	const bareSequence = trimmed.match(BARE_SEQUENCE_RE);
	if (bareSequence) {
		const digits = bareSequence[1]!;
		// A 4-digit number in the plausible-year range is a year, not a
		// sequence — "2024" must stay a normal text search.
		const asNumber = Number(digits);
		const looksLikeYear =
			digits.length === 4 && asNumber >= 1800 && asNumber <= 2100;
		if (!looksLikeYear) {
			return { kind: "id_suffix", sequence: digits };
		}
	}

	return null;
}
