/**
 * BOE metadata parser.
 *
 * Parses the JSON metadata response from the BOE API into NormMetadata.
 */

import type { MetadataParser } from "../country.ts";
import type { NormMetadata, NormStatus, Rank } from "../models.ts";
import { parseBoeDate } from "../utils/date.ts";

/** Map BOE rank codes to our Rank values. */
const RANK_MAP: Record<string, Rank> = {
	"1070": "constitucion",
	"1080": "ley_organica", // Estatuto de Autonomía
	"1290": "ley_organica",
	"1300": "ley",
	"1310": "real_decreto_legislativo",
	"1320": "real_decreto_ley",
	"1340": "real_decreto",
	"1350": "orden",
	"1360": "resolucion",
	"1370": "instruccion",
	"1380": "reglamento",
	"1390": "circular",
	"1180": "acuerdo_internacional",
	"1470": "decreto", // Decreto Legislativo (autonómico)
	"1500": "real_decreto_ley", // Decreto-ley (autonómico)
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

		return {
			title,
			shortTitle: extractShortTitle(title),
			id: normId,
			country: "es",
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
 * "Ley Orgánica 1/2024, de 10 de junio, de amnistía para..." → "Ley Orgánica 1/2024"
 */
function extractShortTitle(title: string): string {
	// Match up to the first comma after the law number
	const match = title.match(
		/^((?:Constitución|Ley Orgánica|Ley|Real Decreto[- ]ley|Real Decreto Legislativo|Real Decreto|Orden|Resolución|Circular|Instrucción|Decreto[- ]ley|Decreto Legislativo|Decreto|Reglamento|Acuerdo)[^,]*?\d+(?:\/\d+)?)/i,
	);
	if (match) return match[1]!;

	// Special case: "Constitución Española"
	if (title.toLowerCase().includes("constitución"))
		return "Constitución Española";

	// Fallback: first 60 chars
	return title.length > 60 ? `${title.slice(0, 57)}...` : title;
}
