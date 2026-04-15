/**
 * Database module entry point.
 *
 * Opens (or creates) the SQLite database, ensures the schema
 * exists, and re-exports ingest utilities.
 */

import { Database } from "bun:sqlite";
import { createSchema } from "./schema.ts";

export {
	type IngestResult,
	ingestJsonDir,
	normalizeArticle,
	validateNorm,
} from "./ingest.ts";
export { createSchema } from "./schema.ts";

const DEFAULT_DB_PATH = "./data/leyabierta.db";

export function openDatabase(path: string = DEFAULT_DB_PATH): Database {
	const db = new Database(path, { create: true });
	createSchema(db);
	return db;
}
