/**
 * Jurisdiction resolution for Spanish legislation.
 *
 * Spain has 17 autonomous communities, each with their own legislation.
 * Jurisdiction is determined from the ELI source URL or the norm ID prefix
 * (which bulletin published it). Some autonomous community laws have BOE-A
 * prefix because they were published in the state gazette.
 */

/** Map bulletin prefix → jurisdiction code (ISO 3166-2:ES). */
export const BULLETIN_JURISDICTION: Record<string, string> = {
	BOA: "es-ar",
	BOJA: "es-an",
	BOCL: "es-cl",
	BOCM: "es-md",
	BOC: "es-cn",
	BOCT: "es-cb",
	BOIB: "es-ib",
	BON: "es-nc",
	BOPV: "es-pv",
	BORM: "es-mc",
	DOCM: "es-cm",
	DOE: "es-ex",
	DOG: "es-ga",
	DOGC: "es-ct",
	DOGV: "es-vc",
	BOPA: "es-as", // Principado de Asturias
	BOR: "es-ri", // La Rioja
	BOLR: "es-ri", // La Rioja (alternative prefix)
};

/** Map jurisdiction code → human-readable name in Spanish. */
export const JURISDICTION_NAMES: Record<string, string> = {
	es: "España",
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
	"es-ib": "Illes Balears",
	"es-mc": "Murcia",
	"es-md": "Madrid",
	"es-nc": "Navarra",
	"es-pv": "País Vasco",
	"es-ri": "La Rioja",
	"es-vc": "Comunitat Valenciana",
};

/**
 * Resolve jurisdiction from ELI source URL or norm ID prefix.
 * Prefers ELI URL (most reliable), falls back to bulletin prefix.
 *
 * Examples:
 *   resolveJurisdiction("https://www.boe.es/eli/es/l/1994/11/24/(1)", "BOE-A-1994-26003") → "es"
 *   resolveJurisdiction("https://www.boe.es/eli/es-ct/l/2008/07/10/(1)", "BOE-A-2008-13533") → "es-ct"
 *   resolveJurisdiction("", "DOGC-f-2003-90008") → "es-ct"
 */
export function resolveJurisdiction(sourceUrl: string, normId: string): string {
	if (sourceUrl) {
		const match = sourceUrl.match(/\/eli\/(es(?:-[a-z]{2})?)\//);
		if (match?.[1]) return match[1];
	}
	const prefix = normId.split("-")[0];
	if (prefix && BULLETIN_JURISDICTION[prefix]) {
		return BULLETIN_JURISDICTION[prefix];
	}
	return "es";
}
