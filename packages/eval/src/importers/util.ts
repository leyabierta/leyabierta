/**
 * Shared helpers for the human-seed importers.
 *
 * - hashQuestionId: stable FNV-1a 32-bit hex used as the EvalQuestion.id,
 *   matching the `q_<8hex>` shape produced by the agentic pipeline
 *   (see packages/eval/src/pipeline.ts hashId).
 * - jurisdictionFromNorms: best-effort ELI jurisdiction from the
 *   bulletin prefix of the expected norm ids.
 */

/** FNV-1a 32-bit hash of the question text, formatted as `q_<8hex>`. */
export function hashQuestionId(text: string): string {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return `q_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Map known Spanish bulletin prefixes to ELI jurisdiction codes.
 * Anything unknown (or BOE) maps to "es".
 *
 * The mapping is deliberately conservative: BOC (which can mean either
 * Boletín Oficial de Canarias or Cantabria depending on context) defaults
 * to "es-cn"; ambiguous cases will be revisited in the annotation pass.
 */
const PREFIX_TO_JURISDICTION: Record<string, string> = {
	BOE: "es",
	BOA: "es-ar", // Aragón
	BOPA: "es-as", // Asturias
	BOC: "es-cn", // Canarias (also collides with Cantabria; revisit later)
	BOIB: "es-ib", // Islas Baleares
	BOCYL: "es-cl", // Castilla y León
	DOCM: "es-cm", // Castilla-La Mancha
	DOGC: "es-ct", // Cataluña
	DOE: "es-ex", // Extremadura
	DOG: "es-ga", // Galicia
	BOR: "es-ri", // La Rioja
	BOCM: "es-md", // Madrid
	BORM: "es-mc", // Murcia
	BON: "es-nc", // Navarra
	BOPV: "es-pv", // País Vasco
	DOGV: "es-vc", // Comunidad Valenciana
	BOJA: "es-an", // Andalucía
};

export function jurisdictionFromNormId(normId: string): string {
	const dash = normId.indexOf("-");
	if (dash <= 0) return "es";
	const prefix = normId.slice(0, dash);
	return PREFIX_TO_JURISDICTION[prefix] ?? "es";
}

/**
 * Pick a jurisdiction for a question given its expectedNorms.
 * If all norms agree, use that; if mixed, prefer the first non-"es"
 * jurisdiction (regional norms are more specific than the national default);
 * otherwise fall back to "es".
 */
export function jurisdictionFromNorms(norms: readonly string[]): string {
	if (norms.length === 0) return "es";
	const codes = norms.map(jurisdictionFromNormId);
	const regional = codes.find((c) => c !== "es");
	return regional ?? "es";
}
