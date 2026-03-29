/**
 * HTTP client for the BOE (Boletín Oficial del Estado) open data API.
 *
 * Base: https://www.boe.es/datosabiertos/api/
 * No authentication required. Self-imposed courtesy delay between requests.
 */

import type { LegislativeClient } from "../country.ts";

const BASE_URL = "https://www.boe.es/datosabiertos/api";
const DEFAULT_DELAY_MS = 200; // ~5 req/s courtesy limit

export class BoeClient implements LegislativeClient {
	private lastRequestAt = 0;

	constructor(private readonly delayMs = DEFAULT_DELAY_MS) {}

	async getText(normId: string): Promise<Uint8Array> {
		const url = `${BASE_URL}/legislacion-consolidada/id/${normId}/texto`;
		return this.fetch(url, "application/xml");
	}

	async getMetadata(normId: string): Promise<Uint8Array> {
		const url = `${BASE_URL}/legislacion-consolidada/id/${normId}/metadatos`;
		return this.fetch(url, "application/json");
	}

	async close(): Promise<void> {
		// No persistent connections to clean up
	}

	/**
	 * List consolidated norms with pagination.
	 * Returns the raw JSON response with `status` and `data` fields.
	 */
	async list(
		limit: number,
		offset = 0,
	): Promise<{ data: BoeListItem[]; total?: number }> {
		const url = `${BASE_URL}/legislacion-consolidada?limit=${limit}&offset=${offset}`;
		const bytes = await this.fetch(url, "application/json");
		const json = JSON.parse(new TextDecoder().decode(bytes));

		if (json.status?.code !== "200") {
			throw new Error(`BOE list failed: ${json.status?.text}`);
		}

		return { data: json.data ?? [] };
	}

	private async fetch(url: string, accept: string): Promise<Uint8Array> {
		await this.throttle();

		const response = await globalThis.fetch(url, {
			headers: { Accept: accept },
		});

		if (!response.ok) {
			throw new Error(`BOE request failed: ${response.status} ${url}`);
		}

		return new Uint8Array(await response.arrayBuffer());
	}

	private async throttle(): Promise<void> {
		const now = Date.now();
		const elapsed = now - this.lastRequestAt;
		if (elapsed < this.delayMs) {
			await new Promise((resolve) =>
				setTimeout(resolve, this.delayMs - elapsed),
			);
		}
		this.lastRequestAt = Date.now();
	}
}

/** Shape of a single item in the BOE list response. */
export interface BoeListItem {
	identificador: string;
	titulo: string;
	rango: { codigo: string; texto: string };
	departamento: { codigo: string; texto: string };
	fecha_publicacion: string; // YYYYMMDD
	fecha_disposicion: string; // YYYYMMDD
	fecha_vigencia?: string;
	estatus_derogacion?: string; // "S" | "N" | null
	vigencia_agotada?: string; // "S" | "N"
	estado_consolidacion?: { codigo: string; texto: string };
	url_eli?: string;
	url_html_consolidada?: string;
}
