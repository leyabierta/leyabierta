/**
 * BOE materia code → name resolution, shared by `ingest-analisis` (Step 3)
 * and the daily `bootstrap` (via `BoeClient.getNormAnalisis`).
 */

import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_MATERIAS_PATH = "./data/auxiliar/materias.json";

/** Load `data/auxiliar/materias.json` (code → name). Empty if unusable. */
export function loadMateriaLookup(
	path: string = DEFAULT_MATERIAS_PATH,
): Record<string, string> {
	try {
		if (!existsSync(path)) return {};
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return raw && typeof raw.data === "object" && raw.data ? raw.data : {};
	} catch {
		return {};
	}
}

/**
 * Resolve ELI materia codes to names. Never fabricates a name for an unknown
 * code (2026-07-22 incident: "[código NNNN]" placeholders were published):
 * unknown codes are dropped and added to `missing`. If NONE resolve, fall back
 * to the partial but real names from the /analisis endpoint.
 */
export function resolveMaterias(
	codes: readonly string[],
	lookup: Readonly<Record<string, string>>,
	fallback: readonly string[],
	missing?: Set<string>,
): string[] {
	const resolved: string[] = [];
	for (const code of codes) {
		const name = lookup[code];
		if (name) resolved.push(name);
		else missing?.add(code);
	}
	return resolved.length > 0 ? resolved : [...fallback];
}
