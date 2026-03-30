# Ley Abierta — Estado del Proyecto

Documento de referencia para continuar el desarrollo en futuras sesiones.

## Que es Ley Abierta

Un motor open source en TypeScript que descarga legislacion oficial (empezando por Espana/BOE), la convierte en archivos Markdown versionados con Git — donde cada reforma es un commit con su fecha historica — y expone esos datos mediante una API y una web para que cualquiera pueda buscar, comparar versiones y entender como cambian las leyes.

**Principios:** Open source para siempre. Sin monetizacion. Ciudadano primero. Transparencia total.

## Stack aprobado (2026-03-30)

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Pipeline | TypeScript (existente, 2,200 LOC, 51 tests) |
| API | Elysia (Bun-native) |
| Web | Astro (content-first, islands para diffs) |
| DB | SQLite (bun:sqlite, FTS5 full-text search) |
| Cache | LRU in-memory (Redis upgrade futuro) |
| Diff rendering | diff2html |
| Deploy (futuro) | KonarServer + Cloudflare proxy |

## Que se ha hecho

### Pipeline (funcional)
- BOE Client con rate limiting (~5 req/s)
- XML Parser (fast-xml-parser, 414 LOC)
- Markdown generation con frontmatter YAML
- Git integration con fechas historicas e idempotencia
- ~100 leyes procesadas, ~1,600 commits en output/es
- 51 tests passing
- Country registry pattern (multi-pais pluggable)

### Phase 0: Bug fixes (completado 2026-03-30)
- Fixed pipeline.ts change detection bug (writeAndAdd → add logic)
- Fixed frontmatter.ts YAML escaping (backslashes, quotes, newlines)
- Extracted shared `parseBoeDate()` to `src/utils/date.ts` (DRY)

## Siguiente paso: Phase 1a — SQLite schema + ingest

Crear el modulo de base de datos que ingesta los JSON cache files existentes (~102) en SQLite con FTS5 para busqueda full-text.

**Archivos a crear:**
- `packages/pipeline/src/db/schema.ts` — definicion del schema
- `packages/pipeline/src/db/ingest.ts` — JSON cache → SQLite
- `packages/pipeline/src/db/index.ts` — conexion y queries

**Schema planeado:**
- Tabla `laws` con FTS5 en title + full text content
- Tabla `reforms` con fechas, source IDs, commit hashes
- Tabla `references` con relaciones entre leyes (anteriores/posteriores)
- Tabla `materias` con vocabulario controlado del BOE (3,000+ temas)

## Plan completo

Ver `~/.claude-profiles/konar/plans/eventual-nibbling-waterfall.md` para el plan detallado con:
- Phase 0: Bug fixes (DONE)
- Phase 1a: SQLite + ingest (NEXT)
- Phase 1b: Elysia API (8 endpoints)
- Phase 1c: Astro web (search, diff, graph, dark mode)
- Phase 2: Bootstrap 12,231 leyes (puede correr en paralelo)
- Phase 3: Re-ingest + validar + compartir

## Informacion clave del BOE

- **API base:** `https://www.boe.es/datosabiertos/api/`
- **Sin rate limits** documentados, sin API key, CORS abierto
- **12,231 leyes consolidadas** (1887-presente)
- **Atribucion requerida:** "Fuente: Agencia Estatal BOE" + link a boe.es
- **Gotchas:** Accept header obligatorio, limit=-1 capped a 10K, query param requiere JSON estructurado, varios endpoints XML-only, fecha_caducidad en bloques
- **Docs oficiales:** APIconsolidada.pdf (2025-09-02), APIsumarioBOE.pdf (2024-06-28)

## Como continuar

```bash
cd /Users/alex/00_Programacion/01_Alex/leylibre

# Ver que todo funciona
bun test          # 51 tests, todos pasan
bun run check     # Biome lint

# Siguiente: "Continua con Phase 1a: SQLite schema + ingest"
```
