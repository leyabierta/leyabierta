# Changelog

All notable changes to this project will be documented in this file.

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
