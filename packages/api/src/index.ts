/**
 * Ley Abierta API — Elysia server.
 *
 * Serves legislative data from SQLite + Git.
 */

import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { cors } from "@elysiajs/cors";
import { createSchema } from "@leyabierta/pipeline";
import { Elysia } from "elysia";
import { alertRoutes } from "./routes/alerts.ts";
import { askRoutes } from "./routes/ask.ts";
import { lawRoutes, type SearchResponse } from "./routes/laws.ts";
import { omnibusRoutes } from "./routes/omnibus.ts";
import { reformRoutes } from "./routes/reforms.ts";
import { statusRoutes } from "./routes/status.ts";
import { LruCache } from "./services/cache.ts";
import { CitizenSummaryService } from "./services/citizen-summary.ts";
import { DbService } from "./services/db.ts";
import { GitService } from "./services/git.ts";
import { HybridSearcherImpl } from "./services/hybrid-search.ts";
import { startMemProbe } from "./services/mem-probe.ts";
import { bm25HybridSearch } from "./services/rag/blocks-fts.ts";
import { RagPipeline } from "./services/rag/pipeline.ts";
import { EMBEDDING_MODEL_KEY } from "./services/rag/retrieval.ts";
import { flushTraces } from "./services/rag/tracing.ts";
import { getSharedVectorIndex } from "./services/rag/vector-index-singleton.ts";
import { vectorSearchPooled } from "./services/rag/vector-pool.ts";
import { createRateLimiter, getClientIp } from "./services/rate-limiter.ts";
import { StatusService } from "./services/status.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";
const REPO_PATH = process.env.REPO_PATH ?? "../leyes";
const PORT = Number(process.env.PORT ?? 3000);

// Initialize services
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// Larger caches keep blocks_fts pages warm between BM25 queries.
// vectors.bin is loaded into process memory on the first /v1/ask request
// (see embeddings.ts) and cached, so it no longer evicts OS page cache.
db.exec("PRAGMA cache_size = -256000"); // 256MB SQLite own cache
db.exec("PRAGMA mmap_size = 2147483648"); // 2GB mmap
db.exec("PRAGMA temp_store = MEMORY"); // temp tables in RAM
createSchema(db);

const dbService = new DbService(db);
const gitService = new GitService(REPO_PATH);
const diffCache = new LruCache<string>(5000);
// In-process search cache. Cloudflare edge handles most of the load via the
// default Cache-Control headers (s-maxage=3600), but a hot LRU absorbs the
// "edge cold" thundering-herd window after deploys, ingest, or container
// restarts. TTL of 5 min bounds staleness against the daily ingest job.
const searchCache = new LruCache<SearchResponse>(2000, 5 * 60 * 1000);
const citizenSummaryService = new CitizenSummaryService(db);

// RAG pipeline (optional — only if API key is available)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const RAG_DATA_DIR = process.env.RAG_DATA_DIR ?? "./data";
const statusService = new StatusService(db, RAG_DATA_DIR);
const ragPipeline = OPENROUTER_API_KEY
	? new RagPipeline(db, OPENROUTER_API_KEY, RAG_DATA_DIR)
	: null;
// Hybrid search for /v1/laws (Issue #40). Default retrieval mode for
// relevance-ranked free-text queries. If OPENROUTER_API_KEY is missing the
// route returns 503 — no silent fallback to BM25.
const hybridSearcher = OPENROUTER_API_KEY
	? new HybridSearcherImpl(db, OPENROUTER_API_KEY, RAG_DATA_DIR)
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
const askLimiter = createRateLimiter(20); // 20 req/min per IP for RAG (NaN is free; limit is concurrency not cost)
const API_BYPASS_KEY = process.env.API_BYPASS_KEY ?? "";

// ── Graceful shutdown ───────────────────────────────────────────────
let isShuttingDown = false;

function shutdown(signal: string) {
	isShuttingDown = true;
	// stderr is line-buffered in Bun; stdout may not flush before process.exit
	process.stderr.write(
		`[shutdown] ${signal} received at ${new Date().toISOString()} — draining for 30s\n`,
	);
	setTimeout(async () => {
		process.stderr.write("[shutdown] drain complete, exiting\n");
		await flushTraces();
		db.close();
		process.exit(0);
	}, 30_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("uncaughtException", (err) => {
	process.stderr.write(`[fatal] uncaughtException: ${err?.stack ?? err}\n`);
});
process.on("unhandledRejection", (reason) => {
	process.stderr.write(
		`[fatal] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`,
	);
});

// Persistent exit probes. The shutdown / fatal stderr writes above never
// surfaced in `docker logs`, so we also tap `exit` (fires for every exit
// path, including process.exit and natural event loop drain) and
// `beforeExit` (fires only when the loop drains naturally with no pending
// work — would indicate the HTTP server died silently). Each write goes to
// a file mounted on the persistent volume so it survives container restarts.
const EXIT_LOG = `${RAG_DATA_DIR}/api-exits.log`;
function probeWrite(line: string) {
	try {
		appendFileSync(EXIT_LOG, `${new Date().toISOString()} ${line}\n`);
	} catch {}
}
probeWrite(`[boot] pid=${process.pid} startedAt=${new Date().toISOString()}`);
process.on("beforeExit", (code) => {
	probeWrite(`[beforeExit] code=${code} — event loop drained naturally`);
	process.stderr.write(`[beforeExit] code=${code}\n`);
});
process.on("exit", (code) => {
	probeWrite(`[exit] code=${code}`);
});

// RSS vs cgroup-cap pressure probe — logs to stderr every 30s when busy.
startMemProbe();

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
			const isAsk = path === "/v1/ask" || path === "/v1/ask/stream";
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
	.use(
		lawRoutes(
			dbService,
			gitService,
			diffCache,
			citizenSummaryService,
			searchCache,
			hybridSearcher,
		),
	)
	.use(alertRoutes(dbService))
	.use(reformRoutes(dbService))
	.use(statusRoutes(statusService))
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
	);

// ── Vector index preload ─────────────────────────────────────────────
// Block startup on the vector index load so the port isn't bound until
// the ~1.9 GB int8 SharedArrayBuffer is fully populated. Eliminates the
// cold-start OOM window where 6 concurrent requests hit lazy-load
// simultaneously and pushed anon-rss past the cgroup cap (#99/#100/#101).
// Trade: ~30s delay before the new container accepts traffic. Acceptable
// — during that window traefik returns 502, which is the *same* failure
// mode as the OOM restart, but without killing the container.
// Gate: only preload when the API key is present (same gate as ragPipeline
// / hybridSearcher) and RAG_PRELOAD is not explicitly disabled.
let preloadedIndex: Awaited<ReturnType<typeof getSharedVectorIndex>> = null;
if (OPENROUTER_API_KEY && process.env.RAG_PRELOAD !== "false") {
	const t0 = performance.now();
	console.log("[preload] loading vector index…");
	try {
		preloadedIndex = await getSharedVectorIndex(
			db,
			EMBEDDING_MODEL_KEY,
			RAG_DATA_DIR,
		);
		const ms = Math.round(performance.now() - t0);
		console.log(`[preload] vector index ready in ${ms}ms`);
	} catch (err) {
		// Non-fatal: fall back to lazy loading on first request.
		process.stderr.write(
			`[preload] vector index failed to load: ${err instanceof Error ? err.message : err}\n`,
		);
	}
}

app.listen(PORT);

console.log(`Ley Abierta API running on http://localhost:${PORT}`);
console.log(`Swagger docs: http://localhost:${PORT}/swagger`);

// ── Vector pool + FTS warmup (fire-and-forget) ───────────────────────
// The preload above only maps `vectors-int8.bin` into SharedArrayBuffers.
// It does NOT start the Bun Worker pool that actually *serves* KNN
// queries (`vector-pool.ts`): that pool is built lazily inside
// `vectorSearchPooled` on the first real `/v1/laws` or `/v1/ask` request
// — dlopen(vector-simd) + spawning RAG_VECTOR_POOL_WORKERS workers, each
// opening its own readonly SQLite handle. On top of that, the FTS5
// indexes are cold in the OS page cache right after a container restart
// (PRAGMA mmap_size/cache_size only set the budget, they force no I/O).
// Doing both here moves that one-off cost off the first citizen request.
//
// Runs after app.listen() and is not awaited: the port is bound and
// /health answers before this starts. It reuses the index the preload
// already loaded — it never re-enters getSharedVectorIndex, so a failed
// preload cannot trigger a second (possibly index-rebuilding) load while
// the container is already serving traffic, nor burn the singleton's
// circuit-breaker budget.
//
// Everything is safe-to-fail and each step is isolated: a failure just
// means the first real request pays that part of the cold start, exactly
// as it does today.
if (preloadedIndex) {
	const idx = preloadedIndex;
	(async () => {
		// 1. Vector pool: dlopen + spawn workers + one full SIMD scan.
		//    The query must NOT be a zero vector: `cosine_topk_int8` in
		//    vector-simd.c bails out with `if (... || query_norm == 0.0f)
		//    return 0;` before touching the corpus, so a zero vector would
		//    warm the pool but skip the scan entirely. A deterministic
		//    non-zero vector exercises the real FFI + heap + memory-walk
		//    path without spending an embedding-API call.
		const vecT0 = performance.now();
		try {
			const probeQuery = new Float32Array(idx.dims);
			let seed = 0x9e3779b9;
			for (let i = 0; i < idx.dims; i++) {
				seed = (seed * 1664525 + 1013904223) >>> 0;
				probeQuery[i] = seed / 0xffffffff - 0.5;
			}
			const hits = await vectorSearchPooled(
				probeQuery,
				idx.meta,
				idx.vectors,
				idx.dims,
				200,
			);
			console.log(
				`[warmup] vector pool ready in ${Math.round(performance.now() - vecT0)}ms (${hits.length} throwaway hits)`,
			);
		} catch (err) {
			process.stderr.write(
				`[warmup] vector pool warmup skipped: ${err instanceof Error ? err.message : err}\n`,
			);
		}

		// 2. FTS pages. Two different indexes serve the two search paths and
		//    warming one does nothing for the other:
		//      - `/v1/laws?q=` → DbService.bm25RankedNormIds → `norms_fts`
		//        (+ the `norms` title LIKE pass). This is the path that
		//        produced the 30-40s cold outlier.
		//      - `/v1/ask` → dispatchBm25Stages → `blocks_fts` (article
		//        level). BM25 no longer goes through the worker pool
		//        (bm25-dispatch.ts, 2026-05-15), so it is warmed directly.
		//    Both calls are synchronous SQLite work on the main thread, so
		//    keep the queries narrow: avoid corpus-wide tokens like "ley"
		//    (docfreq 310k/435k in blocks_fts) which trigger the expensive
		//    OR traversal the token pruning exists to avoid.
		const ftsT0 = performance.now();
		try {
			dbService.searchLaws("permiso de paternidad", {}, 5, 0);
			bm25HybridSearch(db, "permiso de paternidad", ["baja", "paternidad"], 20);
			console.log(
				`[warmup] FTS pages warm in ${Math.round(performance.now() - ftsT0)}ms`,
			);
		} catch (err) {
			process.stderr.write(
				`[warmup] FTS warmup skipped: ${err instanceof Error ? err.message : err}\n`,
			);
		}
	})();
}

export type App = typeof app;
