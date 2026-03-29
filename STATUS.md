# Ley Libre — Estado del Proyecto

Documento de referencia para continuar el desarrollo en futuras sesiones.

## Que es Ley Libre

Un motor open source en TypeScript que descarga legislacion oficial (empezando por Espana/BOE), la convierte en archivos Markdown versionados con Git — donde cada reforma es un commit con su fecha historica — y expone esos datos mediante una API y una web para que cualquiera pueda buscar, comparar versiones y entender como cambian las leyes.

**Principios:** Open source para siempre. Sin monetizacion. Ciudadano primero. Transparencia total.

**Inspirado por:**
- Articulo sobre ALEF (ley ejecutable holandesa): https://www.lavozdegalicia.es/noticia/reto-digital/ocio/2024/01/30/leyexe/00031706632270589450575.htm
- Proyecto Legalize (https://github.com/legalize-dev) — implementacion similar en Python. Ley Libre es una reimplementacion independiente en TypeScript con arquitectura y vision propias.

## Que se ha hecho

### Investigacion previa

1. Se clonaron y exploraron exhaustivamente los 4 repos de legalize-dev (pipeline, es, web, hub)
2. Se documento toda la arquitectura, modelo de dominio, interfaces, implementaciones de Espana y Francia
3. Se investigaron los rate limits del BOE (no hay limites documentados, no requiere API key, CORS abierto, 12,231 leyes disponibles)
4. Se eligio el nombre "leylibre" tras verificar disponibilidad en GitHub, npm, .dev y .es

### Estructura del monorepo

```
leylibre/
├── CLAUDE.md              # Guia tecnica para Claude Code (stack, arquitectura, BOE API, convenciones)
├── README.md              # Cara publica del proyecto
├── STATUS.md              # Este archivo
├── package.json           # Monorepo Bun con workspaces
├── tsconfig.json          # TypeScript strict, ESNext, bundler mode
├── biome.json             # Biome 2.4.9 (linter + formatter, tabs, double quotes)
├── .gitignore
├── bun.lock
└── packages/
    ├── pipeline/          # EL CORE — ya funcional
    ├── api/               # Placeholder (solo package.json)
    └── web/               # Placeholder (solo package.json)
```

### Pipeline — lo que ya funciona

El pipeline puede parsear XML del BOE y generar commits git con fechas historicas. Flujo completo probado con la Constitucion Espanola.

**Archivos de codigo:**

| Archivo | Que hace |
|---------|----------|
| `src/models.ts` | Modelo de dominio: Rank, CommitType, NormStatus, Paragraph, Version, Block, NormMetadata, Reform, Norm, CommitInfo. Todos son interfaces readonly. Rank es un branded string (extensible por pais). |
| `src/country.ts` | Abstracciones por pais: LegislativeClient, NormDiscovery, TextParser, MetadataParser. Registry con registerCountry/getCountry. Ninguna implementacion de pais registrada todavia. |
| `src/pipeline.ts` | Orquestador: bootstrapFromLocalXml() (para tests/piloto), commitNorm() (generar commits de una norma). Tambien normToJson() para serializar a JSON cache. |
| `src/transform/xml-parser.ts` | Parsea XML consolidado del BOE: parseTextXml() -> Block[], extractReforms() -> Reform[], getBlockAtDate(). Maneja formato de fecha YYYYMMDD del BOE, sentinel 99999999, limpia HTML inline (bold, italic, links). |
| `src/transform/markdown.ts` | Genera Markdown desde bloques: renderParagraphs() con mapeo CSS class -> heading Markdown (data-driven). renderNormAtDate() genera el documento completo (frontmatter + H1 + bloques vigentes a una fecha). |
| `src/transform/frontmatter.ts` | Genera frontmatter YAML: title, id, country, rank, published, updated, status, source. |
| `src/transform/slug.ts` | Genera rutas de archivo: rankToFolder() (37 mapeos rango -> carpeta), normToFilepath(). |
| `src/git/repo.ts` | GitRepo class: init(), writeAndAdd(), add(), commit() con GIT_AUTHOR_DATE historico, loadExistingCommits() para idempotencia O(1), hasCommitWithSourceId(). Usa Bun.spawn. |
| `src/git/message.ts` | Construye mensajes de commit: buildCommitInfo(), formatCommitMessage(). Formato: [tipo] Titulo — articulos. Trailers: Source-Id, Source-Date, Norm-Id. Autor: "Ley Libre <bot@leylibre.es>". |
| `src/index.ts` | Re-exports de todo el paquete. |

**Tests (32 tests, todos pasan):**

| Archivo | Tests | Que cubre |
|---------|-------|-----------|
| `tests/xml-parser.test.ts` | 7 | Parsing de bloques, atributos, fechas YYYYMMDD, multiples versiones, parrafos con CSS class, exclusion de notas al pie |
| `tests/markdown.test.ts` | 10 | Headings de articulo, parrafos normales, pares titulo_num+titulo_tit, capitulo_num+capitulo_tit, titulo sin par, firmas, frontmatter, H1, contenido, exclusion por fecha |
| `tests/slug.test.ts` | 4 | Mapeo de rangos espanoles a carpetas, fallback a "otros", generacion de rutas completas |
| `tests/pipeline.test.ts` | 6 | **Integration tests e2e:** bootstrap crea 4 commits, genera markdown con frontmatter, fechas historicas correctas (1978, 1992, 2011, 2024), trailers en commits, idempotencia (segundo run = 0 commits), JSON cache |

**Fixture:** `tests/fixtures/constitucion-sample.xml` — extracto real del XML del BOE con la Constitucion Espanola (17 bloques, 4 reformas: original 1978, art.13 en 1992, art.135 en 2011, art.49 en 2024).

### Decisiones de diseno tomadas

- **TypeScript todo** (pipeline + API + web). Monorepo con Bun workspaces.
- **Bun** como runtime (spawn para git, file API, test runner).
- **Biome** para lint/format (no ESLint/Prettier). Config: tabs, double quotes.
- **Fechas como strings ISO** (no Date objects) para evitar problemas de timezone.
- **Interfaces readonly** en vez de clases/frozen dataclasses.
- **Rank como branded string** (extensible por pais sin enum cerrado).
- **XML parsing con regex** (suficiente para el formato BOE, no necesita lxml).
- **Git via Bun.spawn** (no libgit2/isomorphic-git) para control total de GIT_AUTHOR_DATE.
- **Idempotencia** via Source-Id + Norm-Id en trailers de commits.
- **commit.gpgsign=false** pasado con -c en git commit para evitar fallos por GPG.
- **Codigo y comentarios en ingles**, contenido legislativo en idioma original.

## Lo que falta por hacer

### Prioridad 1 — Pipeline completo para Espana

1. **BOE Client** — HTTP client que descargue XML del BOE (`boe.es/datosabiertos/api/`). Rate limiting por cortesia (~5 req/s), cache con ETag/Last-Modified. Endpoints: `/legislacion-consolidada` (listado), `/id/{id}/texto` (XML), `/id/{id}/metadatos` (metadata).
2. **BOE Metadata Parser** — Parsear XML de metadatos: mapeo de codigos de rango (1070=Constitucion, 1010=LO, 1020=Ley, 1040=RDL, 1050=RDLeg), estado de derogacion, fechas, departamento.
3. **BOE Discovery** — Descubrir normas: sumarios diarios (`/boe/sumario/{YYYYMMDD}`) y catalogo paginado. El catalogo tiene 12,231 leyes con `limit=-1` y `offset`.
4. **Registrar Espana** en el country registry.
5. **CLI** — Comandos: `bootstrap` (descarga todo + commits), `daily` (sumario diario), `fetch`, `commit`, `status`.
6. **State Store** — Persistir estado (ultimo sumario procesado, normas procesadas) para runs incrementales.
7. **Ejecutar bootstrap completo** — Generar el repo leylibre-es con todas las leyes.

### Prioridad 2 — API

1. Elegir framework (Hono es buena opcion para Bun).
2. Endpoints: `GET /v1/laws`, `GET /v1/laws/:id`, `GET /v1/laws/:id/articles/:n`, `GET /v1/laws/:id/history`, `GET /v1/laws/:id/diff`.
3. Base de datos (PostgreSQL o SQLite para empezar).
4. Ingest de JSON cache a DB.

### Prioridad 3 — Web

1. Interfaz ciudadana: buscar leyes, ver texto, comparar versiones.
2. Diff viewer visual (side-by-side).
3. Timeline de reformas.

### Prioridad 4 — Mas paises

1. Portugal (DRE) — API REST similar a BOE, curva menor.
2. Alemania (BGBL / gesetze-im-internet.de) — XML descargable.
3. Cada pais solo necesita implementar 4 interfaces (client, discovery, text parser, metadata parser).

### Prioridad 5 — Extras

- CI/CD con GitHub Actions (tests + lint en push/PR, cron diario para updates).
- Validacion de calidad del markdown (`leylibre lint`).
- Parser semantico de referencias cruzadas entre leyes.
- Deteccion de legislacion obsoleta.

## Informacion clave del BOE

- **API base:** `https://www.boe.es/datosabiertos/api/`
- **Sin rate limits** documentados, sin API key, CORS abierto
- **12,231 leyes consolidadas** (1887-presente)
- **Atribucion requerida:** "Fuente: Agencia Estatal BOE" + link a boe.es
- **Endpoints principales:**
  - `/legislacion-consolidada` — listado con `limit=-1` y `offset`
  - `/legislacion-consolidada/id/{id}/texto` — XML consolidado con `<bloque>` y `<version>`
  - `/legislacion-consolidada/id/{id}/metadatos` — metadata (rango, fechas, estado)
  - `/boe/sumario/{YYYYMMDD}` — publicaciones del dia

## Como continuar

```bash
cd /Users/alex/00_Programacion/01_Alex/leylibre

# Ver que todo funciona
bun test
bun run check

# Siguiente paso logico: implementar el BOE client
# -> packages/pipeline/src/boe/client.ts
```

El repo todavia NO tiene commit inicial de git. Hay que hacerlo.
