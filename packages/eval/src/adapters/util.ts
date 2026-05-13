/**
 * Shared helpers for all source adapters.
 */

// Best-effort citation extraction — not exhaustive, covers the main patterns
// found in Spanish legal texts. Deduplicates results.
const CITATION_RE =
	/(Ley(?:\s+Org[áa]nica)?|Real\s+Decreto(?:-ley)?|Decreto|Reglamento|Constituci[oó]n|RD|RDL|RDLeg|LO|RGPD|Directiva|Reglamento\s+UE)[\s.]+[\dN.°º/-]+(?:[,\s]+(?:Art(?:\.|[íi]culo)?|art(?:\.|[íi]culo)?)\s*[\dN.°º/.-]+)?/g;

export function extractCitations(text: string): string[] {
	const matches = text.match(CITATION_RE) ?? [];
	// Strip trailing punctuation before deduplicating so "Ley 7/1994." and
	// "Ley 7/1994" are treated as the same citation.
	return [...new Set(matches.map((m) => m.trim().replace(/[.,;:]+$/, "")))];
}

// DGT date format: "DD/MM/YYYY" → "YYYY-MM-DD". Returns undefined on failure.
export function parseDgtDate(s: string): string | undefined {
	if (!s) return undefined;
	const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
	if (!m) return undefined;
	return `${m[3]}-${m[2]}-${m[1]}`;
}

// Map known source_id prefixes to jurisdiction codes.
// Returns undefined for unknown sources rather than defaulting to "es".
export function jurisdictionFromSourceId(s: string): string | undefined {
	if (!s) return undefined;
	if (s.startsWith("Boletin_Oficial_Ceuta") || s.startsWith("BOCCE"))
		return "es-ce";
	if (s.startsWith("Boletin_Oficial_Junta_Andalucia") || s.startsWith("BOJA"))
		return "es-an";
	if (s.startsWith("ParlaMint-ES-AN") || s.startsWith("ParlaMint"))
		return "es-an";
	if (s.startsWith("Boletin_Oficial_Navarra") || s.startsWith("BON"))
		return "es-nc";
	if (
		s.startsWith("Diari_Oficial_Comunitat_Valenciana") ||
		s.startsWith("DOGV")
	)
		return "es-vc";
	if (s.startsWith("Boletin_Oficial_Aragon") || s.startsWith("BOA"))
		return "es-ar";
	return undefined;
}

export function sha1(s: string): string {
	const hasher = new Bun.CryptoHasher("sha1");
	hasher.update(s);
	return hasher.digest("hex");
}

// Read a JSONL file line by line without loading entire file into memory.
// Yields parsed objects; skips blank lines and JSON parse errors.
// Uses readline streaming to avoid allocating the full file as a string.
export async function* readJsonl<T>(path: string): AsyncGenerator<T> {
	const { createReadStream } = await import("node:fs");
	const { createInterface } = await import("node:readline");

	const rl = createInterface({
		input: createReadStream(path, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			yield JSON.parse(trimmed) as T;
		} catch {
			// skip unparseable lines
		}
	}
}
