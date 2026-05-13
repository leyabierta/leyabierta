/**
 * Reusable citation mapper: converts raw Spanish legal citation strings
 * (e.g. "Ley 35/2006, Art. 7") into canonical BOE-A-YYYY-NNNN identifiers
 * by matching against the local norms DB.
 *
 * Deliberately has no file I/O so it can be tested in isolation.
 */

import type { Database } from "bun:sqlite";

export interface MapperOptions {
	db: Database;
}

export interface CitationMatch {
	raw: string; // verbatim input
	boe_a_id: string | null; // BOE-A-YYYY-NNNN or null if not resolved
	confidence: "exact" | "fuzzy" | "ambiguous" | "none";
	candidates?: string[]; // when ambiguous: all candidate IDs
	reason?: string; // when none: why matching failed
}

// ---------------------------------------------------------------------------
// Alias dictionary — top common acronyms / popular-name references
// Built from corpus frequency analysis of dgt+divorce+refugiados+sinai JSONL
// ---------------------------------------------------------------------------
const ALIASES: Record<string, string> = {
	// Tax
	LIRPF: "BOE-A-2006-20764", // Ley 35/2006 IRPF
	LIVA: "BOE-A-1992-28740", // Ley 37/1992 IVA
	LGT: "BOE-A-2003-23186", // Ley 58/2003 General Tributaria
	// Labour
	ET: "BOE-A-2015-11430", // RDLeg 2/2015 Estatuto de los Trabajadores
	"Estatuto de los Trabajadores": "BOE-A-2015-11430",
	// Constitution
	CE: "BOE-A-1978-31229",
	Constitución: "BOE-A-1978-31229",
	"Constitución Española": "BOE-A-1978-31229",
	"Constitucion Española": "BOE-A-1978-31229",
	"Constitucion Espanola": "BOE-A-1978-31229",
};

// ---------------------------------------------------------------------------
// Pattern → (kind, DB rank) pairs
// Ordered most-specific → least-specific to avoid premature matching.
// ---------------------------------------------------------------------------
interface LawRef {
	kind: string;
	dbRank: string; // value used in norms.rank column for disambiguation
	number: string;
	year: string; // 4-digit, already normalised
	raw: string;
}

const PATTERNS: Array<{
	kind: string;
	dbRank: string;
	re: RegExp;
}> = [
	{
		kind: "Ley Orgánica",
		dbRank: "ley_organica",
		re: /(?:Ley\s+Org[áa]nica|L\.?\s*O\.?|LO)\.?\s+(\d[\d.,]*)\/((?:19|20)\d{2}|\d{2})/gi,
	},
	{
		kind: "Real Decreto Legislativo",
		dbRank: "real_decreto_legislativo",
		re: /(?:Real\s+Decreto\s+Legislativo|R\.?D\.?\s*Leg(?:islativo)?\.?|RD\s*Leg|RDLeg)\.?\s+(\d[\d.,]*)\/((?:19|20)\d{2}|\d{2})/gi,
	},
	{
		kind: "Real Decreto-Ley",
		dbRank: "real_decreto_ley",
		re: /(?:Real\s+Decreto-?\s*[Ll]ey|R\.?D\.?-?\s*[Ll]ey|RD-?L|RDL)\.?\s+(\d[\d.,]*)\/((?:19|20)\d{2}|\d{2})/gi,
	},
	{
		kind: "Real Decreto",
		dbRank: "real_decreto",
		re: /(?:Real\s+Decreto|R\.?D\.?)\.?\s+(\d[\d.,]*)\/((?:19|20)\d{2}|\d{2})/gi,
	},
	{
		kind: "Ley Foral",
		dbRank: "ley",
		re: /Ley\s+Foral\s+(\d[\d.,]*)\/((?:19|20)\d{2}|\d{2})/gi,
	},
	{
		kind: "Ley",
		dbRank: "ley",
		re: /Ley\s+(\d[\d.,]*)\/((?:19|20)\d{2}|\d{2})/gi,
	},
	{
		kind: "Decreto",
		dbRank: "decreto",
		re: /Decreto\s+(\d[\d.,]*)\/((?:19|20)\d{2}|\d{2})/gi,
	},
];

/**
 * Normalise a 2-digit year suffix to 4-digit.
 * "92" → 1992, "99" → 1999, "00"–"30" → 2000-2030
 */
function expandYear(y: string): string {
	if (y.length === 4) return y;
	const n = parseInt(y, 10);
	return n > 30 ? `19${y.padStart(2, "0")}` : `20${y.padStart(2, "0")}`;
}

/**
 * Remove thousands separator from number strings ("1.398" → "1398").
 */
function cleanNumber(n: string): string {
	return n.replace(/\./g, "").replace(/,/g, "");
}

function extractLawRefs(text: string): LawRef[] {
	// Normalise whitespace noise (newlines, non-breaking spaces)
	const normalised = text.replace(/[\n\r\t  ]+/g, " ");
	const refs: LawRef[] = [];
	// Track claimed spans to avoid duplicate/overlapping matches from less-specific patterns
	const claimed: Array<[number, number]> = [];

	for (const { kind, dbRank, re } of PATTERNS) {
		re.lastIndex = 0;
		for (const m of normalised.matchAll(re)) {
			const start = m.index!;
			const end = start + m[0].length;
			// Check overlap with already-claimed spans
			const overlaps = claimed.some(([cs, ce]) => start < ce && end > cs);
			if (overlaps) continue;
			claimed.push([start, end]);
			refs.push({
				kind,
				dbRank,
				number: cleanNumber(m[1]!),
				year: expandYear(m[2]!),
				raw: m[0],
			});
		}
	}
	return refs;
}

// ---------------------------------------------------------------------------
// DB lookup helpers
// ---------------------------------------------------------------------------

interface NormRow {
	id: string;
	status: string;
	rank: string;
	title: string;
}

/** Map from internal kind labels to title prefixes as they appear in the DB. */
const KIND_TO_DB_PREFIX: Record<string, string[]> = {
	"Real Decreto-Ley": ["Real Decreto-ley", "Real Decreto-Ley"],
	"Real Decreto Legislativo": ["Real Decreto Legislativo"],
	"Real Decreto": ["Real Decreto"],
	"Ley Orgánica": ["Ley Orgánica"],
	"Ley Foral": ["Ley Foral"],
	Ley: ["Ley"],
	Decreto: ["Decreto"],
};

function lookupByTitlePrefix(
	db: Database,
	kindLabel: string,
	number: string,
	year: string,
	_rank: string,
): NormRow[] {
	const prefixes = KIND_TO_DB_PREFIX[kindLabel] ?? [kindLabel];
	const rows: NormRow[] = [];
	const seen = new Set<string>();

	for (const prefix of prefixes) {
		const pat = `${prefix} ${number}/${year}%`;
		const found = db
			.query<NormRow, [string]>(
				"SELECT id, status, rank, substr(title,1,200) as title FROM norms WHERE title LIKE ? LIMIT 10",
			)
			.all(pat);
		for (const r of found) {
			if (!seen.has(r.id)) {
				seen.add(r.id);
				rows.push(r);
			}
		}
	}

	return rows;
}

function disambiguate(rows: NormRow[], preferredRank: string): NormRow[] {
	if (rows.length <= 1) return rows;
	// Prefer vigente over derogada
	const vigentes = rows.filter((r) => r.status === "vigente");
	const pool = vigentes.length > 0 ? vigentes : rows;
	if (pool.length <= 1) return pool;
	// Prefer matching rank
	const rankMatch = pool.filter((r) => r.rank === preferredRank);
	return rankMatch.length > 0 ? rankMatch : pool;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function mapCitation(raw: string, opts: MapperOptions): CitationMatch {
	const { db } = opts;
	const trimmed = raw.trim();

	// 1. Alias dictionary (exact match after trimming trailing punctuation)
	const stripped = trimmed.replace(/[.,;:]+$/, "").trim();
	if (stripped in ALIASES) {
		return {
			raw,
			boe_a_id: ALIASES[stripped]!,
			confidence: "exact",
		};
	}

	// 2. Regex extraction
	const refs = extractLawRefs(trimmed);
	if (refs.length === 0) {
		return {
			raw,
			boe_a_id: null,
			confidence: "none",
			reason: "no_pattern_matched",
		};
	}

	// Use first extracted ref (citation strings rarely contain more than one law)
	const ref = refs[0]!;
	const rows = lookupByTitlePrefix(
		db,
		ref.kind,
		ref.number,
		ref.year,
		ref.dbRank,
	);

	if (rows.length === 0) {
		// Fallback: try alternate kind label for common abbreviations that resolve
		// differently in the DB (e.g. "Ley Foral" stored as "Ley Foral N/YYYY...")
		return {
			raw,
			boe_a_id: null,
			confidence: "none",
			reason: `no_db_match_for_${ref.kind}_${ref.number}/${ref.year}`,
		};
	}

	const candidates = disambiguate(rows, ref.dbRank);

	if (candidates.length === 1) {
		const winner = candidates[0]!;
		// Exact = single match with correct rank. Fuzzy = single match but rank differs.
		const confidence = winner.rank === ref.dbRank ? "exact" : "fuzzy";
		return {
			raw,
			boe_a_id: winner.id,
			confidence,
		};
	}

	// Multiple candidates even after disambiguation → ambiguous
	return {
		raw,
		boe_a_id: candidates[0]!.id, // best guess: first vigente
		confidence: "ambiguous",
		candidates: candidates.map((r) => r.id),
	};
}

export function mapCitations(
	raws: string[],
	opts: MapperOptions,
): CitationMatch[] {
	return raws.map((r) => mapCitation(r, opts));
}
