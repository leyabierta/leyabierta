/**
 * Country abstraction layer.
 *
 * Each country implements these interfaces to plug into the generic pipeline.
 * The pipeline never imports country-specific code directly — it goes through
 * the registry.
 */

import type { Block, NormMetadata, Reform } from "./models.ts";

/**
 * Fetches raw legislative text and metadata from an official source.
 */
export interface LegislativeClient {
	/** Download the full consolidated text (XML/HTML). */
	getText(normId: string): Promise<Uint8Array>;

	/** Download norm metadata. */
	getMetadata(normId: string): Promise<Uint8Array>;

	/** Cleanup (close connections, etc). */
	close(): Promise<void>;
}

/**
 * Discovers norms available in a country's official catalog.
 */
export interface NormDiscovery {
	/** Discover all available norm IDs. */
	discoverAll(client: LegislativeClient): AsyncIterable<string>;

	/** Discover norms published on a specific date. */
	discoverDaily(client: LegislativeClient, date: string): AsyncIterable<string>;
}

/**
 * Parses raw text data into structured blocks.
 */
export interface TextParser {
	/** Parse consolidated text into blocks with version history. */
	parseText(data: Uint8Array): Block[];

	/** Extract the reform timeline from parsed blocks. */
	extractReforms(blocks: readonly Block[]): Reform[];
}

/**
 * Parses raw metadata into normalized NormMetadata.
 */
export interface MetadataParser {
	parse(data: Uint8Array, normId: string): NormMetadata;
}

/**
 * Complete country configuration.
 */
export interface CountryConfig {
	readonly code: string; // ISO 3166-1 alpha-2
	readonly name: string;
	readonly client: () => LegislativeClient;
	readonly discovery: () => NormDiscovery;
	readonly textParser: () => TextParser;
	readonly metadataParser: () => MetadataParser;
}

// ─── Registry ───

const registry = new Map<string, CountryConfig>();

export function registerCountry(config: CountryConfig): void {
	registry.set(config.code, config);
}

export function getCountry(code: string): CountryConfig {
	const config = registry.get(code);
	if (!config) {
		throw new Error(
			`Country "${code}" not registered. Available: ${[...registry.keys()].join(", ")}`,
		);
	}
	return config;
}

export function supportedCountries(): string[] {
	return [...registry.keys()];
}
