/**
 * BOE metadata parser.
 *
 * Parses the JSON metadata response from the BOE API into NormMetadata.
 */

import type { MetadataParser } from "../country.ts";
import type { NormMetadata, NormStatus, Rank } from "../models.ts";
import { parseBoeDate } from "../utils/date.ts";

/** Map regional bulletin ID prefixes to jurisdiction codes. */
const BULLETIN_JURISDICTION: Record<string, string> = {
	BOA: "es-ar", // Aragón
	BOJA: "es-an", // Andalucía
	BOCL: "es-cl", // Castilla y León
	BOCM: "es-md", // Madrid
	BOC: "es-cn", // Canarias (also Cantabria via BOCT)
	BOCT: "es-cb", // Cantabria
	BOIB: "es-ib", // Islas Baleares
	BON: "es-nc", // Navarra
	BOPV: "es-pv", // País Vasco
	BORM: "es-mc", // Murcia
	DOCM: "es-cm", // Castilla-La Mancha
	DOE: "es-ex", // Extremadura
	DOG: "es-ga", // Galicia
	DOGC: "es-ct", // Cataluña
	DOGV: "es-vc", // Comunidad Valenciana
};

/** Extract jurisdiction from ELI URL or norm ID prefix. */
function extractJurisdiction(eli: string | undefined, normId: string): string {
	// 1. Try ELI URL: /eli/es-an/... → es-an
	if (eli) {
		const match = eli.match(/\/eli\/(es(?:-[a-z]{2})?)\//);
		if (match) return match[1];
	}

	// 2. Try regional bulletin prefix: BOJA-... → es-an
	const prefix = normId.split("-")[0];
	if (prefix && BULLETIN_JURISDICTION[prefix]) {
		return BULLETIN_JURISDICTION[prefix];
	}

	return "es";
}

// Map BOE rank codes to our Rank values. Source of truth:
// data/auxiliar/rangos.json (BOE's own catalog). The previous mapping was
// off-by-one for several codes (1370 was labeled "instruccion" instead of
// "resolucion", 1380 didn't exist as "reglamento", etc.), so most Resoluciones
// rendered as "Instrucción" and real Instrucciones fell through to "otro".
export const RANK_MAP: Record<string, Rank> = {
	"1020": "acuerdo",
	"1070": "constitucion",
	"1080": "ley_organica", // Estatuto de Autonomía
	"1180": "acuerdo_internacional",
	"1220": "reglamento",
	"1290": "ley_organica",
	"1300": "ley",
	"1310": "real_decreto_legislativo",
	"1320": "real_decreto_ley",
	"1325": "real_decreto_ley", // Decreto-ley Foral
	"1340": "real_decreto",
	"1350": "orden",
	"1370": "resolucion",
	"1390": "circular",
	"1410": "instruccion",
	"1450": "ley", // Ley Foral
	"1470": "decreto", // Decreto Legislativo (autonómico)
	"1480": "decreto", // Decreto Foral Legislativo
	"1500": "real_decreto_ley", // Decreto-ley (autonómico)
	"1510": "decreto",
};

export class BoeMetadataParser implements MetadataParser {
	parse(data: Uint8Array, normId: string): NormMetadata {
		const json = JSON.parse(new TextDecoder().decode(data));
		const item = json.data?.[0] ?? json.data;

		if (!item) {
			throw new Error(`No metadata found for ${normId}`);
		}

		return this.parseItem(item, normId);
	}

	/**
	 * Parse a list item (from the list endpoint) into NormMetadata.
	 * Avoids an extra HTTP request when we already have list data.
	 */
	parseListItem(item: Record<string, unknown>, normId: string): NormMetadata {
		return this.parseItem(item, normId);
	}

	private parseItem(
		item: Record<string, unknown>,
		normId: string,
	): NormMetadata {
		const rango = item.rango as { codigo: string; texto: string } | undefined;
		const dept = item.departamento as
			| { codigo: string; texto: string }
			| undefined;

		const title = cleanTitle(item.titulo as string);
		const rank = RANK_MAP[rango?.codigo ?? ""] ?? ("otro" as Rank);
		const published = parseBoeDate(item.fecha_publicacion as string);
		const vigencia = parseBoeDate(item.fecha_vigencia as string);
		const eli = item.url_eli as string | undefined;

		// "1900-01-01" is the sentinel for "BOE returned no usable
		// fecha_publicacion". Log it so the per-norm commit later (which will
		// clamp to 1970-01-02) is traceable to the real cause: missing source
		// data, not a pipeline bug.
		if (!published) {
			console.warn(
				`[boe-metadata] ${normId} has no fecha_publicacion (raw=${JSON.stringify(item.fecha_publicacion)}) — falling back to 1900-01-01`,
			);
		}

		return {
			title,
			shortTitle: extractShortTitle(title),
			id: normId,
			country: extractJurisdiction(eli, normId),
			rank,
			publishedAt: published ?? "1900-01-01",
			status: deriveStatus(item),
			department: dept?.texto ?? "",
			source: eli ?? `https://www.boe.es/buscar/act.php?id=${normId}`,
			updatedAt: vigencia && vigencia !== published ? vigencia : undefined,
		};
	}
}

function deriveStatus(item: Record<string, unknown>): NormStatus {
	if (item.estatus_derogacion === "S") return "derogada";
	if (item.vigencia_agotada === "S") return "derogada";
	return "vigente";
}

// parseBoeDate imported from ../utils/date.ts

function cleanTitle(raw: string): string {
	return raw?.replace(/\.$/, "").trim() ?? "";
}

/**
 * Extract a short title from a full BOE title.
 *
 * Two patterns are recognised:
 *
 * 1. Dated ranks (Resolución, Orden, Instrucción, …) — titles structured as
 *    "<Tipo> de DD de <mes> de YYYY, …". We capture up to and including the
 *    four-digit year so the date is preserved:
 *    "Resolución de 31 de enero de 1995, de la Secretaría…" → "Resolución de 31 de enero de 1995"
 *
 * 2. Numbered ranks (Ley, Real Decreto, …) — titles structured as
 *    "<Tipo> N/YEAR, de DD de <mes>, …". We capture up to the first comma
 *    so the number is preserved:
 *    "Ley Orgánica 1/2024, de 10 de junio, de amnistía…" → "Ley Orgánica 1/2024"
 *
 * Order matters: dated pattern is tried first because some types (Circular,
 * Acuerdo, Orden) can appear in both patterns and the dated form is more
 * specific — it requires the literal word "de" between type and day number.
 */
export function extractShortTitle(title: string): string {
	// 1. Special case: "Constitución Española" — no number/date suffix.
	if (/^constituci[oó]n/i.test(title)) return "Constitución Española";

	// Spanish months for the date pattern.
	const MONTHS =
		"enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre";

	// 2. Dated-rank pattern: "<Tipo> de DD de <mes> de YYYY"
	//    Covers: Resolución, Orden, Orden Ministerial, Instrucción, Circular,
	//            Acuerdo, Acuerdo Internacional.
	const datedMatch = title.match(
		new RegExp(
			`^((?:Resolución|Orden Ministerial|Orden|Instrucción|Circular|Acuerdo Internacional|Acuerdo)\\s+de\\s+\\d+\\s+de\\s+(?:${MONTHS})\\s+de\\s+\\d{4})`,
			"i",
		),
	);
	if (datedMatch) return datedMatch[1]!;

	// 3. Numbered-rank pattern: "<Tipo> N/YEAR" — capture up to first comma.
	const numberedMatch = title.match(
		/^((?:Ley Orgánica|Ley|Real Decreto[- ]ley|Real Decreto Legislativo|Real Decreto|Decreto[- ]ley|Decreto Legislativo|Decreto|Reglamento|Circular|Acuerdo Internacional|Acuerdo|Orden Ministerial|Orden|Instrucción|Resolución)[^,]*?\d+(?:\/\d+)?)/i,
	);
	if (numberedMatch) return numberedMatch[1]!;

	// 4. Fallback: first 60 chars.
	return title.length > 60 ? `${title.slice(0, 57)}...` : title;
}
