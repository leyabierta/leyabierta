// Helpers for /boe/hoy and /boe/[fecha] (#130 stage 4): the BOE diario as
// published each day, grouped by sumario section, read from the same
// getCollection("laws") Content Collection every other page uses. Pure TS —
// no Astro-specific imports — so it's easy to unit test.

/**
 * Citizen-facing labels for BOE sumario section codes. Only "1" (Sección I —
 * Disposiciones generales, where consolidated legislation lives) is ingested
 * as of #130; the rest are kept here so the page degrades gracefully instead
 * of guessing if ingestion ever widens.
 */
const SECTION_LABELS: Record<string, string> = {
	"1": "Disposiciones generales",
	"2A": "Nombramientos y situaciones de personal",
	"2B": "Oposiciones y concursos",
	"3": "Otras disposiciones",
	"4": "Administración de Justicia",
	"5A": "Contratación del sector público",
	"5B": "Otros anuncios oficiales",
};

/** Plain-language label for a section code; falls back to a generic but
 * still-readable name for codes not in the map above. */
export function sectionLabel(code: string): string {
	if (!code) return "Otras publicaciones";
	return SECTION_LABELS[code] ?? `Sección ${code}`;
}

/** Parse a BOE sumario section code into its numeric prefix and letter
 * suffix — e.g. "2A" → { num: 2, suffix: "A" }, "1" → { num: 1, suffix: "" }.
 * A code with no numeric prefix sorts last (Infinity). */
function parseSectionCode(code: string): { num: number; suffix: string } {
	const match = code.match(/^(\d+)(.*)$/);
	if (!match) return { num: Number.POSITIVE_INFINITY, suffix: code };
	return { num: Number(match[1]), suffix: match[2] ?? "" };
}

/** Sort section codes in true BOE sumario order: "1", "2A", "2B", "3", "5A",
 * "5B" — by numeric prefix first, then by letter suffix. Sorting by string
 * length (the naive approach) gets this wrong: it would put "3" before "2A"
 * because "3" is shorter. */
export function compareSections(a: string, b: string): number {
	const pa = parseSectionCode(a);
	const pb = parseSectionCode(b);
	return pa.num - pb.num || pa.suffix.localeCompare(pb.suffix);
}

export interface BoeLawData {
	identificador: string;
	titulo: string;
	rango: string;
	departamento: string;
	jurisdiccion: string;
	fecha_publicacion: string;
	consolidado: boolean;
	seccion?: string;
}

export interface BoeItem {
	id: string;
	titulo: string;
	rango: string;
	departamento: string;
	jurisdiccion: string;
	consolidado: boolean;
}

export interface BoeSection {
	section: string;
	label: string;
	items: BoeItem[];
}

/** Dedupe laws by identificador — same invariant as the rest of the site
 * (see CLAUDE.md "Data Integrity Invariants"): the leyes repo can
 * momentarily contain the same id twice. */
export function dedupeLaws<T extends { identificador: string }>(
	laws: T[],
): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const l of laws) {
		if (seen.has(l.identificador)) continue;
		seen.add(l.identificador);
		out.push(l);
	}
	return out;
}

/** All distinct publication dates that have diario (not-yet-consolidated)
 * norms in the (deduped) collection, newest first. Restricted to
 * consolidado===false so /boe/hoy and /boe/[fecha] mirror the BOE diario —
 * not the ~12k-law, 1835-onward consolidated archive (that's what /leyes and
 * /cambios are for). A norm that has since been consolidated no longer has a
 * diario row, so it drops off its day page — acceptable for this MVP; the
 * norm itself remains reachable via normal search. */
export function getBoeDates(laws: BoeLawData[]): string[] {
	const dates = new Set<string>();
	for (const l of laws) {
		if (l.consolidado === false && l.fecha_publicacion) {
			dates.add(l.fecha_publicacion);
		}
	}
	return [...dates].sort((a, b) => b.localeCompare(a));
}

/** Group every diario (not-yet-consolidated) law published on `fecha` into
 * sumario sections, sorted in natural section order and by title within a
 * section. See getBoeDates for why this is restricted to consolidado===false. */
export function groupBoeDay(laws: BoeLawData[], fecha: string): BoeSection[] {
	const dayLaws = laws.filter(
		(l) => l.fecha_publicacion === fecha && l.consolidado === false,
	);

	const bySection = new Map<string, BoeItem[]>();
	for (const l of dayLaws) {
		const section = l.seccion ?? "";
		const item: BoeItem = {
			id: l.identificador,
			titulo: l.titulo,
			rango: l.rango,
			departamento: l.departamento,
			jurisdiccion: l.jurisdiccion,
			consolidado: l.consolidado,
		};
		const bucket = bySection.get(section);
		if (bucket) bucket.push(item);
		else bySection.set(section, [item]);
	}

	return [...bySection.keys()].sort(compareSections).map((section) => ({
		section,
		label: sectionLabel(section),
		items: (bySection.get(section) ?? []).sort((a, b) =>
			a.titulo.localeCompare(b.titulo, "es"),
		),
	}));
}
