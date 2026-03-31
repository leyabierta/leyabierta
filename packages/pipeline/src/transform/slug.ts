/**
 * File path generation for norm Markdown files.
 *
 * Follows the ELI (European Legislation Identifier) convention:
 *   jurisdiction/NORM-ID.md
 *
 * Jurisdiction is extracted from:
 * 1. ELI source URL: /eli/es/... → es, /eli/es-pv/... → es-pv
 * 2. Norm ID prefix for regional bulletins without ELI URLs:
 *    BOA → es-ar (Aragón), BOJA → es-an (Andalucía), etc.
 */

import type { NormMetadata } from "../models.ts";

/** Map regional bulletin prefixes to ELI jurisdiction codes */
const BULLETIN_TO_JURISDICTION: Record<string, string> = {
	BOA: "es-ar", // Boletín Oficial de Aragón
	BOJA: "es-an", // Boletín Oficial de la Junta de Andalucía
	DOGV: "es-vc", // Diari Oficial de la Generalitat Valenciana
	BORM: "es-mc", // Boletín Oficial de la Región de Murcia
	BOCL: "es-cl", // Boletín Oficial de Castilla y León
	DOGC: "es-ct", // Diari Oficial de la Generalitat de Catalunya
	BOC: "es-cn", // Boletín Oficial de Canarias
	BOIB: "es-ib", // Butlletí Oficial de les Illes Balears
	BON: "es-nc", // Boletín Oficial de Navarra
	DOG: "es-ga", // Diario Oficial de Galicia
	DOCM: "es-cm", // Diario Oficial de Castilla-La Mancha
	BOPV: "es-pv", // Boletín Oficial del País Vasco
	BOCT: "es-cb", // Boletín Oficial de Cantabria
	DOE: "es-ex", // Diario Oficial de Extremadura
	BOCM: "es-md", // Boletín Oficial de la Comunidad de Madrid
};

/**
 * Extract ELI jurisdiction from the source URL or norm ID prefix.
 * Falls back to the country code if neither matches.
 */
export function extractJurisdiction(metadata: NormMetadata): string {
	// 1. Try ELI URL
	const eliMatch = metadata.source.match(/\/eli\/(es(?:-[a-z]{2})?)\//);
	if (eliMatch) return eliMatch[1]!;

	// 2. Try bulletin prefix from norm ID (e.g. BOA-d-2019-90260 → BOA → es-ar)
	const prefix = metadata.id.split("-")[0]!;
	if (BULLETIN_TO_JURISDICTION[prefix])
		return BULLETIN_TO_JURISDICTION[prefix]!;

	// 3. Fallback to country
	return metadata.country;
}

export function normToFilepath(metadata: NormMetadata): string {
	const jurisdiction = extractJurisdiction(metadata);
	return `${jurisdiction}/${metadata.id}.md`;
}
