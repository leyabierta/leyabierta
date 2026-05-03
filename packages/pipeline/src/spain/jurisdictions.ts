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
