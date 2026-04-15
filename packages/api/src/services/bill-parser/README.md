# Bill Impact Preview -- "Previsualizador de Impacto Legislativo"

Sistema que analiza un proyecto de ley (antes de ser aprobado) y detecta automaticamente
que efectos tendra sobre la legislacion vigente: bajadas de penas, ausencia de disposiciones
transitorias, eliminacion de tipos penales, normas afectadas en cascada, derogaciones y
creacion de nuevas entidades.

Funciona como un **"linter" de seguridad juridica** -- detecta vulnerabilidades en el codigo
legal antes de su "despliegue".

## Estado actual

- [x] **Spike v1**: parser hardcodeado para un solo caso (solo si es si)
- [x] **Spike v2**: parser generico + analyzer + 3 test cases -- **3/3 PASS**
- [x] **Phase 0**: validacion amplia -- 47 bills, 3 legislaturas
- [x] **Hybrid parsing**: regex (deterministico) + LLM structured output (fallback)
- [x] **LLM verification**: second opinion independiente para detectar gaps
- [x] **Metricas honestas**: classification + group recall (no solo precision)
- [x] **Phase 2**: DB schema (5 tables) + API endpoints + analyze-bill pipeline
- [x] **Phase 2.5**: derogations (Gap 1), new entities (Gap 3), LLM false positive filter (Gap 4)
- [x] **Phase 3**: `/propuestas` (radar legislativo) y `/propuestas/detalle` en leyabierta.es
- [ ] **Phase 2.5 Gap 2**: Sintesis tematica de modificaciones (P1)
- [ ] Enriquecer grafo de referencias (parsear campo `text` de 42K referencias)

## Design principle: regex for structure, LLM for semantics

The parser separates two concerns:

- **Structural patterns** are standardized by the Directrices de Tecnica Normativa
  (BOE-A-2005-13020): group detection, ordinal splitting, modification classification,
  section boundaries. These are deterministic, free, and 99.4% accurate via regex.
- **Semantic extraction** (law names, entity boundaries, provision lists from prose)
  uses LLM structured output with JSON schema. ~$0.006/bill. Handles Spanish legal
  prose variability that regex cannot.

The system works without an LLM API key (graceful degradation). Entity extraction
returns `[]`, derogation extraction falls back to regex only.

## What the parser detects

| Phase | Detection | Method |
|-------|-----------|--------|
| Phase 0 | **Modifications** -- what articles a bill changes in existing laws | 5 regex strategies + LLM verification |
| Phase 2.5 | **Derogations** -- what laws/articles a bill repeals | LLM extraction + regex fallback |
| Phase 2.5 | **New entities** -- registries/agencies/systems/procedures a bill creates | LLM extraction |
| Phase 0 | **Bill type** -- `new_law`, `amendment`, or `mixed` | Heuristic from modification count + body analysis |

## Resultados del linter (3 test cases)

| Caso | Ley | Mods | Alertas | DT penal | Veredicto | Resultado |
|------|-----|:----:|:-------:|:--------:|-----------|:---------:|
| **Solo si es si** | LO 10/2022 | 100 en 17 leyes | 4 critical, 2 high | NO | CRITICAL | PASS |
| **Reforma CP 2015** | LO 1/2015 | 580 en 7 leyes | 7 critical, 1 high | SI (revision) | CRITICAL-WITH-DT | PASS |
| **Sedicion** | LO 14/2022 | 23 en 4 leyes | 1 critical, 1 high | SI (revision) | CRITICAL-WITH-DT | PASS |

## Phase 0: Validation

Iterative validation with 47 bills across 3 legislatures (X, XIV, XV).
See [PHASE0-VALIDATION.md](./PHASE0-VALIDATION.md) for full detail.

### Metrics

Two complementary metrics to avoid inflated numbers:

- **Classification**: of the ordinals found within each group, how many are classified
  correctly? (precision over what was detected)
- **Group recall**: of the modification groups that exist in the bill, how many does
  the parser find? Measured by comparing against an independent text scan. A value
  >100% means the parser (with catch-all + LLM verification) finds more groups than
  the baseline scan expects.

| Metric | Current |
|--------|---------|
| Bills tested | **47** |
| Tests | **460** |
| Failures | **0** |
| Classification accuracy | **100%** |
| Group recall | **106.6%** (finds more than baseline expects) |
| Warnings | **0** |

### Architecture: 5 regex strategies + LLM verification

The parser combines 5 regex strategies (free, deterministic) with 1 LLM verification
(~$0.006/bill, safety net):

| # | Strategy | Detects | Example |
|---|----------|---------|---------|
| 1 | DFs with "Modificacion" | `DF X. Modificacion de la Ley Y` | LO 10/2022 |
| 2 | Articles with "Modificacion" | `Art. X. Modificacion de la Ley Y` | LO 14/2022, B-23-1 |
| 3 | Single article | With or without "Modificacion" in header | LO 1/2015, B-40-1, B-5-1 |
| 4 | Additional provisions | DAs with "Se modifica" in body | Amnistia B-32-1 |
| 5 | Catch-all implicit | Articles/DFs without standard keyword | Omnibus A-3-1 |
| 6 | LLM verification | Second opinion for gaps | Safety net |

All 5 regex strategies filter headers inside `<<>>` quoted blocks to prevent false positives from proposed law text (e.g., a DF that quotes a new article mentioning another law).

Additional parser capabilities:
- **Known law aliases** for pre-codification laws: LECrim, Codigo Civil, Codigo de Comercio, etc. Maps informal names to their BOE identifiers.
- **Roman numeral conversion** for legislature extraction: XV -> 15, XIV -> 14.

Strategies 1-5 always run (no cost). Strategy 6 only with API key (~$0.006/bill).
Results are deduplicated by target law and text range.

### Modification classification

Within each group, the parser detects ordinals (Uno., Dos., Unico., 1., 2.) and classifies
each modification according to the Directrices de Tecnica Normativa (BOE-A-2005-13020):

| Action | Standard formula | `changeType` |
|--------|-----------------|--------------|
| Modify | "Se modifica el articulo X, que queda redactado como sigue:" | `modify` |
| Add | "Se anade/introduce/adiciona un articulo X bis" | `add` |
| Delete article | "Se suprime el apartado N del articulo X" | `delete` |
| Delete chapter | "Se suprime el Capitulo I del Titulo XXII" | `suppress_chapter` |
| Renumber | "Se modifica la numeracion del articulo X" | `renumber` |
| Create | "Se crea, dentro de la seccion X, un nuevo articulo Y" | `add` |

Supports textual ordinals (Uno-Treinta, Primero-Ducentesimo, Unico/a), compound ordinals
(Centesimo trigesimo primero), and numeric ordinals (1. 2. 3.) with sequentiality validation.

## Phase 2: DB + API + Analysis pipeline

### DB schema

Five tables in `packages/pipeline/src/db/schema.ts`:

| Table | Purpose |
|-------|---------|
| `bills` | BOCG bill metadata: bocgId, title, legislature, series, alert_level, bill_type, PDF URL, timestamps |
| `bill_modifications` | Parsed modification groups + individual modifications per bill |
| `bill_impacts` | LLM-generated impact analysis per law: severity, affected populations, plain-language explanation |
| `bill_derogations` | Repealed laws/provisions detected by the parser |
| `bill_entities` | New entities (registries, agencies, systems, procedures) created by the bill |

### Script: `analyze-bill.ts`

Full pipeline: PDF download -> parser -> analyzer -> LLM impact generation -> SQLite persistence.

```bash
# Analyze a single BOCG bill
bun run packages/api/src/scripts/analyze-bill.ts --url https://...PDF

# Skip LLM impact generation (deterministic analysis only)
bun run packages/api/src/scripts/analyze-bill.ts --url https://...PDF --skip-llm-impact

# Force re-analysis of an already-analyzed bill
bun run packages/api/src/scripts/analyze-bill.ts --url https://...PDF --force
```

### API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /v1/bills` | List analyzed bills with filters: `legislature`, `alert_level`, `series`. Returns `bill_type`. Paginated. |
| `GET /v1/bills/:bocgId` | Full bill detail: modification_groups, derogations, new_entities, impacts, transitional_check |

### UI (Phase 3)

| Page | Description |
|------|-------------|
| `/propuestas` | "Radar legislativo" list page with alert badges, bill type badges, filter chips |
| `/propuestas/detalle?id=X` | Detail page with 3 tabs: Resumen, Modificaciones, Impacto |

## Test suite

### Unit tests

`packages/api/src/__tests__/bill-parser.test.ts` -- 460 tests covering 47 bills. Fully deterministic (no LLM calls).

```bash
bun test packages/api/src/__tests__/bill-parser.test.ts
```

### E2E precision benchmark

`packages/api/src/scripts/bill-benchmark-e2e.ts` -- 47 bills with snapshot comparison against saved baselines.

```bash
# Run deterministic benchmark (no LLM)
bun run packages/api/src/scripts/bill-benchmark-e2e.ts

# Save current results as the new baseline
bun run packages/api/src/scripts/bill-benchmark-e2e.ts --save-baseline

# Run with LLM verification + impact generation
OPENROUTER_API_KEY=... bun run packages/api/src/scripts/bill-benchmark-e2e.ts --llm

# Save LLM baseline
OPENROUTER_API_KEY=... bun run packages/api/src/scripts/bill-benchmark-e2e.ts --llm --save-baseline
```

### Validation scripts

```bash
# Validate derogation accuracy across all bills
bun run packages/api/src/scripts/validate-derogations.ts

# Validate entity accuracy across all bills
bun run packages/api/src/scripts/validate-entities.ts
```

## Analyzer (`analyzer.ts`)

Compares parsed modifications against current legislation in the DB.

### Rule 1: Penalty reduction

Extracts sentencing ranges ("prision de X a Y anos") from current and proposed text.
- **CRITICAL**: `new_min < current_min` (risk of pro reo review)
- **HIGH**: `new_max < current_max`
- **MEDIUM**: current article has penalties but proposed text does not contain explicit penalties

### Rule 2: Elimination of criminal offenses

When `suppress_chapter` is detected, looks up articles in that chapter from the DB.

### Rule 3: Transitional provisions check

Verifies whether the bill includes transitional provisions on penalties/retroactivity and sentence review.

### Rule 4: Blast radius

Uses the `referencias` table (98K relationships) to find norms that depend on the modified articles.

## Motivacion: el caso "solo si es si"

La **LO 10/2022** fusiono "abuso sexual" y "agresion sexual" en un tipo penal unico.
Los minimos de las penas bajaron. Por el principio *pro reo* (art. 2.2 CP), los jueces
aplicaron retroactivamente la ley mas favorable, causando revisiones de condena.

El proyecto de ley **no incluia una disposicion transitoria sobre retroactividad de penas**.
Este "bug" legislativo era detectable analizando el texto antes de su aprobacion.

| Articulo | Pre-2022 | LO 10/2022 | LO 4/2023 (parche) |
|----------|----------|------------|---------------------|
| Art. 178 (basico) | 1-5 anos | 1-4 anos | 1-4 / 1-5 |
| Art. 179 (violacion) | 6-12 anos | **4-12 anos** | 4-12 / 6-12 |
| Art. 180 (agravado) | 5-10 / 12-15 | **2-8 / 7-15** | 2-8 / 5-10 / 7-15 / 12-15 |

## Fuentes de datos

### BOCG (Boletin Oficial de las Cortes Generales)

PDFs con URL predecible:
```
https://www.congreso.es/public_oficiales/L{LEG}/CONG/BOCG/{SERIE}/BOCG-{LEG}-{SERIE}-{NUM}-{SUB}.PDF
```

Serie A = Proyectos de Ley, Serie B = Proposiciones de Ley. Requiere `User-Agent`.

### Metadatos

| Fuente | Formato | Cobertura |
|--------|---------|-----------|
| Congreso busqueda | JSON | Todas las legislaturas |
| Congreso open data | JSON/CSV/XML | Solo legislatura XV |
| Senado open data | XML | Legislaturas 8-15 |
| BOE | XML/JSON API | Todo (desde 1835) |

## Phase 2.5: Gaps status

Validation comparing the pipeline against external analysis (Gemini) on
BOCG-14-A-116-1 (Eficiencia Digital de Justicia). Our pipeline detected
**7/7 affected laws** (Gemini only 5/7) and **53 modifications** with **0 false
positives**. Four gaps were identified:

| Gap | Description | Priority | Status |
|-----|-------------|----------|--------|
| Gap 1 | Disposiciones derogatorias | P0 | **DONE** -- LLM extraction + regex fallback in `derogations.ts` |
| Gap 2 | Sintesis tematica de modificaciones | P1 | **PENDING** |
| Gap 3 | Deteccion de adiciones sustantivas (new entities) | P1 | **DONE** -- LLM extraction in `entities.ts` |
| Gap 4 | Falsos positivos LLM ("no altera el texto vigente") | P0 | **DONE** -- post-filter in `analyze-bill.ts` |

### Gap 1: Disposiciones derogatorias -- DONE

The parser now extracts derogations via `derogations.ts`:
- **LLM extraction** (`extractDerogationsWithLLM`): structured output with JSON schema
  to parse "Se deroga/n...", "Queda/n derogada/s...", "Disposicion derogatoria" sections
- **Regex fallback**: deterministic extraction when no API key is available
- Results stored in `bill_derogations` table and exposed via the API

### Gap 2: Sintesis tematica -- PENDING (P1)

The 43+ individual changes per bill are correct but hard to consume. A thematic grouping
layer (digitalization, videoconference, electronic filing, digital signature) would make
the output comparable to high-level LLM analysis.

### Gap 3: Deteccion de adiciones sustantivas -- DONE

The parser now extracts new entities via `entities.ts`:
- **LLM extraction** (`extractEntitiesWithLLM`): detects registries, agencies, systems,
  and procedures created in the bill's main body (not just DFs)
- Returns `[]` without API key (graceful degradation)
- Results stored in `bill_entities` table and exposed via the API

### Gap 4: Falsos positivos LLM -- DONE

Post-filter in `analyze-bill.ts` eliminates variables where the proposed change is
identical or equivalent to the current text. Reduces noise without additional LLM cost.

### Remaining work (by priority)

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| **P1** | Sintesis tematica (Gap 2) | Medium | High -- makes output consumable by citizens |
| **P2** | Enriquecer grafo de referencias | Medium | Medium -- improves blast radius |
| **P2** | Analyzer: todas las penas por articulo | Low | Medium -- more penalty precision |
| **P2** | Analyzer: mapeo capitulo -> articulos | Medium | Medium -- for `suppress_chapter` |

## Cost model

| Component | Cost |
|-----------|------|
| Regex parsing (modifications, classification) | $0 |
| LLM verification + derogations + entities | ~$0.006/bill |
| Without API key | $0 (graceful degradation) |

## Scripts

```bash
# Full pipeline: PDF -> parser -> analyzer -> LLM -> SQLite
bun run packages/api/src/scripts/analyze-bill.ts --url https://...PDF [--skip-llm-impact] [--force]

# E2E benchmark: 47 bills (no LLM)
bun run packages/api/src/scripts/bill-benchmark-e2e.ts

# E2E benchmark: 47 bills (with LLM)
OPENROUTER_API_KEY=... bun run packages/api/src/scripts/bill-benchmark-e2e.ts --llm

# Validate derogation accuracy
bun run packages/api/src/scripts/validate-derogations.ts

# Validate entity accuracy
bun run packages/api/src/scripts/validate-entities.ts

# Legacy: original 3-bill linter
bun run packages/api/src/scripts/spike-bill-linter.ts

# Legacy: original benchmark
bun run packages/api/src/scripts/spike-bill-benchmark.ts
```

## File structure

```
packages/api/src/
  services/bill-parser/
    README.md                  <- this file
    PHASE0-VALIDATION.md       <- detail of the 9 validation runs
    parser.ts          (189)   <- entry point, parseBill() orchestrator
    types.ts           (190)   <- interfaces: BillModification, ModificationGroup,
                                  ParsedBill, Derogation, NewEntity, BillType
    strategies.ts      (375)   <- 5 regex strategies for modification group detection
    classification.ts  (399)   <- modification classification + ordinal splitting
    derogations.ts     (246)   <- derogation extraction (LLM + regex fallback)
    entities.ts         (71)   <- entity extraction (LLM only, returns [] without key)
    llm.ts             (468)   <- all LLM functions: classifyWithLLM, verifyWithLLM,
                                  extractDerogationsWithLLM, extractEntitiesWithLLM
    pdf.ts              (41)   <- PDF text extraction
    header.ts          (100)   <- BOCG ID, date, title, transitional provisions
    utils.ts            (81)   <- quoted blocks, section boundaries, deduplication
    analyzer.ts        (742)   <- penalty analysis, blast radius, transitional check
  __tests__/
    bill-parser.test.ts (610)  <- 460 tests, 47 bills (deterministic)
  scripts/
    analyze-bill.ts            <- full pipeline: PDF -> parser -> analyzer -> LLM -> SQLite
    bill-benchmark-e2e.ts      <- E2E precision benchmark, 47 bills, snapshot baselines
    validate-derogations.ts    <- derogation accuracy across all bills
    validate-entities.ts       <- entity accuracy across all bills
    spike-bill-benchmark.ts    <- (legacy) original benchmark
    spike-bill-linter.ts       <- (legacy) original 3-bill test suite
    spike-bill-llm-parse.ts    <- (legacy) regex vs LLM comparison spike
packages/pipeline/src/db/
    schema.ts                  <- DB schema: bills, bill_modifications, bill_impacts,
                                  bill_derogations, bill_entities tables
data/
  spike-bills/                 <- 47 PDFs downloaded (gitignored)
```

## References

- [Directrices de Tecnica Normativa](https://www.boe.es/buscar/doc.php?id=BOE-A-2005-13020)
- [BOE API](https://www.boe.es/datosabiertos/api/)
- [Congreso open data](https://www.congreso.es/es/datos-abiertos)
- [Art. 2.2 del Codigo Penal](https://www.boe.es/buscar/act.php?id=BOE-A-1995-25444) -- principio pro reo
