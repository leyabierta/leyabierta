/**
 * Ley Abierta API — Elysia server.
 *
 * Serves legislative data from SQLite + Git.
 */

import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { cors } from "@elysiajs/cors";
import { createSchema } from "@leyabierta/pipeline";
import { Elysia } from "elysia";
import { alertRoutes } from "./routes/alerts.ts";
import { askRoutes } from "./routes/ask.ts";
import { lawRoutes } from "./routes/laws.ts";
import { omnibusRoutes } from "./routes/omnibus.ts";
import { reformRoutes } from "./routes/reforms.ts";
import { LruCache } from "./services/cache.ts";
import { CitizenSummaryService } from "./services/citizen-summary.ts";
import { DbService } from "./services/db.ts";
import { GitService } from "./services/git.ts";
import { RagPipeline } from "./services/rag/pipeline.ts";
import { flushTraces } from "./services/rag/tracing.ts";
import { createRateLimiter, getClientIp } from "./services/rate-limiter.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";
const REPO_PATH = process.env.REPO_PATH ?? "../leyes";
const PORT = Number(process.env.PORT ?? 3000);

// Initialize services
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA cache_size = -64000"); // 64MB page cache
db.exec("PRAGMA mmap_size = 268435456"); // 256MB memory-mapped I/O
db.exec("PRAGMA temp_store = MEMORY"); // temp tables in RAM
createSchema(db);

const dbService = new DbService(db);
const gitService = new GitService(REPO_PATH);
const diffCache = new LruCache<string>(5000);
const citizenSummaryService = new CitizenSummaryService(db);

// RAG pipeline (optional — only if API key and embeddings are available)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const EMBEDDINGS_PATH =
	process.env.EMBEDDINGS_PATH ?? "./data/spike-embeddings-gemini-embedding-2";
const ragPipeline = OPENROUTER_API_KEY
	? new RagPipeline(db, OPENROUTER_API_KEY, EMBEDDINGS_PATH)
	: null;

const CORS_ORIGINS = process.env.CORS_ORIGINS
	? process.env.CORS_ORIGINS.split(",")
	: [
			"https://leyabierta.es",
			"https://www.leyabierta.es",
			"http://localhost:4321",
			"http://localhost:3000",
		];

// ── Request timing ──────────────────────────────────────────────────
const reqTimings = new WeakMap<Request, number>();

// ── Rate limiting ────────────────────────────────────────────────────
const searchLimiter = createRateLimiter(30); // 30 req/min per IP for search
const generalLimiter = createRateLimiter(60); // 60 req/min per IP for other endpoints
const askLimiter = createRateLimiter(5); // 5 req/min per IP for RAG (costs money)
const API_BYPASS_KEY = process.env.API_BYPASS_KEY ?? "";

// ── Graceful shutdown ───────────────────────────────────────────────
let isShuttingDown = false;

function shutdown(signal: string) {
	isShuttingDown = true;
	console.log(`${signal} received, shutting down gracefully...`);
	// Wait 30s for in-flight requests + fire-and-forget LLM calls to complete
	setTimeout(async () => {
		await flushTraces();
		db.close();
		process.exit(0);
	}, 30_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const app = new Elysia()
	.use(cors({ origin: CORS_ORIGINS }))
	.onBeforeHandle(({ request, set, path }) => {
		reqTimings.set(request, performance.now());
		// Reject new requests during shutdown
		if (isShuttingDown) {
			set.status = 503;
			set.headers.Connection = "close";
			return { error: "Server is shutting down" };
		}
		// Rate limiting (skip /health and trusted clients with bypass key)
		const apiKey = request.headers.get("x-api-key") ?? "";
		const hasBypass =
			API_BYPASS_KEY &&
			apiKey.length === API_BYPASS_KEY.length &&
			timingSafeEqual(Buffer.from(apiKey), Buffer.from(API_BYPASS_KEY));
		if (path !== "/health" && !hasBypass) {
			const ip = getClientIp(request);
			const isAsk = path === "/v1/ask";
			const isSearch =
				path === "/v1/laws" && new URL(request.url).searchParams.has("q");
			const limiter = isAsk
				? askLimiter
				: isSearch
					? searchLimiter
					: generalLimiter;
			if (limiter.isLimited(ip)) {
				set.status = 429;
				set.headers["Retry-After"] = "60";
				return { error: "Too many requests" };
			}
		}
	})
	.onAfterHandle(({ request, set, path }) => {
		set.headers["X-Content-Type-Options"] = "nosniff";
		set.headers["X-Frame-Options"] = "DENY";
		set.headers["X-Robots-Tag"] = "noindex";
		set.headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
		// Cache read-only endpoints at Cloudflare edge; skip for health/alerts
		if (
			!set.headers["Cache-Control"] &&
			!path.startsWith("/v1/alerts") &&
			path !== "/health"
		) {
			set.headers["Cache-Control"] =
				"public, max-age=0, s-maxage=3600, must-revalidate";
		}
		// Structured request logging (skip /health)
		if (path !== "/health") {
			const start = reqTimings.get(request);
			const ms = start ? Math.round(performance.now() - start) : 0;
			if (start) reqTimings.delete(request);
			console.log(
				JSON.stringify({
					method: request.method,
					path,
					status: set.status ?? 200,
					ms,
				}),
			);
		}
	});

const { swagger } = await import("@elysiajs/swagger");
app.use(
	swagger({
		documentation: {
			info: {
				title: "Ley Abierta API",
				version: "0.1.0",
				description:
					"REST API for consolidated Spanish legislation. Source: Agencia Estatal BOE.",
				contact: {
					name: "Ley Abierta",
					url: "https://github.com/leyabierta/leyabierta",
				},
				license: {
					name: "MIT",
					url: "https://github.com/leyabierta/leyabierta/blob/main/LICENSE",
				},
			},
			tags: [
				{
					name: "Leyes",
					description:
						"Search, detail, versions, diff, and references for laws",
				},
				{
					name: "Reformas",
					description: "Personal reforms, public changelog, and reform details",
				},
				{
					name: "Ómnibus",
					description: "Omnibus law detection with per-topic breakdowns",
				},
				{
					name: "Alertas",
					description: "Email alert subscriptions and confirmation",
				},
				{
					name: "Preguntas",
					description:
						"Ask questions about Spanish legislation in plain language",
				},
				{
					name: "Sistema",
					description: "Health checks and internal endpoints",
				},
			],
		},
	}),
);

app
	.use(lawRoutes(dbService, gitService, diffCache, citizenSummaryService))
	.use(alertRoutes(dbService))
	.use(reformRoutes(dbService))
	.use(omnibusRoutes(dbService))
	.use(askRoutes(ragPipeline))
	.get(
		"/health",
		() => {
			const dbPath = process.env.DB_PATH || "./data/leyabierta.db";
			let lastIngest: string | null = null;
			try {
				const stat = Bun.file(dbPath);
				lastIngest = new Date(stat.lastModified).toISOString();
			} catch {
				/* ignore */
			}
			return {
				status: "ok",
				version: process.env.GIT_SHA ?? "dev",
				laws: dbService.searchLaws(undefined, {}, 0, 0).total,
				last_ingest: lastIngest,
			};
		},
		{
			detail: {
				summary: "Health check",
				description: "Returns API status, version, and total law count.",
				tags: ["Sistema"],
			},
		},
	)
	.get(
		"/og/:id",
		async ({ params, set }) => {
			const id = params.id.replace(/[^a-zA-Z0-9_-]/g, "");
			if (!id) {
				set.status = 400;
				return { error: "Missing id" };
			}
			const ogDir =
				process.env.OG_IMAGES_DIR || join(process.cwd(), "og-images");
			const filePath = join(ogDir, `${id}.png`);
			const file = Bun.file(filePath);
			if (!(await file.exists())) {
				set.status = 404;
				return { error: "OG image not found" };
			}
			return new Response(file, {
				headers: {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=604800",
				},
			});
		},
		{
			detail: {
				summary: "Get OG image for a law",
				tags: ["Sistema"],
			},
		},
	)
	.listen(PORT);

console.log(`Ley Abierta API running on http://localhost:${PORT}`);
console.log(`Swagger docs: http://localhost:${PORT}/swagger`);

export type App = typeof app;
