# Bill Impact Preview — "Previsualizador de Impacto Legislativo"

Sistema que analiza un proyecto de ley (antes de ser aprobado) y detecta automáticamente
qué efectos tendrá sobre la legislación vigente: bajadas de penas, ausencia de disposiciones
transitorias, eliminación de tipos penales, y normas afectadas en cascada.

Funciona como un **"linter" de seguridad jurídica** — detecta vulnerabilidades en el código
legal antes de su "despliegue".

## Estado actual

- [x] **Spike v1**: parser hardcodeado para un solo caso (solo sí es sí)
- [x] **Spike v2**: parser genérico + analyzer + 3 test cases — **3/3 PASS**
- [x] **Phase 0**: validación amplia — 36 bills, 3 legislaturas, 9 runs de iteración
- [x] **Hybrid parsing**: regex (determinístico) + LLM structured output (fallback)
- [x] **LLM verification**: second opinion independiente para detectar gaps (approach 7)
- [x] **Métricas honestas**: classification + group recall (no solo precisión)
- [x] **Phase 2**: DB schema + API endpoints + analyze-bill pipeline
- [ ] Enriquecer grafo de referencias (parsear campo `text` de 42K referencias)
- [ ] UI de visualización del informe de impacto (Phase 3)

## Resultados del linter (3 test cases)

| Caso | Ley | Mods | Alertas | DT penal | Veredicto | Resultado |
|------|-----|:----:|:-------:|:--------:|-----------|:---------:|
| **Solo sí es sí** | LO 10/2022 | 100 en 17 leyes | 4 critical, 2 high | NO | CRITICAL | PASS |
| **Reforma CP 2015** | LO 1/2015 | 580 en 7 leyes | 7 critical, 1 high | SI (revisión) | CRITICAL-WITH-DT | PASS |
| **Sedición** | LO 14/2022 | 23 en 4 leyes | 1 critical, 1 high | SI (revisión) | CRITICAL-WITH-DT | PASS |

## Phase 0: Validación

Validación iterativa con 36 bills de 3 legislaturas (X, XIV, XV) en 9 runs.
Ver [PHASE0-VALIDATION.md](./PHASE0-VALIDATION.md) para el detalle completo.

### Métricas

Dos métricas complementarias para evitar números inflados:

- **Classification**: de los ordinales encontrados dentro de cada grupo, ¿cuántos se clasifican
  correctamente? (precisión sobre lo detectado)
- **Group recall**: de los grupos de modificaciones que existen en el bill, ¿cuántos encuentra
  el parser? Medido comparando contra un text scan independiente que busca patterns como
  "Disposición final X. Modificación de...", "Se modifica" en body de artículos, etc.
  Un valor >100% significa que el parser (con catch-all + LLM verification) encuentra más
  grupos de los que el scan básico espera.

| Métrica | Run 1 | Run 9 (actual) |
|---------|-------|----------------|
| Bills testeados | 15 | **36** |
| Bills con mods | 14 | **31** |
| Mods clasificadas | 455 | **1544** |
| Warnings | 85 | **9** |
| Classification | 84.3% | **99.4%** |
| Group recall | N/A | **264/179 (147.5%)** |
| Under-detected | N/A | **0/36 bills** |
| Falsos negativos (NO_MODS) | 5 | **0** |

### Arquitectura: 6 estrategias de detección

El parser combina 5 estrategias regex (gratis, determinísticas) con 1 verificación LLM
(~$0.002/bill, red de seguridad):

| # | Estrategia | Detecta | Ejemplo |
|---|-----------|---------|---------|
| 1 | DFs con "Modificación" | `DF X. Modificación de la Ley Y` | LO 10/2022 |
| 2 | Artículos con "Modificación" | `Art. X. Modificación de la Ley Y` | LO 14/2022, B-23-1 |
| 3 | Artículo único | Con o sin "Modificación" en header | LO 1/2015, B-40-1, B-5-1 |
| 4 | Disposiciones adicionales | DAs con "Se modifica" en body | Amnistía B-32-1 |
| 5 | Catch-all implícito | Artículos/DFs sin keyword estándar | Omnibus A-3-1 |
| 6 | Verificación LLM | Second opinion para gaps | Approach 7 |

All 5 regex strategies filter headers inside `<<>>` quoted blocks to prevent false positives from proposed law text (e.g., a DF that quotes a new article mentioning another law).

Additional parser capabilities:
- **Known law aliases** for pre-codification laws: LECrim, Codigo Civil, Codigo de Comercio, etc. Maps informal names to their BOE identifiers.
- **Roman numeral conversion** for legislature extraction: XV -> 15, XIV -> 14.

Las estrategias 1-5 corren siempre (sin coste). La 6 solo con API key (~$0.002/bill).
Los resultados se deduplican por ley target y rango de texto.

### Clasificación de modificaciones

Dentro de cada grupo, el parser detecta ordinales (Uno., Dos., Único., 1., 2.) y clasifica
cada modificación según las fórmulas de las Directrices de Técnica Normativa (BOE-A-2005-13020):

| Acción | Fórmula estándar | `changeType` |
|--------|-----------------|--------------|
| Modificar | "Se modifica el artículo X, que queda redactado como sigue:" | `modify` |
| Añadir | "Se añade/introduce/adiciona un artículo X bis" | `add` |
| Suprimir artículo | "Se suprime el apartado N del artículo X" | `delete` |
| Suprimir capítulo | "Se suprime el Capítulo I del Título XXII" | `suppress_chapter` |
| Renumerar | "Se modifica la numeración del artículo X" | `renumber` |
| Crear | "Se crea, dentro de la sección X, un nuevo artículo Y" | `add` |

Soporta ordinales textuales (Uno-Treinta, Primero-Ducentésimo, Único/a), compuestos
(Centésimo trigésimo primero) y numéricos (1. 2. 3.) con validación de secuencialidad.

### Evolución del parser (highlights)

| Run | Fix principal | Impacto |
|-----|--------------|---------|
| 1→2 | 4 patterns de clasificación | 84.3% → 98.4% |
| 3 | Unicode `\w` → `[\p{L}\d]+` | Encontró DFs séptima, décima, undécima |
| 4 | LLM fallback (structured output) | 10→13 DFs en solo sí es sí |
| 5 | Multilinea, «» masking, double-space | 13→14 DFs, 0 warnings en 15 bills |
| 6 | "Se adiciona", "tenor literal" | 100% en 36 bills |
| 7 | Auditoría: 5 estrategias, ordinales numéricos, DAs | +347 mods, 5 falsos negativos eliminados |
| 8 | LLM verification (approach 7) | +23 mods, 0 bills under-detected |
| 9 | "Único" en ordinales, "quedan redactados", no-ordinal fallback | B-23-1 de 6/7→7/7 |

## Phase 2: DB + API + Analysis pipeline

### DB schema

Three new tables in `packages/pipeline/src/db/schema.ts`:

| Table | Purpose |
|-------|---------|
| `bills` | BOCG bill metadata: bocgId, title, legislature, series, alert_level, PDF URL, timestamps |
| `bill_modifications` | Parsed modification groups per bill: target law, article ranges, change types |
| `bill_impacts` | LLM-generated impact analysis per bill: severity, affected populations, plain-language explanation |

### Script: `analyze-bill.ts`

Full pipeline: PDF download → parser → analyzer → LLM impact generation → SQLite persistence.

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
| `GET /v1/bills` | List analyzed bills with filters: `legislature`, `alert_level`, `series`. Paginated. |
| `GET /v1/bills/:bocgId` | Full bill detail: modification groups, penalty analysis, LLM impacts, blast radius |

## Test suite

### Unit tests

`packages/api/src/__tests__/bill-parser.test.ts` — 59 tests covering 7 bills. Fully deterministic (no LLM calls).

```bash
bun test packages/api/src/__tests__/bill-parser.test.ts
```

### E2E precision benchmark

`packages/api/src/scripts/bill-benchmark-e2e.ts` — 38 bills with snapshot comparison against saved baselines.

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

## Analyzer (`analyzer.ts`)

Compara las modificaciones parseadas contra la legislación vigente en nuestra DB.

### Regla 1: Bajada de penas

Extrae horquillas "prisión de X a Y años" del texto vigente y del texto propuesto.
- **CRITICAL**: `nuevo_mínimo < mínimo_vigente` (riesgo de revisión pro reo)
- **HIGH**: `nuevo_máximo < máximo_vigente`
- **MEDIUM**: artículo actual tiene penas pero la nueva redacción no contiene penas explícitas

### Regla 2: Eliminación de tipos penales

Cuando `suppress_chapter` detectado, busca artículos de ese capítulo en la DB.

### Regla 3: Check de disposiciones transitorias

Verifica si el proyecto incluye DTs sobre penas/retroactividad y revisión de sentencias.

### Regla 4: Blast radius

Usa la tabla `referencias` (98K relaciones) para encontrar normas que dependen de los
artículos modificados.

## Motivación: el caso "solo sí es sí"

La **LO 10/2022** fusionó "abuso sexual" y "agresión sexual" en un tipo penal único.
Los mínimos de las penas bajaron. Por el principio *pro reo* (art. 2.2 CP), los jueces
aplicaron retroactivamente la ley más favorable, causando revisiones de condena.

El proyecto de ley **no incluía una disposición transitoria sobre retroactividad de penas**.
Este "bug" legislativo era detectable analizando el texto antes de su aprobación.

| Artículo | Pre-2022 | LO 10/2022 | LO 4/2023 (parche) |
|----------|----------|------------|---------------------|
| Art. 178 (básico) | 1-5 años | 1-4 años | 1-4 / 1-5 |
| Art. 179 (violación) | 6-12 años | **4-12 años** | 4-12 / 6-12 |
| Art. 180 (agravado) | 5-10 / 12-15 | **2-8 / 7-15** | 2-8 / 5-10 / 7-15 / 12-15 |

## Fuentes de datos

### BOCG (Boletín Oficial de las Cortes Generales)

PDFs con URL predecible:
```
https://www.congreso.es/public_oficiales/L{LEG}/CONG/BOCG/{SERIE}/BOCG-{LEG}-{SERIE}-{NUM}-{SUB}.PDF
```

Serie A = Proyectos de Ley, Serie B = Proposiciones de Ley. Requiere `User-Agent`.

### Metadatos

| Fuente | Formato | Cobertura |
|--------|---------|-----------|
| Congreso búsqueda | JSON | Todas las legislaturas |
| Congreso open data | JSON/CSV/XML | Solo legislatura XV |
| Senado open data | XML | Legislaturas 8-15 |
| BOE | XML/JSON API | Todo (desde 1835) |

## Próximos pasos

- [x] Phase 2: DB schema + API endpoints + analyze-bill pipeline
- [ ] Phase 3: `/propuestas` y `/propuestas/[id]` en leyabierta.es
- [ ] Enriquecer grafo: parsear campo `text` de 42K referencias para extraer artículos
- [ ] Analyzer: comparar TODAS las penas por artículo (no solo la primera)
- [ ] Analyzer: mapeo real capítulo→artículos para `suppress_chapter`

## Scripts

```bash
# Linter: 3 test cases
bun run packages/api/src/scripts/spike-bill-linter.ts

# Benchmark: 36 bills (sin LLM)
bun run packages/api/src/scripts/spike-bill-benchmark.ts

# Benchmark: 36 bills (con LLM fallback + verification)
OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-bill-benchmark.ts --llm

# Benchmark verboso
bun run packages/api/src/scripts/spike-bill-benchmark.ts --llm --verbose
```

## Estructura de archivos

```
packages/api/src/
├── services/bill-parser/
│   ├── README.md                ← este archivo
│   ├── PHASE0-VALIDATION.md     ← detalle de los 9 runs de validación
│   ├── parser.ts                ← 6 estrategias de detección + clasificación
│   └── analyzer.ts              ← comparación con DB + detección de riesgos
├── __tests__/
│   └── bill-parser.test.ts      ← 59 unit tests, 7 bills (deterministic)
├── scripts/
│   ├── analyze-bill.ts          ← full pipeline: PDF → parser → analyzer → LLM → SQLite
│   ├── bill-benchmark-e2e.ts    ← E2E precision benchmark, 38 bills, snapshot baselines
│   ├── spike-bill-benchmark.ts  ← original benchmark de 36 bills con métricas
│   ├── spike-bill-linter.ts     ← test suite con 3 bills
│   └── spike-bill-llm-parse.ts  ← spike de comparación regex vs LLM
packages/pipeline/src/db/
│   └── schema.ts                ← DB schema: bills, bill_modifications, bill_impacts tables
data/
└── spike-bills/                 ← 38 PDFs descargados (gitignored)
```

## Referencias

- [Directrices de Técnica Normativa](https://www.boe.es/buscar/doc.php?id=BOE-A-2005-13020)
- [BOE API](https://www.boe.es/datosabiertos/api/)
- [Congreso open data](https://www.congreso.es/es/datos-abiertos)
- [Art. 2.2 del Código Penal](https://www.boe.es/buscar/act.php?id=BOE-A-1995-25444) — principio pro reo
