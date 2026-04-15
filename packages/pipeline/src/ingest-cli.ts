/**
 * Ingest cached JSON files into SQLite.
 *
 * Usage:
 *   bun run ingest                                    # all norms (batched)
 *   bun run ingest BOE-A-2026-7442 BOE-A-2026-7558   # only these IDs
 *   bun run ingest [db-path] [json-dir] [ID...]       # custom paths + IDs
 */

import { ingestJsonDir, openDatabase } from "./db/index.ts";

const args = process.argv.slice(2);

// Parse positional args: first two may be db-path and json-dir,
// remaining args that look like norm IDs (contain uppercase + digits + hyphens)
let dbPath = "./data/leyabierta.db";
let jsonDir = "./data/json";
const ids: string[] = [];

for (const arg of args) {
	if (arg.endsWith(".db")) {
		dbPath = arg;
	} else if (arg.includes("/") || arg === "." || arg.startsWith("./")) {
		jsonDir = arg;
	} else {
		// Treat as a norm ID
		ids.push(arg);
	}
}

async function main() {
	console.log(`Opening database: ${dbPath}`);
	const db = openDatabase(dbPath);

	if (ids.length > 0) {
		console.log(`Ingesting ${ids.length} specific norm(s): ${ids.join(", ")}`);
	} else {
		console.log(`Ingesting all JSON files from: ${jsonDir}`);
	}
	console.log();

	const result = await ingestJsonDir(db, jsonDir, {
		ids: ids.length > 0 ? ids : undefined,
	});

	const durationSec = (result.duration / 1000).toFixed(1);
	const normsPerSec =
		result.duration > 0
			? (result.normsInserted / (result.duration / 1000)).toFixed(1)
			: "N/A";

	console.log("\n─── Ingest Summary ───");
	console.log(`Norms:    ${result.normsInserted}`);
	console.log(`Blocks:   ${result.blocksInserted}`);
	console.log(`Versions: ${result.versionsInserted}`);
	console.log(`Reforms:  ${result.reformsInserted}`);
	console.log(`Duration: ${durationSec}s (${normsPerSec} norms/s)`);

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
