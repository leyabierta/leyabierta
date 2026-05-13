#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LEYES_DIR = resolve(import.meta.dir, "../../../../leyes/es");

// Aligned citation entry produced by enrich-citations.ts.
// raw, boe_a_id, and article are in the same index position as citations_raw[i].
type CitationEntry = {
	raw: string;
	boe_a_id: string | null;
	article: string | null;
};

type Entry = {
	id: string;
	source: string;
	question: string;
	answer: string;
	norms: {
		citations_raw: string[];
		// New aligned schema: use this for citation→BOE-ID lookup.
		citations?: CitationEntry[];
		// Backwards-compat: deduplicated resolved IDs, order not guaranteed.
		boe_a_ids: string[];
	};
	metadata: {
		domain?: string;
		jurisdiction?: string;
		date?: string;
		organo?: string;
	};
};

type Verified = {
	id: string;
	source: string;
	domain?: string;
	question: string;
	answer_snippet: string;
	cited_law_id: string;
	cited_article: string | null;
	article_text: string | null;
	article_found: boolean;
	citation_raw: string;
};

function parseArticle(citation: string): string | null {
	// "Ley 37/1992 art. 90-" → "90"
	// "Ley 37/1992, art. 90.1" → "90.1"
	// "RD 1624/1992 art. 79" → "79"
	const m = citation.match(
		/art(?:[íi]culo|\.)\s*([0-9]+(?:[.\s]?(?:bis|ter|quater))?(?:\.[0-9]+)?)/i,
	);
	if (!m?.[1]) return null;
	return m[1].trim().replace(/\s+/g, " ");
}

function extractArticle(markdown: string, articleNum: string): string | null {
	// Find header line: "##### Artículo N. Title." or "##### Artículo N bis. Title."
	const lines = markdown.split("\n");
	const headerRe = new RegExp(
		`^#{2,6}\\s*Art[íi]culo\\s+${articleNum.replace(/\./g, "\\.").replace(/\s+/g, "\\s+")}\\b`,
		"i",
	);
	let startIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (headerRe.test(lines[i] ?? "")) {
			startIdx = i;
			break;
		}
	}
	if (startIdx === -1) return null;
	// Take until next "Artículo" header at same or higher level, or any ##/### heading
	let endIdx = lines.length;
	for (let i = startIdx + 1; i < lines.length; i++) {
		if (/^#{2,6}\s*Art[íi]culo\s+/i.test(lines[i] ?? "")) {
			endIdx = i;
			break;
		}
		if (/^#{1,4}\s+\S/.test(lines[i] ?? "")) {
			// section / chapter / título boundary
			endIdx = i;
			break;
		}
	}
	return lines.slice(startIdx, endIdx).join("\n").trim();
}

function loadEntries(path: string): Entry[] {
	const text = readFileSync(path, "utf8");
	return text
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Entry);
}

function stratifiedSample(entries: Entry[], n: number, seed = 42): Entry[] {
	// Only entries where at least one citation has both a resolved boe_a_id AND an article number.
	// Prefer the aligned citations[] schema; fall back to citations_raw scanning for old data.
	const usable = entries.filter((e) => {
		if (e.norms.citations) {
			// New schema: need at least one citation with both boe_a_id and article resolved.
			return e.norms.citations.some(
				(c) => c.boe_a_id !== null && c.article !== null,
			);
		}
		// Legacy schema fallback.
		if (!e.norms.boe_a_ids.length) return false;
		return e.norms.citations_raw.some((c) => parseArticle(c) !== null);
	});
	// Bucket by domain
	const buckets = new Map<string, Entry[]>();
	for (const e of usable) {
		const key = e.metadata.domain || "unknown";
		if (!buckets.has(key)) buckets.set(key, []);
		buckets.get(key)?.push(e);
	}
	// Deterministic shuffle
	let rng = seed;
	const rand = () => {
		rng = (rng * 1664525 + 1013904223) >>> 0;
		return rng / 0xffffffff;
	};
	for (const arr of buckets.values()) arr.sort(() => rand() - 0.5);

	const perBucket = Math.max(1, Math.floor(n / buckets.size));
	const out: Entry[] = [];
	for (const [, arr] of buckets) out.push(...arr.slice(0, perBucket));
	return out.slice(0, n);
}

function pickCitation(
	e: Entry,
): { raw: string; article: string; boeId: string } | null {
	// Use the aligned citations[] schema when available (new data produced by enrich-citations.ts).
	// This guarantees each citation's boe_a_id is paired with the correct raw string —
	// no more index-0 heuristic that collapses multiple laws to one BOE-A ID.
	if (e.norms.citations) {
		for (const c of e.norms.citations) {
			if (c.boe_a_id !== null && c.article !== null) {
				return { raw: c.raw, article: c.article, boeId: c.boe_a_id };
			}
		}
		return null;
	}

	// Legacy schema fallback (data enriched before the schema upgrade).
	// WARNING: this is inherently imprecise — boe_a_ids[0] may not correspond to
	// the citation with the article number. Re-enrich with enrich-citations.ts to fix.
	for (const raw of e.norms.citations_raw) {
		const article = parseArticle(raw);
		if (!article) continue;
		const boeId = e.norms.boe_a_ids[0];
		if (boeId) {
			return { raw, article, boeId };
		}
	}
	return null;
}

function verify(entries: Entry[]): Verified[] {
	const out: Verified[] = [];
	for (const e of entries) {
		const pick = pickCitation(e);
		if (!pick) continue;
		const lawPath = resolve(LEYES_DIR, `${pick.boeId}.md`);
		let articleText: string | null = null;
		let found = false;
		if (existsSync(lawPath)) {
			const md = readFileSync(lawPath, "utf8");
			articleText = extractArticle(md, pick.article);
			found = articleText !== null;
		}
		out.push({
			id: e.id,
			source: e.source,
			domain: e.metadata.domain,
			question: e.question,
			answer_snippet: e.answer.slice(0, 600),
			cited_law_id: pick.boeId,
			cited_article: pick.article,
			article_text: articleText ? articleText.slice(0, 2500) : null,
			article_found: found,
			citation_raw: pick.raw,
		});
	}
	return out;
}

const inputPath =
	process.argv[2] || "/Volumes/Disco1TB/datasets/leyabierta/enriched/dgt.jsonl";
const outputPath = process.argv[3] || "/tmp/verify-gold-sample.jsonl";
const N = Number.parseInt(process.argv[4] || "30", 10);
// Seed for deterministic shuffle. Pass a different value to sample a different subset.
// Default 42 (original). Use 99 (or any other value) for a fresh Opus judgment set.
const SEED = Number.parseInt(process.argv[5] || "42", 10);

console.error(`Loading ${inputPath}…`);
const entries = loadEntries(inputPath);
console.error(`Loaded ${entries.length} entries.`);
const sample = stratifiedSample(entries, N, SEED);
console.error(`Sampled ${sample.length} (stratified by domain, seed=${SEED}).`);
const verified = verify(sample);
console.error(
	`Verified ${verified.length} (article found: ${verified.filter((v) => v.article_found).length}).`,
);
writeFileSync(outputPath, verified.map((v) => JSON.stringify(v)).join("\n"));
console.error(`Wrote ${outputPath}`);
