/**
 * Bring `blocks_fts` (the article-level BM25 index behind `/v1/ask`) back in
 * step with `blocks`.
 *
 * Why it is needed: the API builds `blocks_fts` once, when the table is empty,
 * and until 2026-09-30 nothing refreshed it afterwards. Laws ingested after
 * that first build were missing from the RAG keyword search (168 norms on
 * 2026-09-30, including Real Decreto-ley 26/2026) and reformed articles were
 * indexed with their old text. `ingestJsonDir` now refreshes the norms it
 * ingests (`refreshBlocksFts`); this script repairs the backlog once.
 *
 * Detection compares every indexed article with `blocks` (same filter the API
 * uses: `precepto` with non-empty text): a norm is stale when an article is
 * missing, has different text or title, or is indexed but no longer eligible.
 * Only stale norms are re-indexed, in chunks (each chunk costs one scan of the
 * FTS table, since `norm_id` is UNINDEXED).
 *
 * Usage:
 *   bun run scripts/ad-hoc/refresh-blocks-fts.ts [--db FILE] [--apply]
 *   docker exec code-api-1 bun run scripts/ad-hoc/refresh-blocks-fts.ts \
 *     --db /data/leyabierta.db --apply
 *
 * Without --apply it only reports.
 */

import { Database } from "bun:sqlite";
import { refreshBlocksFts } from "../../packages/pipeline/src/db/index.ts";

const args = process.argv.slice(2);
const dbArg = args.indexOf("--db");
const dbPath =
	dbArg >= 0
		? args[dbArg + 1]
		: (process.env.DB_PATH ?? "./data/leyabierta.db");
const apply = args.includes("--apply");
const CHUNK = 2000;

if (!dbPath) throw new Error("--db needs a path");

const db = new Database(
	dbPath,
	apply ? { readwrite: true } : { readonly: true },
);
db.exec("PRAGMA busy_timeout = 60000");

const fingerprint = (title: string, normTitle: string, content: string) =>
	Bun.hash(`${title}\u0000${normTitle}\u0000${content}`).toString(36);

console.log(`Reading blocks_fts from ${dbPath}...`);
const indexed = new Map<string, string>();
for (const row of db
	.query<
		{
			norm_id: string;
			block_id: string;
			title: string;
			norm_title: string;
			content: string;
		},
		[]
	>("SELECT norm_id, block_id, title, norm_title, content FROM blocks_fts")
	.iterate()) {
	indexed.set(
		`${row.norm_id}\u0000${row.block_id}`,
		fingerprint(row.title, row.norm_title, row.content),
	);
}
console.log(`  ${indexed.size} indexed articles`);

const stale = new Set<string>();
let expected = 0;
for (const row of db
	.query<
		{
			norm_id: string;
			block_id: string;
			title: string;
			norm_title: string;
			content: string;
		},
		[]
	>(
		`SELECT b.norm_id, b.block_id, b.title, n.title AS norm_title, b.current_text AS content
		 FROM blocks b JOIN norms n ON n.id = b.norm_id
		 WHERE b.block_type = 'precepto' AND b.current_text != ''`,
	)
	.iterate()) {
	expected++;
	const key = `${row.norm_id}\u0000${row.block_id}`;
	const have = indexed.get(key);
	if (have !== fingerprint(row.title, row.norm_title, row.content)) {
		stale.add(row.norm_id);
	}
	indexed.delete(key);
}
// Whatever is left is indexed but no longer an eligible article.
for (const key of indexed.keys()) stale.add(key.split("\u0000")[0]!);

console.log(`  ${expected} eligible articles in blocks`);
console.log(`  ${indexed.size} indexed articles no longer eligible`);
console.log(`Stale norms: ${stale.size}`);
const sample = [...stale].slice(0, 10);
if (sample.length > 0) console.log(`  e.g. ${sample.join(", ")}`);

if (!apply) {
	console.log("Dry run — pass --apply to re-index them.");
	process.exit(0);
}

const ids = [...stale];
let written = 0;
for (let i = 0; i < ids.length; i += CHUNK) {
	const chunk = ids.slice(i, i + CHUNK);
	const t0 = performance.now();
	written += refreshBlocksFts(db, chunk) ?? 0;
	console.log(
		`  [${Math.min(i + CHUNK, ids.length)}/${ids.length}] ${((performance.now() - t0) / 1000).toFixed(1)}s`,
	);
}
const total = db
	.query<{ n: number }, []>("SELECT count(*) AS n FROM blocks_fts")
	.get()?.n;
console.log(
	`Done: ${written} articles re-indexed; blocks_fts now has ${total} rows (expected ${expected}).`,
);
