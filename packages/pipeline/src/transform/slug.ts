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
 * 3. The autonomic departamento (BOE-A ids published before their ELI).
 * 4. metadata.country when it names an autonomous community.
 */

import type { NormMetadata } from "../models.ts";
import { resolveJurisdiction } from "../spain/jurisdictions.ts";

/**
 * Canonical jurisdiction of a norm — see `resolveJurisdiction` in
 * spain/jurisdictions.ts for the rules. Throws rather than defaulting an
 * autonomic norm to `es`.
 */
export function extractJurisdiction(metadata: NormMetadata): string {
	// Only Spain is implemented; another country's norm keeps its own code.
	const { country } = metadata;
	if (country && country !== "es" && !country.startsWith("es-")) {
		return country;
	}
	return resolveJurisdiction({
		id: metadata.id,
		source: metadata.source,
		department: metadata.department,
		country: metadata.country,
	});
}

export function normToFilepath(metadata: NormMetadata): string {
	const jurisdiction = extractJurisdiction(metadata);
	return `${jurisdiction}/${metadata.id}.md`;
}
