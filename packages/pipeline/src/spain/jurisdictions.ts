/**
 * Single source of truth for Spanish ELI jurisdiction codes used as folder
 * names in the leyes output repo. Used by:
 *   - GitRepo.writeAndAdd to detect cross-jurisdiction duplicate writes
 *   - assertUniqueByNormId to scan the repo and verify the invariant
 *   - any future code that needs to enumerate or validate jurisdiction folders
 *
 * Add a new entry here (and only here) when introducing a new jurisdiction.
 */

/** Jurisdiction code → human-readable name. */
export const SPAIN_JURISDICTIONS = {
	es: "España (Estado)",
	"es-an": "Andalucía",
	"es-ar": "Aragón",
	"es-as": "Asturias",
	"es-cb": "Cantabria",
	"es-cl": "Castilla y León",
	"es-cm": "Castilla-La Mancha",
	"es-cn": "Canarias",
	"es-ct": "Cataluña",
	"es-ex": "Extremadura",
	"es-ga": "Galicia",
	"es-ib": "Islas Baleares",
	"es-mc": "Región de Murcia",
	"es-md": "Comunidad de Madrid",
	"es-nc": "Navarra",
	"es-pv": "País Vasco",
	"es-ri": "La Rioja",
	"es-vc": "Comunidad Valenciana",
} as const;

export type SpainJurisdiction = keyof typeof SPAIN_JURISDICTIONS;

/** Stable-ordered list of jurisdiction codes. */
export const SPAIN_JURISDICTION_CODES = Object.keys(
	SPAIN_JURISDICTIONS,
) as readonly SpainJurisdiction[];

const JURISDICTION_SET: ReadonlySet<string> = new Set(SPAIN_JURISDICTION_CODES);

/** Type guard: true when `code` is a known Spanish jurisdiction. */
export function isSpainJurisdiction(code: string): code is SpainJurisdiction {
	return JURISDICTION_SET.has(code);
}

/**
 * Parse `<jurisdiction>/<normId>.md` into its components. Returns null when
 * the path does not match the strict shape expected for a norm file:
 *   - first segment must be a known jurisdiction code
 *   - filename must end in `.md`
 *   - no nested directories beyond the jurisdiction folder
 *   - normId must look like a real norm id (`<PREFIX>-…-<YYYY>-<digits>`)
 *
 * Pure string parsing — no anchored regex, no implicit fallbacks. Anything
 * that does not match returns null and is treated as "not a norm file" by
 * callers (e.g. README.md, .gitignore, foo.txt).
 */
export function parseNormPath(
	relPath: string,
): { jurisdiction: SpainJurisdiction; normId: string } | null {
	const slash = relPath.indexOf("/");
	if (slash <= 0) return null;

	const jurisdiction = relPath.slice(0, slash);
	if (!isSpainJurisdiction(jurisdiction)) return null;

	const tail = relPath.slice(slash + 1);
	if (!tail.endsWith(".md")) return null;
	if (tail.includes("/")) return null; // no nested paths

	const normId = tail.slice(0, -3);
	if (!isNormIdShape(normId)) return null;

	return { jurisdiction, normId };
}

/**
 * True when `s` matches the shape `<PREFIX>-…-<YYYY>-<digits>`, where:
 *   - PREFIX is uppercase letters/digits (e.g. BOE, BOA, BOJA, BOPV)
 *   - YYYY is exactly 4 digits
 *   - the trailing segment is one or more digits
 *
 * This rejects filenames like `README`, `config`, or `foo-bar` that happen
 * to live in a jurisdiction folder. We deliberately do not enumerate every
 * known prefix — new bulletins appear over time, and the shape check is
 * tight enough on its own.
 */
function isNormIdShape(s: string): boolean {
	const parts = s.split("-");
	if (parts.length < 3) return false;

	const prefix = parts[0];
	if (!prefix || !isUppercaseAlnum(prefix)) return false;

	const num = parts[parts.length - 1];
	if (!num || !isAllDigits(num)) return false;

	const year = parts[parts.length - 2];
	if (!year || year.length !== 4 || !isAllDigits(year)) return false;

	return true;
}

/** True when every char in `s` is an ASCII digit (0-9), and s is non-empty. */
function isAllDigits(s: string): boolean {
	if (s.length === 0) return false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 48 || c > 57) return false;
	}
	return true;
}

/** True when every char is uppercase A-Z or 0-9, with first char a letter. */
function isUppercaseAlnum(s: string): boolean {
	if (s.length === 0) return false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		const isUpper = c >= 65 && c <= 90;
		const isDigit = c >= 48 && c <= 57;
		if (i === 0 && !isUpper) return false;
		if (!isUpper && !isDigit) return false;
	}
	return true;
}

// ─── Canonical jurisdiction resolution ───
//
// One resolver for every place that needs a norm's jurisdiction: the BOE
// metadata parser (`metadata.country`), the output path (`normToFilepath`),
// the frontmatter and the DB ingest. They used to carry three copies of the
// same "ELI → bulletin prefix → 'es'" logic, and that silent 'es' fallback is
// how BOE-A-2026-10117 (La Rioja) and BOE-A-2026-12186 / BOE-A-2026-13298
// (Asturias) ended up in `es/`: when the pipeline first fetched them the BOE
// had not assigned their ELI yet (`url_eli` missing, `fuente` fell back to
// `act.php?id=…`), and a `BOE-A-…` id has no regional bulletin prefix.

/** Regional bulletin ID prefix → jurisdiction (norms without a BOE id). */
export const BULLETIN_TO_JURISDICTION: Readonly<
	Record<string, SpainJurisdiction>
> = {
	BOA: "es-ar", // Boletín Oficial de Aragón
	BOJA: "es-an", // Boletín Oficial de la Junta de Andalucía
	BOC: "es-cn", // Boletín Oficial de Canarias
	BOCL: "es-cl", // Boletín Oficial de Castilla y León
	BOCM: "es-md", // Boletín Oficial de la Comunidad de Madrid
	BOCT: "es-cb", // Boletín Oficial de Cantabria
	BOIB: "es-ib", // Butlletí Oficial de les Illes Balears
	BON: "es-nc", // Boletín Oficial de Navarra
	BOPV: "es-pv", // Boletín Oficial del País Vasco
	BORM: "es-mc", // Boletín Oficial de la Región de Murcia
	DOCM: "es-cm", // Diario Oficial de Castilla-La Mancha
	DOE: "es-ex", // Diario Oficial de Extremadura
	DOG: "es-ga", // Diario Oficial de Galicia
	DOGC: "es-ct", // Diari Oficial de la Generalitat de Catalunya
	DOGV: "es-vc", // Diari Oficial de la Generalitat Valenciana
};

/**
 * BOE `departamento` of autonomic norms → jurisdiction. Keys are the BOE
 * catalog texts (data/auxiliar/departamentos.json, codes 8010–8170 and 9531),
 * normalized with `normalizeDepartment`. Every autonomic norm in the JSON
 * cache that has an ELI agrees with this table.
 */
const DEPARTMENT_TO_JURISDICTION: ReadonlyMap<string, SpainJurisdiction> =
	new Map(
		(
			[
				["Comunidad Autónoma de Andalucía", "es-an"],
				["Comunidad Autónoma de Aragón", "es-ar"],
				["Comunidad Autónoma de Canarias", "es-cn"],
				["Comunidad Autónoma de Cantabria", "es-cb"],
				["Comunidad Autónoma de Castilla-La Mancha", "es-cm"],
				["Comunidad Autónoma de Cataluña", "es-ct"],
				["Comunidad Autónoma de Extremadura", "es-ex"],
				["Comunidad Autónoma de Galicia", "es-ga"],
				["Comunidad Autónoma de la Región de Murcia", "es-mc"],
				["Comunidad Autónoma de La Rioja", "es-ri"],
				["Comunidad Autónoma de las Islas Baleares", "es-ib"],
				["Comunidad Autónoma de las Illes Balears", "es-ib"],
				["Comunidad de Madrid", "es-md"],
				["Comunidad Autónoma del País Vasco", "es-pv"],
				["Comunidad Autónoma del Principado de Asturias", "es-as"],
				["Comunidad Valenciana", "es-vc"],
				["Comunitat Valenciana", "es-vc"],
				["Comunidad Foral de Navarra", "es-nc"],
				["Comunidad de Castilla y León", "es-cl"],
			] as const
		).map(([dept, j]) => [normalizeDepartment(dept), j]),
	);

/** BOE `ambito.codigo` for autonomic norms ("1" is Estatal). */
export const BOE_AMBITO_AUTONOMICO = "2";

function normalizeDepartment(s: string): string {
	return s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

/** Jurisdiction named by an ELI URL (`…/eli/es-an/…` → es-an), or null. */
export function jurisdictionFromEli(
	url: string | undefined,
): SpainJurisdiction | null {
	const match = url?.match(/\/eli\/(es(?:-[a-z]{2})?)\//);
	if (!match?.[1]) return null;
	if (!isSpainJurisdiction(match[1])) {
		throw new Error(
			`Unknown ELI jurisdiction "${match[1]}" in ${url}. Add it to SPAIN_JURISDICTIONS if it is real.`,
		);
	}
	return match[1];
}

/** Jurisdiction of a regional bulletin id (`BOJA-…` → es-an), or null. */
export function jurisdictionFromBulletin(
	normId: string,
): SpainJurisdiction | null {
	const prefix = normId.split("-")[0] ?? "";
	return BULLETIN_TO_JURISDICTION[prefix] ?? null;
}

/** Autonomous community named by a BOE `departamento`, or null. */
export function jurisdictionFromDepartment(
	department: string | undefined,
): SpainJurisdiction | null {
	if (!department) return null;
	return (
		DEPARTMENT_TO_JURISDICTION.get(normalizeDepartment(department)) ?? null
	);
}

/**
 * True when a `departamento` looks like a regional government even though it
 * is not in the table (a new spelling, Ceuta, Melilla…). Such a norm must not
 * fall back to `es`.
 */
function looksAutonomic(department: string | undefined): boolean {
	if (!department) return false;
	return /^(comunidad|comunitat|ciudad de ceuta|ciudad de melilla)\b/.test(
		normalizeDepartment(department),
	);
}

export interface JurisdictionInput {
	readonly id: string;
	/** ELI URL when the BOE has assigned one (`url_eli` / `metadata.source`). */
	readonly source?: string;
	/** BOE `departamento` text. */
	readonly department?: string;
	/** Previously resolved jurisdiction (`metadata.country`), if any. */
	readonly country?: string;
	/** BOE `ambito.codigo` when known ("2" = autonómico). */
	readonly ambitoCode?: string;
}

/**
 * The canonical jurisdiction of a norm (see CLAUDE.md "Data Integrity
 * Invariants"):
 *   1. ELI URL
 *   2. regional bulletin id prefix
 *   3. autonomic `departamento` (covers BOE-A ids published before the BOE
 *      assigns their ELI)
 *   4. `country`, when it already names an autonomous community
 *   5. `es` — only when nothing marks the norm as autonomic
 * Throws instead of defaulting to `es` when the norm is autonomic (by
 * `ambito` or by `departamento`) but no rule above names its community.
 */
export function resolveJurisdiction(
	input: JurisdictionInput,
): SpainJurisdiction {
	const resolved =
		jurisdictionFromEli(input.source) ??
		jurisdictionFromBulletin(input.id) ??
		jurisdictionFromDepartment(input.department);
	if (resolved) return resolved;

	if (
		input.country &&
		input.country !== "es" &&
		isSpainJurisdiction(input.country)
	) {
		return input.country;
	}

	if (
		input.ambitoCode === BOE_AMBITO_AUTONOMICO ||
		looksAutonomic(input.department)
	) {
		throw new Error(
			`Cannot resolve the jurisdiction of ${input.id}: it is autonomic ` +
				`(departamento "${input.department ?? ""}", ámbito ${input.ambitoCode ?? "?"}) ` +
				`but has no ELI URL, no regional bulletin prefix and an unknown departamento. ` +
				`Refusing to default to "es" — add the departamento to DEPARTMENT_TO_JURISDICTION.`,
		);
	}
	return "es";
}
