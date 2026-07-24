/**
 * Discovery of items published in a BOE daily sumario.
 *
 * Walks `sumario.diario[].seccion[].departamento[]`, whose leaves eventually
 * reach `item` nodes. Every level from `seccion` down to `item` can come
 * back from the API as either a single object or an array — `toArray()`
 * normalizes both. The path from `departamento` to `item` is NOT fixed:
 * some sections nest an intermediate `texto` and/or `epigrafe` wrapper,
 * others go straight from `departamento` to `item` (see Sección V).
 */

import { toArray } from "../utils/xml-normalize.ts";
import type { Sumario } from "./boe-diario-client.ts";

export interface DiarioItem {
	readonly id: string;
	readonly section: string;
	readonly titulo: string;
	readonly urlXml: string;
}

const DEFAULT_SECTIONS = ["1"];

export class BoeDiarioDiscovery {
	/**
	 * Yield every item in `sumario` whose section code is in `sections`
	 * (default: Sección I only — the disposiciones generales we ingest).
	 */
	*discover(
		sumario: Sumario,
		sections: readonly string[] = DEFAULT_SECTIONS,
	): Iterable<DiarioItem> {
		const wanted = new Set(sections);
		const diarios = toArray(sumario?.diario);

		for (const diario of diarios) {
			const seccionNodes = toArray(diario.seccion);
			for (const seccion of seccionNodes) {
				const codigo = String(seccion.codigo ?? "");
				if (!wanted.has(codigo)) continue;

				const departamentos = toArray(seccion.departamento);
				for (const departamento of departamentos) {
					for (const item of collectItems(departamento)) {
						const id = item.identificador as string | undefined;
						const titulo = item.titulo as string | undefined;
						const urlXml = extractUrlXml(item);
						if (!id || !urlXml) continue;
						yield { id, section: codigo, titulo: titulo ?? "", urlXml };
					}
				}
			}
		}
	}
}

/**
 * Collect all `item` leaves reachable from a `departamento` (or nested
 * `texto`/`epigrafe`) node, regardless of how deep the wrapping goes.
 */
function collectItems(
	node: Record<string, unknown>,
): Record<string, unknown>[] {
	if (node.item !== undefined) {
		return toArray(node.item);
	}

	const items: Record<string, unknown>[] = [];
	if (node.texto !== undefined) {
		for (const texto of toArray(node.texto)) {
			items.push(...collectItems(texto));
		}
	}
	if (node.epigrafe !== undefined) {
		for (const epigrafe of toArray(node.epigrafe)) {
			items.push(...collectItems(epigrafe));
		}
	}
	return items;
}

function extractUrlXml(item: Record<string, unknown>): string | undefined {
	const raw = item.url_xml;
	if (typeof raw === "string") return raw;
	// Defensive: the BOE API has been observed wrapping some URL fields in
	// a { texto: "..." } shape elsewhere (see url_pdf) — tolerate the same
	// here even though url_xml has not shown that shape in practice.
	if (raw && typeof raw === "object") {
		const texto = (raw as Record<string, unknown>).texto;
		if (typeof texto === "string") return texto;
	}
	return undefined;
}
