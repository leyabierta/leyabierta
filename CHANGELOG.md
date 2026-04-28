# Changelog

All notable changes to this project will be documented in this file.

## [0.5.0.0] - 2026-04-28

### Cuantización int8 del índice vectorial

- **El índice de embeddings pasa de 5,95 GB a 1,49 GB** (-75 %) gracias a cuantización int8 simétrica per-vector. Tiempo de carga del corpus tras un restart se reduce proporcionalmente y la presión de memoria del contenedor baja unos 4,5 GB. Sin pérdida medible de calidad: Recall@1/5/10 igual sobre las 50 queries ciudadanas (R@5 incluso sube de 62 % a 66 %, dentro del ruido del embedding API).
- **Nuevo kernel SIMD `dot_int8_f32`** en `vector-simd.c` con paths NEON (arm64) y AVX2 (x86_64), más fallback escalar. Test de paridad confirma error relativo máximo del 0,7 % vs float32 sobre 100 vectores × 10 queries.
- **Latencia de búsqueda híbrida cae a la mitad**: avg 2720 ms → 1307 ms (p50 2094 → 817 ms, p95 4236 → 2041 ms) gracias a que el corpus int8 cabe en una fracción del cache L2.
- **Nuevo formato `INT8VEC1`** con header detectable en el primer chunk del archivo. El loader prefiere `vectors-int8.bin` si existe, fallback automático a `vectors.bin` (float32) si no — facilita rollback con un único `rm`.
- **Sidecar `vectors-int8.norms.bin`** (1,9 MB) con las normas L2 de los vectores originales precomputadas, evita recálculo en arranque.
- **`sync-embeddings.ts` regenera ambos archivos automáticamente** tras cada sync, manteniendo SQLite como fuente de verdad y `vectors.bin` como red de seguridad durante el rollout.
- Plan de rollout y rollback documentado en `packages/api/research/INT8-ROLLOUT.md`.

## [0.4.0.0] - 2026-04-27

### Búsqueda híbrida en `/v1/laws` (Issue #40)

- **El motor de búsqueda ahora entiende lenguaje ciudadano.** Antes, una persona buscando «morir dignamente», «no me devuelven la fianza» o «horas extras que no me pagan» no encontraba la ley estatal correspondiente porque BM25 sólo casa palabras literales. Ahora la búsqueda combina BM25 con embeddings semánticos (Gemini-2 vía OpenRouter) y devuelve la norma correcta aunque el texto legal use jerga distinta.
- **Resultados medidos sobre 50 queries ciudadanas:** Recall@5 del 2 % al 62 %, Recall@10 del 6 % al 80 %. Categorías que pasaron de 0 % a 100 %: penal, violencia de género, violencia sexual, igualdad, identidad, vivienda. El conjunto de evaluación vive en `packages/api/research/datasets/citizen-queries.json`.
- **Arquitectura:** retrieval híbrido = BM25 + KNN sobre `vectors.bin` (483.983 embeddings, vía pool de Bun Workers existente con SharedArrayBuffer) + Reciprocal Rank Fusion. Tres listas se fusionan por RRF (k=60): BM25, max-pool de scores artículo→norma, y sum-pool con umbral cosine ≥ 0,5. Boost por rango legal: textos refundidos (LGSS, ET, IRPF) ×1.2, leyes orgánicas ×1.0, RD ×0.7, autonómicas ×0.6, órdenes ×0.4. LRU de 1000 embeddings de query para evitar pagar OpenRouter dos veces por la misma búsqueda.
- **Latencia:** ~80 ms cache hit en Cloudflare (mayoría del tráfico), ~800 ms LRU hit en proceso, ~3 s cold start (embed API + KNN). Coste marginal: ~$2/mes a 1M queries únicas.
- **Sin fallback silencioso a BM25.** Si OpenRouter o el pool de vectores no están disponibles, `/v1/laws` devuelve 503 con error descriptivo. Respuestas erróneas son peores que un 503 honesto.
- Scripts de evaluación reproducibles: `bun run packages/api/research/eval-citizen-bm25.ts` (baseline) y `bun run packages/api/research/eval-citizen-hybrid.ts` (modo híbrido).

## [0.3.0.0] - 2026-04-26

### Performance — Sprint 2: BM25 also runs on workers, OR fallback pruned

- **BM25 dispatched to the worker pool** — `vector-worker.ts` opens its own SQLite readonly handle and serves a new `bm25` message in addition to vector search. The five BM25 stages (main, synonym, namedLaw, coreLaw, recent) are dispatched concurrently from `runPipeline` and `runRetrieval` via `Promise.all`. Total wall ≈ max(stage_i) instead of sum(stage_i).
- **Document-frequency pruning** — adds `blocks_fts_vocab` (FTS5 builtin auxiliary virtual table, no extra storage) and a small cached lookup. Before falling back to OR, `bm25ArticleSearch` drops tokens whose document frequency exceeds 30 % of the corpus. Common Spanish words (`dura`, `tengo`, `días`) no longer dominate the postings traversal — the worst-case OR scan drops from ~50 s to ~5 s.
- **Per-stage resilience** — if the pool is unavailable on the platform, busy (`VECTOR_POOL_BUSY`), or crashes mid-FFI, the stage falls back to the in-process synchronous `bm25HybridSearch`. One degraded stage no longer sinks the other four.
- **`CORE_NORMS` extracted to a single module-level constant** — `runPipeline` and `runRetrieval` now reference the same array; the previous `CORE_NORMS_2` duplicate is gone.
- **`resetBlocksFtsCaches()`** clears the docfreq/total caches after `ensureBlocksFts` rebuilds the index. Called from `beforeEach` in tests for cross-test isolation.

### Numbers — prod after deploy

| Query | Sprint 1 | Sprint 2 |
|---|---:|---:|
| SMI 2025 | 7 s | 8.8 s |
| paternidad | 35 s | **10.2 s** |
| despido | 34 s | **16.4 s** |
| prescripción | 10 s | **8.8 s** |
| alquiler | 14 s | **11.7 s** |

Median warm latency: **22 s → 10.2 s** (Sprint 1 → Sprint 2). Total since pre-Sprint 1 baseline (~120 s): ~12× e2e improvement.

### Infrastructure

- `blocks_fts_vocab` virtual table created on the production DB. Tables that don't exist on Sprint 1 deployments degrade gracefully: `getDocfreq` returns 0 → no pruning → behavior identical to Sprint 1.

## [0.2.0.0] - 2026-04-26

### Performance — Sprint 1: RAG retrieval ~5× faster end-to-end

- **Adaptive AND/OR FTS5 in `bm25ArticleSearch`** — multi-token queries try AND first; fall back to OR only when the intersection is below the cardinality threshold. Kills the OR-explosion that produced 49 s BM25 timings on prod traces with generic-token questions.
- **SIMD brute-force cosine top-K** — `vector-simd.c` (AVX2 + FMA, 2-way unrolled FMA accumulator, in-loop min-heap) loaded via `Bun.dlopen`. Single-thread vector search drops from ~50 s to ~870 ms on the 484 k × 3072 prod corpus (~70× speedup, top-10 parity 5/5).
- **Worker pool sharing vectors via `SharedArrayBuffer`** — 4 Bun Workers reference one in-memory copy of the 5.6 GB index, no replication. 5 concurrent queries finish in ~1.7 s wall vs ~4.8 s sequential SIMD (2.9× concurrency speedup). Pool init failures fail boot loud, so watchtower keeps the previous container.
- **Pool-only production path** — `RAG_VECTOR_BACKEND` flag retired after validation; the in-process SIMD and pure-JS fallbacks are no longer in the production code path. `vectorSearchInMemory` and `vectorSearchSIMD` remain as parity-test fixtures only.
- **Multi-stage Dockerfile** — `gcc` + `libc6-dev` only in the `simd-builder` stage; runtime image stays slim and copies just the precompiled `.so`.

### Recall

- End-to-end on the 57-question omnibus gold set: R@5 = 96.5% (matches the prior baseline R@1 measured at vector top-1), R@10 = 100%, MRR 0.848, 0 declined, 0 errors.

### Infrastructure

- **CI deploy step rewritten** — the old `docker compose up -d api` step on the self-hosted runner raced with watchtower's 30 s poll and failed with "container name in use" when watchtower won. The job now does zero docker mutations: it polls `/health` and gates on the SHA matching `${{ github.sha }}`. Single-owner deploy lifecycle (watchtower).

### Closed

- Issue #20 (Optimizar latencia de retrieval <5s).

## [0.1.0.0] - 2026-04-05

### Added
- Omnibus law detection: norms with 15+ BOE materias are identified as omnibus laws
- Per-topic AI breakdowns: LLM decomposes omnibus laws into thematic axes with headlines and summaries
- "Tema no relacionado con el titulo" flag: neutral indicator for topics unrelated to the law's official title
- `/omnibus` listing page with filter chips (by sneaked topics, rank, date range)
- `/omnibus/detalle` page with per-topic cards and visual distinction for unrelated topics
- Omnibus badge on reform cards in `/mis-cambios` and `/cambios`
- Badge fallback: shows "(N materias)" for omnibus norms without AI-generated topics
- "Te afecta por: {topic}" on reform cards, connecting omnibus topics to the user's profile
- `related_materias` field in `omnibus_topics` table linking topics to BOE materias
- Batch `getMatchedTopics()` query for efficient topic-to-user matching
- Materia weighting: reforms sorted by match density (ratio of user materias / total materias)
- RSS feed for omnibus laws (`/feed-omnibus.xml`)
- `generate-omnibus-topics.ts` script with `--limit`, `--since`, `--force`, `--dry-run` flags
- `--omnibus-only` flag for `generate-reform-summaries.ts` to regenerate omnibus summaries
- Jurisdiction validation (regex) to prevent SQL injection
- TODOS.md with deferred items (auto-detect, landing counter, share cards)

### Changed
- Materia mappings refined: removed "Empleo" from `busco_empleo`, removed personal driving materias from `transporte` sector, removed "Educacion" from `hijos_menores`
- Personal reforms query uses CTE with match ratio instead of flat materia JOIN
- Reform ordering changed from date-only to match_ratio DESC, date DESC
- Navbar: "Mis cambios" renamed to "Mi situacion", "Resumenes" renamed to "Cambios recientes"

### Removed
- Digest system: removed digest routes, pages (`/resumenes`), DB functions, and zombie code
- `packages/web/src/lib/api.ts` (digest-only API client)
- `packages/api/src/routes/digests.ts`
