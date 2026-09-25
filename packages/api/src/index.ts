/**
 * Ley Abierta API — Elysia server.
 *
 * Serves legislative data from SQLite + Git.
 */

import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cors } from "@elysiajs/cors";
import { createSchema } from "@leyabierta/pipeline";
import { Elysia } from "elysia";
import { askRoutes } from "./routes/ask.ts";
import { lawRoutes, type SearchResponse } from "./routes/laws.ts";
import { omnibusRoutes } from "./routes/omnibus.ts";
import { reformRoutes } from "./routes/reforms.ts";
import { statusRoutes } from "./routes/status.ts";
import { errorResponse, structuredError } from "./services/api-errors.ts";
import { AskQuota, askLimitsFromEnv } from "./services/ask-quota.ts";
import { LruCache } from "./services/cache.ts";
import { defaultCacheControl } from "./services/cache-control.ts";
import { CitizenSummaryService } from "./services/citizen-summary.ts";
import { DbService } from "./services/db.ts";
import { GitService } from "./services/git.ts";
import { HybridSearcherImpl } from "./services/hybrid-search.ts";
import { startMemProbe } from "./services/mem-probe.ts";
import { createOpenApiDoc } from "./services/openapi-doc.ts";
import {
	createAskLogPurger,
	resolveAskLogRetentionDays,
} from "./services/rag/ask-log-retention.ts";
import { bm25HybridSearch } from "./services/rag/blocks-fts.ts";
import { RagPipeline } from "./services/rag/pipeline.ts";
import { EMBEDDING_MODEL_KEY } from "./services/rag/retrieval.ts";
import { flushTraces } from "./services/rag/tracing.ts";
import { getSharedVectorIndex } from "./services/rag/vector-index-singleton.ts";
import { vectorSearchPooled } from "./services/rag/vector-pool.ts";
import {
	createRateLimiter,
	getClientIp,
	hasBypassKey,
	rateLimitHeader,
	rateLimitPolicy,
} from "./services/rate-limiter.ts";
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
	? new RagPipeline(db, OPENROUTER_API_KEY, RAG_DATA_DIR, citizenSummaryService)
	: null;
// ask_log retention promised in /privacidad/ (ASK_LOG_RETENTION_DAYS, default
// 90). Wired here, in the API server only — not in RagPipeline — so eval and
// research scripts that build a RagPipeline on a local DB never silently
// delete rows. Purges at startup, then an hourly tick runs it at most once a
// day (retrying sooner if a run failed, e.g. SQLITE_BUSY during ingest).
const purgeAskLog = createAskLogPurger(
	db,
	resolveAskLogRetentionDays(process.env),
);
purgeAskLog();
setInterval(purgeAskLog, 60 * 60 * 1000).unref();
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

// Cheap, static, cacheable documents — exempt from the per-IP rate limiter
// like /health. Also closes the specific bug this fixes for /openapi.json:
// its handler self-calls into /swagger/json (services/openapi-doc.ts), and
// that internal Request has no CF-Connecting-IP, so without this exemption
// every caller's self-call would share one "unknown"-keyed bucket.
const RATE_LIMIT_EXEMPT_PATHS = new Set([
	"/health",
	"/openapi.json",
	"/swagger",
	"/swagger/json",
]);

// ── Rate limiting ────────────────────────────────────────────────────
const searchLimiter = createRateLimiter(30); // 30 req/min per IP for search
const generalLimiter = createRateLimiter(60); // 60 req/min per IP for other endpoints
const askLimiter = createRateLimiter(20); // 20 req/min per IP for RAG (each /v1/ask makes several external LLM calls)
const API_BYPASS_KEY = process.env.API_BYPASS_KEY ?? "";

// Question quota for /v1/ask and /v1/ask/stream (cost control): per person
// per minute and per day, plus a global daily cap. Counters live in a small
// dedicated SQLite file so they survive deploys; see services/ask-quota.ts.
const askQuota = ragPipeline
	? new AskQuota({
			limits: askLimitsFromEnv(),
			path:
				process.env.ASK_QUOTA_DB_PATH ?? join(dirname(DB_PATH), "ask-quota.db"),
		})
	: null;
if (askQuota) {
	const { perMinute, perDay, globalPerDay } = askQuota.limits;
	console.log(
		`[ask-quota] ${perMinute}/min and ${perDay}/day per person, ${globalPerDay}/day global`,
	);
	// Drop yesterday's counters and salt even if nobody asks today.
	setInterval(() => askQuota.purgeStale(), 60 * 60 * 1000).unref();
}

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
		askQuota?.close();
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

// Security headers, service-desc Link, cache policy and the request log line
// for every response. Runs from mapResponse and, for errors, from onError
// itself (see there). Idempotent per request: never logs twice.
const finalized = new WeakSet<Request>();
function finalizeResponse(
	request: Request,
	set: { headers: Record<string, string | number>; status?: number | string },
	path: string,
): void {
	if (finalized.has(request)) return;
	finalized.add(request);
	set.headers["X-Content-Type-Options"] = "nosniff";
	set.headers["X-Frame-Options"] = "DENY";
	set.headers["X-Robots-Tag"] = "noindex";
	set.headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
	// Discovery: point agents/tools at the OpenAPI spec from any response.
	set.headers.Link = '</openapi.json>; rel="service-desc"';
	// Cache read-only endpoints at Cloudflare edge; skip for health.
	// Errors get a short TTL or no-store — see services/cache-control.ts.
	if (!set.headers["Cache-Control"]) {
		const cacheControl = defaultCacheControl(path, set.status);
		if (cacheControl) set.headers["Cache-Control"] = cacheControl;
	}
	// Structured request logging (skip /health). A true 404 (no route
	// matched at all) never runs onBeforeHandle, so `start` is unset —
	// `ms` falls back to 0 rather than throwing.
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
}

const app = new Elysia()
	.use(
		cors({
			origin: CORS_ORIGINS,
			// Cross-origin JS can't read a response header unless it's listed
			// here (CORS-safelisted headers like Content-Type don't need this;
			// these are the ones we add ourselves for rate limiting/quota).
			exposeHeaders: [
				"RateLimit",
				"RateLimit-Policy",
				"X-RateLimit-Limit",
				"X-RateLimit-Remaining",
				"X-RateLimit-Reset",
				"Retry-After",
			],
		}),
	)
	.onBeforeHandle(({ request, set, path }) => {
		reqTimings.set(request, performance.now());
		// Reject new requests during shutdown
		if (isShuttingDown) {
			set.status = 503;
			set.headers.Connection = "close";
			return { error: "Server is shutting down" };
		}
		// Rate limiting (skip exempt paths and trusted clients with bypass key)
		if (
			!RATE_LIMIT_EXEMPT_PATHS.has(path) &&
			!hasBypassKey(request, API_BYPASS_KEY)
		) {
			const ip = getClientIp(request);
			const isAsk = path === "/v1/ask" || path === "/v1/ask/stream";
			const isSearch =
				path === "/v1/laws" && new URL(request.url).searchParams.has("q");
			const policyName = isAsk ? "ask" : isSearch ? "search" : "general";
			const limiter = isAsk
				? askLimiter
				: isSearch
					? searchLimiter
					: generalLimiter;
			const decision = limiter.consume(ip);
			// IETF draft-ietf-httpapi-ratelimit-headers: advisory on every
			// response, not just 429s, so a well-behaved client can back off
			// before it gets blocked. These describe THIS per-IP request-rate
			// limiter (requests/minute) — a separate concern from the
			// /v1/ask(/stream) question quota (questions/day, ask-quota.ts),
			// which sets its own X-RateLimit-Limit/Remaining further down the
			// pipeline (route-level beforeHandle) and must not be overwritten.
			set.headers["RateLimit-Policy"] = rateLimitPolicy(policyName, decision);
			set.headers.RateLimit = rateLimitHeader(policyName, decision);
			// Legacy de-facto X-RateLimit-* headers, for clients that don't
			// parse RFC 8941 structured fields yet — skipped on ask endpoints,
			// where these header names already carry the question quota
			// (questions/day), a more relevant signal there than the
			// requests/minute limiter.
			if (!isAsk) {
				set.headers["X-RateLimit-Limit"] = String(decision.limit);
				set.headers["X-RateLimit-Remaining"] = String(decision.remaining);
				set.headers["X-RateLimit-Reset"] = String(decision.resetSeconds);
			}
			if (decision.limited) {
				set.status = 429;
				set.headers["Retry-After"] = String(decision.resetSeconds);
				return { error: "Too many requests" };
			}
		}
	})
	// `mapResponse`, not `onAfterHandle`: onAfterHandle only runs on the
	// success path — an onError-produced response (404/422/500) skips it
	// entirely, so a plain onAfterHandle would leave error responses without
	// security headers, the service-desc Link, or a log line (PR #209 review).
	// mapResponse runs for every response, error or not, with `set.status`
	// already reflecting whatever onError set it to.
	.mapResponse(({ request, set, path }) =>
		finalizeResponse(request, set, path),
	);

// ── Structured JSON errors ──────────────────────────────────────────
// See services/api-errors.ts: normalizes unmatched routes, validation
// failures, and unhandled throws to `{ error, code, hint }` JSON.
app.onError(({ code, error, path, request, set }) => {
	const { status, body } = structuredError(code, error, path);
	set.status = status;
	// 5xx (and any unrecognized code that lands on 5xx) must be logged
	// server-side — the client only ever gets the generic "Internal server
	// error" body, never the message or stack.
	if (status >= 500) {
		console.error(
			JSON.stringify({
				level: "error",
				path,
				code,
				status,
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			}),
		);
	}
	// A Response (see errorResponse) skips mapResponse, so apply its headers
	// and log line here.
	finalizeResponse(request, set, path);
	return errorResponse(status, body, set.headers);
});

const { swagger } = await import("@elysiajs/swagger");
app.use(
	swagger({
		documentation: {
			info: {
				title: "Ley Abierta API",
				version: "0.1.0",
				description:
					"REST API for consolidated Spanish legislation. Source: Agencia Estatal BOE.\n\n" +
					"## Versioning and deprecation\n\n" +
					"The API is versioned in the URL path (`/v1`). Within `/v1`, additive, " +
					"backward-compatible changes (new endpoints, new optional fields) ship " +
					"without notice. A breaking change (removing/renaming a field, changing " +
					"a status code's meaning) either goes out as a new `/v2` served " +
					"alongside `/v1`, or the affected `/v1` endpoint is deprecated first.\n\n" +
					"A deprecated endpoint is announced on " +
					"[GitHub Releases](https://github.com/leyabierta/leyabierta/releases) and " +
					"[Discussions](https://github.com/leyabierta/leyabierta/discussions) with " +
					"at least 90 days' notice before removal, and during that window its " +
					"responses carry a `Deprecation: true` header (RFC 8594) plus a " +
					"`Sunset: <date>` header (RFC 9745) naming the removal date. No `/v1` " +
					"endpoint is deprecated today.\n\n" +
					"See also [`/llms.txt`](https://leyabierta.es/llms.txt) for an agent-oriented " +
					"summary and [`/desarrolladores/`](https://leyabierta.es/desarrolladores/) for " +
					"the full developer guide (rate limits, errors, quickstart).",
				contact: {
					name: "Ley Abierta",
					url: "https://github.com/leyabierta/leyabierta",
				},
				license: {
					name: "AGPL-3.0",
					url: "https://github.com/leyabierta/leyabierta/blob/main/LICENSE",
				},
			},
			servers: [
				{
					url: "https://api.leyabierta.es",
					description: "Producción",
				},
			],
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

// Built once (memoized) from the swagger plugin's own /swagger/json route —
// see services/openapi-doc.ts.
const openApiDoc = createOpenApiDoc(() =>
	app.handle(new Request("http://internal.leyabierta/swagger/json")),
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
	.use(reformRoutes(dbService))
	.use(statusRoutes(statusService))
	.use(omnibusRoutes(dbService))
	.use(askRoutes(ragPipeline, { quota: askQuota, bypassKey: API_BYPASS_KEY }))
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
	// Alias for the swagger plugin's `/swagger/json` spec at the conventional
	// `/openapi.json` path that agent-readiness scanners look for. Same
	// document (routes, `servers`, etc.), just discoverable without knowing
	// the swagger plugin's own path. Built once and memoized — see
	// services/openapi-doc.ts for why (PR #209 review: a per-request self-call
	// through the rate limiter's "unknown" IP bucket could return HTTP 200
	// with a 429 body under load).
	.get(
		"/openapi.json",
		async ({ set }) => {
			const { status, body } = await openApiDoc.get();
			set.status = status;
			return body;
		},
		{ detail: { hide: true } },
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
