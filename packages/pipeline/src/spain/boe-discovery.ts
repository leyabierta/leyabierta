/**
 * BOE norm discovery.
 *
 * Discovers norms available in the BOE consolidated legislation catalog.
 * The list endpoint returns norms ordered by fecha_actualizacion DESC,
 * so the most recently updated norms come first.
 */

import type {
	DiscoveredNorm,
	LegislativeClient,
	NormDiscovery,
} from "../country.ts";
import type { BoeClient } from "./boe-client.ts";

export class BoeDiscovery implements NormDiscovery {
	/** Discover all norms (full pagination). Used by --force mode. */
	async *discoverAll(client: LegislativeClient): AsyncIterable<DiscoveredNorm> {
		const boe = client as BoeClient;
		const pageSize = 100;
		let offset = 0;

		while (true) {
			const { data } = await boe.list(pageSize, offset);
			if (data.length === 0) break;

			for (const item of data) {
				yield {
					id: item.identificador,
					fechaActualizacion: item.fecha_actualizacion,
				};
			}

			if (data.length < pageSize) break;
			offset += pageSize;
		}
	}

	/**
	 * Discover norms updated since a given timestamp.
	 *
	 * Uses early-stop: the BOE list is ordered by fecha_actualizacion DESC
	 * (this is the API's default sort — no sort parameter is passed).
	 * We paginate from the start and stop when we reach a norm older than
	 * our watermark. On a typical day this is 1-2 pages (0-10 norms).
	 *
	 * Norms without fecha_actualizacion are always yielded (can't determine
	 * if they're stale, so we let the caller decide).
	 *
	 * Note: error norms whose watermark has passed are NOT retried here —
	 * the caller (cli.ts) unions error norms separately after discovery.
	 */
	async *discoverUpdated(
		client: LegislativeClient,
		since?: string,
	): AsyncIterable<DiscoveredNorm> {
		const boe = client as BoeClient;
		const pageSize = 100;
		let offset = 0;

		while (true) {
			const { data } = await boe.list(pageSize, offset);
			if (data.length === 0) break;

			for (const item of data) {
				// Lexicographic comparison works for "YYYYMMDDTHHmmssZ" format
				if (
					since &&
					item.fecha_actualizacion &&
					item.fecha_actualizacion <= since
				) {
					return; // Caught up — everything after this is older
				}
				yield {
					id: item.identificador,
					fechaActualizacion: item.fecha_actualizacion,
				};
			}

			if (data.length < pageSize) break;
			offset += pageSize;
		}
	}
}
