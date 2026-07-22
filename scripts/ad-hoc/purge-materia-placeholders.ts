/**
 * Cleanup for the 2026-07-22 materias incident.
 *
 * Why it was needed: nothing in the pipeline ever ran download-auxiliar, so
 * data/auxiliar/materias.json never existed on the server and
 * ingest-analisis-cli.ts wrote a fabricated "[código NNNN]" string for every
 * ELI materia code it could not resolve. Those strings reached the `materias`
 * table, the JSON cache (data/json/<id>.json -> analisis.materias) and, via
 * `bun run pipeline rebuild`, the frontmatter of the published leyes repo.
 *
 * Root cause fixed in the same change:
 *   - scripts/daily-pipeline.sh Step 2.5 refreshes the lookup every run.
 *   - packages/pipeline/src/download-auxiliar-cli.ts now exits non-zero on
 *     failure and writes atomically, so the cache can't be silently lost.
 *   - packages/pipeline/src/ingest-analisis-cli.ts never fabricates a name.
 *
 * This script only removes the contamination that already landed. It does NOT
 * write to the leyes repo (CLAUDE.md, "Rules for ad-hoc scripts that write to
 * leyes"): run `bun run pipeline rebuild` afterwards so the markdown is
 * regenerated from the cleaned JSON cache.
 *
 * Idempotent: a second run matches 0 rows and 0 files.
 *
 * HOW TO RUN IN PRODUCTION — `scripts/` is not part of the Docker image
 * (the Dockerfile only copies packages/ + tsconfig.json), and /data is owned
 * by uid 1001 inside the container, so do not run this from the host against
 * the bind mount. Copy it in and exec it:
 *
 *   docker cp scripts/ad-hoc/purge-materia-placeholders.ts code-api-1:/tmp/
 *   docker exec code-api-1 bun run /tmp/purge-materia-placeholders.ts \
 *     /data/leyabierta.db --json /data/json --dry-run
 *   # then re-run without --dry-run, and finally:
 *   docker exec code-api-1 bun run pipeline rebuild
 *
 * Usage: purge-materia-placeholders.ts [db-path] [--json DIR] [--dry-run]
 */

import { Database } from "bun:sqlite";

// SQL pattern and JS pattern must stay in sync. In SQLite LIKE, `[` is a
// literal (unlike GLOB, where it opens a character class), so this is safe.
const SQL_PATTERN = "[código %]";
const PLACEHOLDER_RE = /^\[código \d+\]$/u;

const dbPath =
	process.argv[2] && !process.argv[2].startsWith("--")
		? process.argv[2]
		: "./data/leyabierta.db";
const dryRun = process.argv.includes("--dry-run");
const jsonDir = process.argv.includes("--json")
	? process.argv[process.argv.indexOf("--json") + 1]!
	: "./data/json";

async function main() {
	const db = new Database(dbPath);

	// -- 1. The materias table --
	// Only the affected norm_ids are pulled into memory (the container is
	// RAM-capped); the delete itself is a single set-based statement.
	const affected = db
		.query<{ norm_id: string }, [string]>(
			"SELECT DISTINCT norm_id FROM materias WHERE materia LIKE ?",
		)
		.all(SQL_PATTERN)
		.map((r) => r.norm_id);

	const count = db
		.query<{ n: number }, [string]>(
			"SELECT COUNT(*) AS n FROM materias WHERE materia LIKE ?",
		)
		.get(SQL_PATTERN)!.n;

	console.log(
		`materias table: ${count} placeholder rows across ${affected.length} norms` +
			(dryRun ? " (dry-run, not deleting)" : ""),
	);

	if (!dryRun && count > 0) {
		db.run("DELETE FROM materias WHERE materia LIKE ?", [SQL_PATTERN]);
	}

	db.close();

	// -- 2. The JSON cache --
	let jsonScanned = 0;
	let jsonChanged = 0;

	for (const normId of affected) {
		const jsonPath = `${jsonDir}/${normId}.json`;
		const file = Bun.file(jsonPath);
		if (!(await file.exists())) continue;
		jsonScanned++;

		const data = await file.json();
		const materias: unknown = data?.analisis?.materias;
		if (!Array.isArray(materias)) continue;

		const cleaned = materias.filter(
			(m) => typeof m !== "string" || !PLACEHOLDER_RE.test(m),
		);
		if (cleaned.length === materias.length) continue;

		jsonChanged++;
		if (dryRun) continue;

		// Keep the `analisis` key even if materias ends up empty: that is the
		// same shape ingest-analisis produces for a norm with notas/refs only,
		// and deleting the key would change the contract for every consumer of
		// the JSON cache for no benefit.
		data.analisis.materias = cleaned;
		await Bun.write(jsonPath, JSON.stringify(data, null, 2));
	}

	console.log(
		`JSON cache: ${jsonChanged}/${jsonScanned} files cleaned` +
			(dryRun ? " (dry-run, not writing)" : ""),
	);

	if (!dryRun && (count > 0 || jsonChanged > 0)) {
		console.log(
			"\nDone. Run `bun run pipeline rebuild` to regenerate the leyes " +
				"markdown frontmatter from the cleaned JSON cache.",
		);
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
