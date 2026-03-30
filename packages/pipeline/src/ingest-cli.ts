/**
 * Ingest cached JSON files into SQLite.
 *
 * Usage: bun run packages/pipeline/src/ingest-cli.ts [db-path] [json-dir]
 */

import { ingestJsonDir, openDatabase } from "./db/index.ts";

const dbPath = process.argv[2] || "./data/leyabierta.db";
const jsonDir = process.argv[3] || "./data/json";

async function main() {
	console.log(`Opening database: ${dbPath}`);
	const db = openDatabase(dbPath);

	console.log(`Ingesting JSON files from: ${jsonDir}\n`);
	const result = await ingestJsonDir(db, jsonDir);

	console.log("─── Ingest Summary ───");
	console.log(`Norms:    ${result.normsInserted}`);
	console.log(`Blocks:   ${result.blocksInserted}`);
	console.log(`Versions: ${result.versionsInserted}`);
	console.log(`Reforms:  ${result.reformsInserted}`);

	if (result.errors.length > 0) {
		console.error(`\nErrors (${result.errors.length}):`);
		for (const err of result.errors) {
			console.error(`  • ${err}`);
		}
	}

	db.close();
	console.log("\nDone.");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
