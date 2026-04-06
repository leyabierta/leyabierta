/**
 * Ley Abierta API — Elysia server.
 *
 * Serves legislative data from SQLite + Git.
 */

import { Database } from "bun:sqlite";
import { cors } from "@elysiajs/cors";
import { createSchema } from "@leyabierta/pipeline";
import { Elysia } from "elysia";
import { alertRoutes } from "./routes/alerts.ts";
import { lawRoutes } from "./routes/laws.ts";
import { omnibusRoutes } from "./routes/omnibus.ts";
import { reformRoutes } from "./routes/reforms.ts";
import { LruCache } from "./services/cache.ts";
import { DbService } from "./services/db.ts";
import { GitService } from "./services/git.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";
const REPO_PATH = process.env.REPO_PATH ?? "../leyes";
const PORT = Number(process.env.PORT ?? 3000);

// Initialize services
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
createSchema(db);

const dbService = new DbService(db);
const gitService = new GitService(REPO_PATH);
const diffCache = new LruCache<string>(500);

const CORS_ORIGINS = process.env.CORS_ORIGINS
	? process.env.CORS_ORIGINS.split(",")
	: [
			"https://leyabierta.es",
			"https://www.leyabierta.es",
			"http://localhost:4321",
			"http://localhost:3000",
		];

const app = new Elysia()
	.use(cors({ origin: CORS_ORIGINS }))
	.onAfterHandle(({ set, path }) => {
		set.headers["X-Content-Type-Options"] = "nosniff";
		set.headers["X-Frame-Options"] = "DENY";
		set.headers["X-Robots-Tag"] = "noindex";
		set.headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
		// Cache read-only endpoints at Cloudflare edge; skip for health/alerts
		if (!set.headers["Cache-Control"] && !path.startsWith("/v1/alerts")) {
			set.headers["Cache-Control"] =
				"public, max-age=0, s-maxage=3600, must-revalidate";
		}
	});

if (process.env.NODE_ENV !== "production") {
	const { swagger } = await import("@elysiajs/swagger");
	app.use(
		swagger({
			documentation: {
				info: {
					title: "Ley Abierta API",
					version: "0.1.0",
					description:
						"API REST para legislación española consolidada. Fuente: Agencia Estatal BOE.",
				},
			},
		}),
	);
}

app
	.use(lawRoutes(dbService, gitService, diffCache))
	.use(alertRoutes(dbService))
	.use(reformRoutes(dbService))
	.use(omnibusRoutes(dbService))
	.get("/health", () => ({
		status: "ok",
		laws: dbService.searchLaws(undefined, {}, 0, 0).total,
	}))
	.listen(PORT);

console.log(`Ley Abierta API running on http://localhost:${PORT}`);
if (process.env.NODE_ENV !== "production") {
	console.log(`Swagger docs: http://localhost:${PORT}/swagger`);
}

export type App = typeof app;
