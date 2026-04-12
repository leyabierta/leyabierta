/**
 * Bill Parser — shared types and ordinal constants.
 */

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

export interface Derogation {
	/** Full text of the derogatory provision */
	text: string;
	/** Target law or provision being repealed */
	targetLaw: string;
	/** Whether it's a full or partial derogation */
	scope: "full" | "partial";
	/** Specific provisions being repealed (for partial derogations) */
	targetProvisions: string[];
}

export interface NewEntity {
	/** Name of the entity being created */
	name: string;
	/** Type of entity */
	entityType:
		| "registro"
		| "organo"
		| "procedimiento"
		| "derecho"
		| "sistema"
		| "otro";
	/** Article where it's defined */
	article: string;
	/** Brief description */
	description: string;
}

/** Bill classification based on content */
export type BillType = "new_law" | "amendment" | "mixed";

export interface ParsedBill {
	/** BOCG identifier, e.g., "BOCG-14-A-62-1" */
	bocgId: string;
	/** Bill title from header */
	title: string;
	/** Publication date from header (ISO format) */
	publicationDate: string;
	/** Bill classification based on content */
	billType: BillType;
	/** All modification groups found */
	modificationGroups: ModificationGroup[];
	/** Derogated laws/provisions */
	derogations: Derogation[];
	/** Raw text of each transitional provision */
	transitionalProvisions: string[];
	/** New entities created by the bill's main body */
	newEntities: NewEntity[];
	/** Full cleaned text */
	rawText: string;
}

// ── Ordinal lists ──

/** Lowercase ordinals used inside disposiciones finales (Uno, Dos...) */
export const LOWERCASE_ORDINALS = [
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
export const TITLECASE_ORDINAL_BASES = [
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
export function buildOrdinalPattern(): RegExp {
	const lowercasePart = LOWERCASE_ORDINALS.join("|");
	const titlecasePart = TITLECASE_ORDINAL_BASES.join("|");

	// Match either:
	// - A lowercase ordinal followed by "."
	// - A title-case base followed by 0-3 compound words and "."
	//   Compound words include both title-case and lowercase ordinals
	//   Examples: "Centésimo trigésimo primero", "Ducentésimo cuarto"
	const compoundWords = [
		...LOWERCASE_ORDINALS.map((o) => o.toLowerCase()),
		"primero",
		"segundo",
		"tercero",
		"cuarto",
		"quinto",
		"sexto",
		"séptimo",
		"octavo",
		"noveno",
		"décimo",
		"undécimo",
		"duodécimo",
		"trigésimo",
		"cuadragésimo",
		"quincuagésimo",
		"sexagésimo",
		"septuagésimo",
		"octogésimo",
		"nonagésimo",
		"centésimo",
		"ducentésimo",
	];
	const compoundPart = compoundWords.join("|");
	return new RegExp(
		`(?:^|\\n)((?:${lowercasePart})|(?:(?:${titlecasePart})(?:\\s+(?:${compoundPart}))*))\\.\\s+`,
		"gi",
	);
}
