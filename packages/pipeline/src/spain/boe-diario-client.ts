/**
 * HTTP client for the BOE daily bulletin ("diario oficial").
 *
 * Unlike the consolidated legislation API (`BoeClient`), the diario has no
 * notion of "current state" — each day's sumario lists the norms published
 * that day, and each item's raw XML is a flat, unversioned snapshot of the
 * text as published (see `transform/diario-xml-parser.ts`).
 */

import { ThrottledHttp } from "./throttled-http.ts";

/** Sentinel returned by getSumario() when the BOE published nothing that day (e.g. Sundays). */
export const EMPTY_DAY = Symbol("empty-boe-day");

/**
 * The `sumario` object itself — `{ diario: [...], metadatos: {...} }` — NOT
 * the raw API envelope (`{ status, data: { sumario } }`). `getSumario()`
 * unwraps the envelope so its return type can never be mistaken for the
 * envelope: passing the full response into `BoeDiarioDiscovery.discover()`
 * would silently yield zero items every day (there is no `.diario` at that
 * level), so the unwrapping happens once, here, instead of being every
 * caller's responsibility.
 */
export type Sumario = Record<string, unknown>;

export class BoeDiarioClient {
	private readonly http: ThrottledHttp;

	constructor(delayMs?: number) {
		this.http = new ThrottledHttp(delayMs);
	}

	/**
	 * Fetch the daily sumario for `fecha` (YYYYMMDD), unwrapped to the inner
	 * `sumario` object (`data.sumario` in the raw API response) — the shape
	 * `BoeDiarioDiscovery.discover()` expects.
	 *
	 * A 404 means the BOE published nothing that day (typically Sundays) —
	 * that is a normal, expected outcome and returns `EMPTY_DAY` rather
	 * than throwing. Any other non-"200" status code throws.
	 */
	async getSumario(fecha: string): Promise<Sumario | typeof EMPTY_DAY> {
		const url = `https://www.boe.es/datosabiertos/api/boe/sumario/${fecha}`;
		const bytes = await this.http.fetchOptional(url, "application/json");
		if (bytes === undefined) return EMPTY_DAY;

		const json = JSON.parse(new TextDecoder().decode(bytes));
		if (json.status?.code !== "200") {
			throw new Error(`BOE sumario failed for ${fecha}: ${json.status?.text}`);
		}

		const sumario = json.data?.sumario;
		if (!sumario || typeof sumario !== "object") {
			throw new Error(`BOE sumario for ${fecha} has no data.sumario`);
		}
		return sumario as Sumario;
	}

	/** Fetch the raw diario XML for a single item id. */
	async getDiarioXml(id: string): Promise<Uint8Array> {
		const url = `https://www.boe.es/diario_boe/xml.php?id=${id}`;
		return this.http.fetch(url);
	}

	async close(): Promise<void> {
		// No persistent connections to clean up
	}
}
