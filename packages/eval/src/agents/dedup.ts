/**
 * Cheap deterministic dedup. No LLM/embeddings — for our scale (~2000
 * questions) bigram Jaccard is fast (sub-ms per check), interpretable,
 * and avoids spending NaN budget on dedup.
 *
 * In addition to bigram-Jaccard surface similarity, we cap how many
 * accepted questions may share the same `(norm, article)` primary
 * fingerprint. The pilot 50 review surfaced cases where two questions
 * about the same article passed Jaccard because the surface words
 * differed enough — but they were redundant for retrieval evaluation.
 *
 * If quality demands, swap the surface check for embedding-based dedup
 * later (the interface stays the same).
 */

import type { DedupAgent } from "./types.ts";

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_MAX_PER_ARTICLE = 1;

function normalize(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function bigrams(text: string): Set<string> {
	const words = normalize(text).split(" ").filter(Boolean);
	const grams = new Set<string>();
	for (let i = 0; i + 1 < words.length; i++)
		grams.add(`${words[i]} ${words[i + 1]}`);
	if (words.length === 1) grams.add(words[0]!); // tiny questions
	return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}

function articleKey(primary: { norm: string; article: string }): string {
	return `${primary.norm}#${primary.article}`;
}

export interface DedupOptions {
	threshold?: number; // ≥ this Jaccard counts as duplicate
	seed?: Iterable<string>; // pre-existing accepted questions
	/**
	 * Maximum number of accepted questions that may share the same
	 * `(norm, article)` primary fingerprint. Defaults to 1 — i.e. one
	 * question per article. Only counts the PRIMARY expected article;
	 * alternatives don't increment the counter.
	 */
	maxQuestionsPerArticle?: number;
}

export function makeDedupAgent(opts: DedupOptions = {}): DedupAgent {
	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
	const maxPerArticle = opts.maxQuestionsPerArticle ?? DEFAULT_MAX_PER_ARTICLE;
	const seen: Array<{ text: string; grams: Set<string> }> = [];
	const articleCounts = new Map<string, number>();
	if (opts.seed) {
		for (const t of opts.seed) seen.push({ text: t, grams: bigrams(t) });
	}
	return {
		async isDuplicate(
			question: string,
			primary?: { norm: string; article: string },
		): Promise<boolean> {
			const grams = bigrams(question);
			for (const prev of seen) {
				if (jaccard(grams, prev.grams) >= threshold) return true;
			}
			if (primary) {
				const count = articleCounts.get(articleKey(primary)) ?? 0;
				if (count >= maxPerArticle) return true;
			}
			return false;
		},
		async add(
			question: string,
			primary?: { norm: string; article: string },
		): Promise<void> {
			seen.push({ text: question, grams: bigrams(question) });
			if (primary) {
				const key = articleKey(primary);
				articleCounts.set(key, (articleCounts.get(key) ?? 0) + 1);
			}
		},
	};
}
