/**
 * BOE norm discovery.
 *
 * Discovers norms available in the BOE consolidated legislation catalog.
 */

import type { LegislativeClient, NormDiscovery } from "../country.ts";
import type { BoeClient } from "./boe-client.ts";

export class BoeDiscovery implements NormDiscovery {
	async *discoverAll(client: LegislativeClient): AsyncIterable<string> {
		const boe = client as BoeClient;
		const pageSize = 100;
		let offset = 0;

		while (true) {
			const { data } = await boe.list(pageSize, offset);
			if (data.length === 0) break;

			for (const item of data) {
				yield item.identificador;
			}

			if (data.length < pageSize) break;
			offset += pageSize;
		}
	}

	// biome-ignore lint/correctness/useYield: not yet implemented
	async *discoverDaily(
		_client: LegislativeClient,
		_date: string,
	): AsyncIterable<string> {
		// TODO: implement daily summary via /boe/sumario/{YYYYMMDD}
		throw new Error("Daily discovery not yet implemented");
	}
}
