/**
 * Copy the tables that cannot be rebuilt from the JSON cache / leyes repo into
 * a standalone SQLite file: AI-generated content (paid for) and subscriptions.
 *
 * Everything else in leyabierta.db is derived (`bun run ingest`), and
 * embeddings are too large for a daily copy (vectors-int8.bin is the int8
 * export). ask_log is deliberately excluded: backing it up would keep user
 * questions beyond the 90-day retention promised in /privacidad/.
 *
 * Reads the main DB read-only. Run inside the API container by
 * scripts/backup-generated-content.sh (daily, host cron).
 *
 * Usage: bun run packages/api/src/scripts/backup-generated-content.ts <out.db>
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";

export const BACKUP_TABLES = [
	"reform_summaries",
	"citizen_article_summaries",
	"citizen_tags",
	"omnibus_topics",
	"digests",
	"subscriptions",
	"subscribers",
	"norm_follows",
	"notified_reforms",
] as const;

export function backupGeneratedContent(
	src: Database,
	outPath: string,
): Record<string, number> {
	rmSync(outPath, { force: true });
	const dst = new Database(outPath, { create: true });
	const counts: Record<string, number> = {};
	try {
		for (const table of BACKUP_TABLES) {
			const ddl = src
				.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
				.get(table) as { sql: string } | null;
			if (!ddl) continue; // table not created yet on this DB
			dst.run(ddl.sql);
			const rows = src.query(`SELECT * FROM "${table}"`).all() as Record<
				string,
				unknown
			>[];
			if (rows.length > 0) {
				const cols = Object.keys(rows[0] as object);
				const insert = dst.prepare(
					`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
				);
				dst.transaction(() => {
					for (const row of rows) {
						insert.run(...(cols.map((c) => row[c]) as never[]));
					}
				})();
			}
			const copied = (
				dst.query(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }
			).n;
			if (copied !== rows.length) {
				throw new Error(`${table}: copied ${copied} of ${rows.length} rows`);
			}
			counts[table] = copied;
		}
	} finally {
		dst.close();
	}
	return counts;
}

if (import.meta.main) {
	const outPath = process.argv[2];
	if (!outPath) {
		console.error("Usage: backup-generated-content.ts <out.db>");
		process.exit(2);
	}
	const dbPath = process.env.DB_PATH ?? "data/leyabierta.db";
	if (!existsSync(dbPath)) {
		console.error(`DB not found: ${dbPath}`);
		process.exit(1);
	}
	const src = new Database(dbPath, { readonly: true });
	const counts = backupGeneratedContent(src, outPath);
	src.close();
	for (const [table, n] of Object.entries(counts)) console.log(`${table} ${n}`);
}
