# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Bill Impact Preview ("Radar Legislativo") — analyzes proposed legislation before approval
  - Parser: detects modifications, derogations, and new entities from BOCG PDFs
  - Derogation detection: finds laws/articles being repealed (LLM + regex fallback)
  - Entity detection: identifies new registries, agencies, systems created by bills (LLM)
  - Bill type classification: new_law, amendment, or mixed
  - Penalty analysis: detects penalty reductions, type eliminations, missing transitional provisions
  - Blast radius: finds other laws affected via reference graph
  - DB schema: bills, bill_modifications, bill_impacts, bill_derogations, bill_entities tables
  - API: GET /v1/bills (list with filters) and GET /v1/bills/:bocgId (full detail)
  - UI: /propuestas (list with filter chips, alert badges) and /propuestas/detalle (3-tab detail)
  - LLM false positive post-filter in impact analysis
  - 460 tests, 47 bills benchmarked, 0 regressions

### Changed
- Refactored bill parser from single 1533-line file into 9 focused modules
- Architecture: regex for structural patterns (99.4% accuracy), LLM for semantic extraction
- "Propuestas" link added to main navbar

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
