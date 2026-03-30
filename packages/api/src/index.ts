/**
 * Ley Libre API — Elysia server.
 *
 * Serves legislative data from SQLite + Git.
 */

import { Database } from "bun:sqlite";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { createSchema } from "@leylibre/pipeline";
import { Elysia } from "elysia";
import { lawRoutes } from "./routes/laws.ts";
import { LruCache } from "./services/cache.ts";
import { DbService } from "./services/db.ts";
import { GitService } from "./services/git.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/leylibre.db";
const REPO_PATH = process.env.REPO_PATH ?? "../leyes-es";
const PORT = Number(process.env.PORT ?? 3000);

// Initialize services
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
createSchema(db);

const dbService = new DbService(db);
const gitService = new GitService(REPO_PATH);
const diffCache = new LruCache<string>(500);

const app = new Elysia()
	.use(cors())
	.use(
		swagger({
			documentation: {
				info: {
					title: "Ley Libre API",
					version: "0.1.0",
					description:
						"API REST para legislación española consolidada. Fuente: Agencia Estatal BOE.",
				},
			},
		}),
	)
	.use(lawRoutes(dbService, gitService, diffCache))
	.get("/health", () => ({
		status: "ok",
		laws: dbService.searchLaws(undefined, {}, 0, 0).total,
	}))
	.listen(PORT);

console.log(`Ley Libre API running on http://localhost:${PORT}`);
console.log(`Swagger docs: http://localhost:${PORT}/swagger`);

export type App = typeof app;
