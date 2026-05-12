/**
 * Build a candidate gold-eval dataset from the prod `ask_log` table.
 *
 * Strategy:
 *  1. Pick distinct questions by popularity (top N most-asked).
 *  2. For each question, pick the BEST answer (highest citations_count).
 *  3. Parse inline citations like [BOE-A-1999-21568, Artículo vigésimo] from
 *     the answer text to extract candidate `expectedNorms`.
 *  4. Write a JSON file with these candidate pairs. Consensus validation runs
 *     in a separate step (see validate-gold-eval-consensus.ts).
 *
 * Usage:
 *   bun packages/api/research/ab/build-gold-eval-from-asklog.ts \
 *     [--top 200] \
 *     [--min-citations 2] \
 *     [--out packages/api/research/datasets/gold-eval-asklog-candidates.json]
 */

import { Database } from "bun:sqlite";
import { isAbsolute, join } from "node:path";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const repoRoot = join(import.meta.dir, "../../../../");
function resolvePath(p: string): string {
	return isAbsolute(p) ? p : join(repoRoot, p);
}

const topN = Number(flag("top") ?? "200");
const minCitations = Number(flag("min-citations") ?? "2");
const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(
			repoRoot,
			"packages/api/research/datasets/gold-eval-asklog-candidates.json",
		);

const db = new Database(join(repoRoot, "data/leyabierta.db"), { readonly: true });

interface Row {
	question: string;
	answer: string;
	citations_count: number;
	freq: number;
}

// Pick distinct questions by popularity, taking the best (most-cited, latest)
// answer for each. We dedup on the normalized question text.
const rows = db
	.query<Row, [number, number]>(
		`
		SELECT
			question,
			answer,
			citations_count,
			freq
		FROM (
			SELECT
				question,
				answer,
				citations_count,
				ROW_NUMBER() OVER (PARTITION BY question ORDER BY citations_count DESC, created_at DESC) AS rn,
				COUNT(*) OVER (PARTITION BY question) AS freq
			FROM ask_log
			WHERE declined = 0
			  AND citations_count >= ?
			  AND answer IS NOT NULL
		) WHERE rn = 1
		ORDER BY freq DESC, citations_count DESC
		LIMIT ?
		`,
	)
	.all(minCitations, topN);

console.log(`Loaded ${rows.length} distinct popular questions.`);

// Norm-id regex covers state (BOE-A-YYYY-NNNNN) + regional bulletins
// (BOA-d-, BOJA-b-, BOJA-h-, DOGV-f-, BORM-s-, BOCL-h-, etc.) used in the DB.
const normIdRe = /(?:BOE|BOA|BOJA|BOC|BOCL|BOCM|BOE|BOIB|BON|BOPA|BOPV|BORM|DOG|DOGC|DOGV|DOE|DOCM)[-_][A-Za-z]+[-_]\d{4}[-_]\d+/g;

// Article-suffix regex for inline citations: ", Artículo N]"
// We keep only the norm-id part (article-level matching is out of scope for
// this eval — we measure norm-level retrieval).

interface Candidate {
	id: string;
	question: string;
	expectedNorms: string[];
	source: {
		freq: number;
		citationsCount: number;
		answerExcerpt: string;
	};
}

function uniq<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}

function hashId(q: string): string {
	// Use a stable short hash from the question text.
	const hasher = new Bun.CryptoHasher("sha1");
	hasher.update(q);
	return `qg_${hasher.digest("hex").slice(0, 8)}`;
}

const candidates: Candidate[] = [];
let skippedNoCitations = 0;

for (const r of rows) {
	const matches = [...r.answer.matchAll(normIdRe)].map((m) => m[0]);
	const norms = uniq(matches);
	if (norms.length === 0) {
		skippedNoCitations++;
		continue;
	}
	candidates.push({
		id: hashId(r.question),
		question: r.question,
		expectedNorms: norms,
		source: {
			freq: r.freq,
			citationsCount: r.citations_count,
			answerExcerpt: r.answer.slice(0, 300),
		},
	});
}

console.log(`Skipped (no parseable citations): ${skippedNoCitations}`);
console.log(`Candidates written: ${candidates.length}`);

// Quick stats
const expectedCounts = candidates.map((c) => c.expectedNorms.length);
const avgExpected = expectedCounts.reduce((s, x) => s + x, 0) / candidates.length;
console.log(
	`Avg expectedNorms per query: ${avgExpected.toFixed(2)} (min=${Math.min(...expectedCounts)}, max=${Math.max(...expectedCounts)})`,
);

await Bun.write(
	outPath,
	JSON.stringify({ results: candidates }, null, 2),
);
console.log(`Wrote → ${outPath}`);
