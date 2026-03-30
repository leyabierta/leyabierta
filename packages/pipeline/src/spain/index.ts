/**
 * Spain (BOE) country registration.
 */

import { registerCountry } from "../country.ts";
import { extractReforms, parseTextXml } from "../transform/xml-parser.ts";
import { BoeClient } from "./boe-client.ts";
import { BoeDiscovery } from "./boe-discovery.ts";
import { BoeMetadataParser } from "./boe-metadata.ts";

export {
	type BoeAnalisis,
	BoeClient,
	type BoeReference,
} from "./boe-client.ts";
export { BoeDiscovery } from "./boe-discovery.ts";
export { BoeMetadataParser } from "./boe-metadata.ts";

registerCountry({
	code: "es",
	name: "España",
	client: () => new BoeClient(),
	discovery: () => new BoeDiscovery(),
	textParser: () => ({ parseText: parseTextXml, extractReforms }),
	metadataParser: () => new BoeMetadataParser(),
});
