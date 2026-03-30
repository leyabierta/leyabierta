# CLAUDE.md

## Project Overview

**Ley Libre** is an open source engine that downloads official legislation, converts it into version-controlled Markdown files — where every reform is a Git commit with its historical date — and exposes that data through an API and web interface so anyone can search, compare versions, and understand how the laws that affect them change over time.

**Principles:**
- Open source forever. No monetization. No paywalls.
- Citizen-first: accessible to everyone, not just lawyers or developers.
- Transparency: laws belong to the people, and their evolution should be visible.
- Freedom: no single person controls the project's direction arbitrarily.

**License:** MIT (tooling) + public domain (legislative content).

**Inspired by:**
- [ALEF (Agile Law Execution Factory)](https://www.lavozdegalicia.es/noticia/reto-digital/ocio/2024/01/30/leyexe/00031706632270589450575.htm) — Dutch Tax Authority's formal language for executable law
- [Legalize](https://github.com/legalize-dev) — pioneering legislation-as-code project (Python). Ley Libre is an independent TypeScript reimplementation with its own architecture and vision.

## Stack

- **Language:** TypeScript (everything — pipeline, API, web)
- **Runtime:** Bun
- **Linter/Formatter:** Biome
- **Tests:** Vitest
- **Monorepo structure** (single repo, multiple packages)

## Architecture

```
leylibre/
├── packages/
│   ├── pipeline/      # Fetch, parse, transform, commit
│   ├── api/           # REST API (Hono or similar)
│   └── web/           # Web frontend
├── data/              # Downloaded XML + JSON cache (gitignored)
├── output/            # Generated repos with legislation as Markdown
├── biome.json
├── package.json
└── tsconfig.json
```

### Pipeline (`packages/pipeline/`)

The pipeline converts official legislation into Markdown + Git history.

**Flow:** Discover norms > Fetch XML > Parse > Transform to Markdown > Git commit with historical date

**Key abstractions (per country):**
- `LegislativeClient` — fetch raw text and metadata from the official source
- `NormDiscovery` — discover all norms or daily updates
- `TextParser` — parse XML/HTML into structured blocks
- `MetadataParser` — parse metadata into normalized format

**Domain model:**
- `Norm` — complete parsed law (metadata + blocks + reforms)
- `NormMetadata` — title, id, country, rank, dates, status, source URL
- `Block` — structural unit (article, chapter, title, section)
- `Version` — temporal snapshot of a block (date + paragraphs)
- `Reform` — a point in time when the law changed
- `Paragraph` — text + semantic class (heading, article, body, etc.)

**Output format:**
```yaml
---
title: "Constitucion Espanola"
id: "BOE-A-1978-31229"
country: "es"
rank: "constitucion"
published: "1978-12-29"
updated: "2024-02-17"
status: "vigente"
source: "https://www.boe.es/eli/es/c/1978/12/27/(1)"
---

# Constitucion Espanola

[Full legislative text as Markdown]
```

Each reform = a Git commit with `GIT_AUTHOR_DATE` set to the official publication date.

### API (`packages/api/`)

REST API to query legislation.

Planned endpoints:
- `GET /v1/laws` — list/search laws (filters: country, rank, status, text)
- `GET /v1/laws/:id` — full law with metadata
- `GET /v1/laws/:id/articles/:n` — specific article
- `GET /v1/laws/:id/history` — reform timeline
- `GET /v1/laws/:id/diff?from=DATE&to=DATE` — diff between versions

### Web (`packages/web/`)

Citizen-facing website built with Astro (`output: "server"`, Node adapter).

**Architecture: static-first, no islands yet.**
The site is fully server-rendered. Interactive behavior (tabs, search form, diff viewer) uses inline `<script>` with vanilla JS — no UI framework (React, Svelte, etc.) is installed. This is intentional: the content is mostly static legislative text, so shipping zero JS by default keeps pages fast and accessible.

**When to introduce islands:**
When a feature genuinely needs client-side state or rich interactivity (e.g., live search-as-you-type, interactive timeline with zoom/filter, reactive diff controls), install a UI integration (`@astrojs/react` or `@astrojs/svelte`) and use `client:visible` or `client:idle` directives on those specific components. The rest of the page stays as static HTML.

**Current pages:**
- `/` — search and list laws (form with query, rank, status filters; paginated)
- `/laws/[id]` — law detail with tabs (summary, full text, reforms timeline)
- `/laws/[id]/diff?from=&to=` — side-by-side diff viewer (diff2html)

**Features:**
- Browse laws by country, type, status
- Full-text search
- Visual diff viewer (side-by-side version comparison)
- Timeline of reforms per law
- Direct links to official sources

## Data Sources

### Spain (BOE) — first country

- **API:** `https://www.boe.es/datosabiertos/api/`
- **No rate limits documented** (self-imposed courtesy limit recommended: ~5 req/s)
- **No authentication required**, CORS fully open
- **12,231 consolidated laws** available (from 1887 to present)
- **Attribution required:** "Fuente: Agencia Estatal BOE" + link to boe.es

Key endpoints:
- `/legislacion-consolidada` — list all (supports `limit=-1` for bulk, `offset` for pagination)
- `/legislacion-consolidada/id/{id}/texto` — full XML with versioned `<bloque>` elements
- `/legislacion-consolidada/id/{id}/metadatos` — metadata (rango codes, dates, status)
- `/boe/sumario/{YYYYMMDD}` — daily summary of new publications

XML structure: `<bloque>` contains `<version>` with `fecha_publicacion`, each version has `<p class="...">` paragraphs.

### Future countries

| Country | Source | API |
|---------|--------|-----|
| France | Legifrance | XML dumps (LEGI) |
| Germany | BGBL / gesetze-im-internet.de | XML downloads |
| Portugal | DRE (dre.pt) | REST API |

## Git Commit Conventions

Pipeline-generated commits (in output repos):
```
[bootstrap] Constitucion Espanola — original version 1978
[reforma] Constitucion Espanola — art. 49
[derogacion] Ley de arrendamientos urbanos 1964
[correccion] Codigo Penal — art. 301
```

Trailers:
```
Source-Id: BOE-A-2024-3099
Source-Date: 2024-02-17
Norm-Id: BOE-A-1978-31229
```

Author: `Ley Libre <bot@leylibre.es>`

## Development Commands

```bash
# Install dependencies
bun install

# Run tests
bun test

# Lint and format
bun run check
bun run format

# Run pipeline (Spain bootstrap)
bun run pipeline bootstrap --country es

# Run API server
bun run api

# Run web dev server
bun run web
```

## Key Conventions

- Code and comments in English
- Variable names in English (title, date, blocks — not titulo, fecha, bloques)
- User-facing content (web, API responses) multilingual
- Dates as ISO 8601 strings at boundaries, Date objects internally
- Prefer Bun APIs over Node.js equivalents
- Use Biome for linting and formatting (not ESLint/Prettier)
- Use bunx over npx, bun over npm

## gstack

**Setup (one-time per developer):**
```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git .claude/skills/gstack && cd .claude/skills/gstack && ./setup
```

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available skills:
- `/office-hours` — Office hours
- `/plan-ceo-review` — CEO review plan
- `/plan-eng-review` — Engineering review plan
- `/plan-design-review` — Design review plan
- `/design-consultation` — Design consultation
- `/design-shotgun` — Design shotgun
- `/review` — Code review
- `/ship` — Ship code
- `/land-and-deploy` — Land and deploy
- `/canary` — Canary deployment
- `/benchmark` — Benchmarking
- `/browse` — Web browsing (use this for all web browsing)
- `/connect-chrome` — Connect to Chrome
- `/qa` — QA testing
- `/qa-only` — QA only
- `/design-review` — Design review
- `/setup-browser-cookies` — Setup browser cookies
- `/setup-deploy` — Setup deployment
- `/retro` — Retrospective
- `/investigate` — Investigation
- `/document-release` — Document release
- `/codex` — Codex
- `/cso` — CSO
- `/autoplan` — Auto planning
- `/careful` — Careful mode
- `/freeze` — Freeze
- `/guard` — Guard
- `/unfreeze` — Unfreeze
- `/gstack-upgrade` — Upgrade gstack
