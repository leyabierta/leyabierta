/**
 * Corpus document-frequency table for the rare-term overlap leak check.
 *
 * Samples N random articles (block_type='precepto') from the SQLite DB,
 * tokenizes each (lowercase, no diacritics, words >= minTokenLength), and
 * counts the number of distinct articles each token appears in. Returns
 * a Map<token, fraction-of-articles> where fraction is in [0, 1].
 *
 * Cached to disk (default `data/leak-corpus-frequency.json`) so subsequent
 * runs are instantaneous. Cache key encodes sampleSize and minTokenLength.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tokenizeForRareOverlap } from "./prompts/leak-detector.ts";

export interface BuildCorpusFrequencyOpts {
	sampleSize?: number;
	minTokenLength?: number;
	cachePath?: string;
	/** If true, ignore the on-disk cache and rebuild. */
	force?: boolean;
}

interface CorpusFrequencyCacheV1 {
	version: 1;
	sampleSize: number;
	minTokenLength: number;
	totalArticles: number;
	frequency: Record<string, number>;
}

const DEFAULT_CACHE_PATH = "data/leak-corpus-frequency.json";

export function buildCorpusFrequencyTable(
	db: Database,
	opts: BuildCorpusFrequencyOpts = {},
): Map<string, number> {
	const sampleSize = opts.sampleSize ?? 5000;
	const minTokenLength = opts.minTokenLength ?? 4;
	const cachePath = opts.cachePath ?? DEFAULT_CACHE_PATH;
	const force = opts.force ?? false;

	if (!force && existsSync(cachePath)) {
		try {
			const raw = readFileSync(cachePath, "utf8");
			const cache = JSON.parse(raw) as CorpusFrequencyCacheV1;
			if (
				cache.version === 1 &&
				cache.sampleSize === sampleSize &&
				cache.minTokenLength === minTokenLength
			) {
				return new Map(Object.entries(cache.frequency));
			}
		} catch {
			// Fall through to rebuild.
		}
	}

	const rows = db
		.prepare(
			`SELECT current_text FROM blocks
			 WHERE block_type = 'precepto'
			   AND current_text IS NOT NULL
			   AND length(current_text) > 50
			 ORDER BY RANDOM()
			 LIMIT ?`,
		)
		.all(sampleSize) as { current_text: string }[];

	const totalArticles = rows.length;
	const docFreq = new Map<string, number>();

	for (const row of rows) {
		const tokens = new Set(
			tokenizeForRareOverlap(row.current_text, minTokenLength),
		);
		for (const token of tokens) {
			docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
		}
	}

	const fractional = new Map<string, number>();
	if (totalArticles > 0) {
		for (const [token, count] of docFreq) {
			fractional.set(token, count / totalArticles);
		}
	}

	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		const payload: CorpusFrequencyCacheV1 = {
			version: 1,
			sampleSize,
			minTokenLength,
			totalArticles,
			frequency: Object.fromEntries(fractional),
		};
		writeFileSync(cachePath, JSON.stringify(payload));
	} catch {
		// Cache write is best-effort; never fail the pipeline because of it.
	}

	return fractional;
}
