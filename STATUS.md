# Ley Abierta — Estado del Proyecto

Documento de referencia para continuar el desarrollo en futuras sesiones.

## Que es Ley Abierta

Un motor open source en TypeScript que descarga legislacion oficial (empezando por Espana/BOE), la convierte en archivos Markdown versionados con Git — donde cada reforma es un commit con su fecha historica — y expone esos datos mediante una API y una web para que cualquiera pueda buscar, comparar versiones y entender como cambian las leyes.

**Principios:** Open source para siempre. Sin monetizacion. Ciudadano primero. Transparencia total.

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Pipeline | TypeScript (monorepo, ~3,000 LOC) |
| API | Elysia (Bun-native) + SQLite FTS5 |
| Web | Astro 6 (static, custom content loader) |
| DB | SQLite (bun:sqlite, FTS5 full-text search) |
| Deploy (Web) | Cloudflare Pages (CDN global) |
| Deploy (API) | Docker + Cloudflare Tunnel en KonarServer (Hetzner) |
| CI/CD | GitHub Actions |

## Que se ha hecho

### Pipeline (funcional, 2026-03-30 → 2026-04-01)
- BOE Client con rate limiting (~5 req/s)
- XML Parser (fast-xml-parser)
- Markdown generation con frontmatter YAML y estructura semantica (headings para titulos/capitulos/articulos, separadores entre articulos)
- Git integration con fechas historicas, idempotencia y orden cronologico global
- 12,235 leyes procesadas, 42,851 commits en repo `leyes`
- Comando `rebuild` para regenerar desde JSON cache sin re-descargar del BOE
- Commit messages en espanol: "Constitucion Espanola — publicacion original (1978)"
- Country registry pattern (multi-pais pluggable)

### API (funcional)
- Elysia REST API con 12 endpoints
- SQLite + FTS5 para busqueda full-text
- GitService con soporte para fechas pre-1970 (usa trailers Source-Date)
- Dockerfile listo

### Web (desplegada, 2026-04-01)
- Astro 6 estatico con custom content loader (12,235 leyes en 3s de content sync)
- Build completo: 12,282 paginas en 31 segundos
- Custom `lawsLoader` que lee solo frontmatter YAML (vs glob loader que crasheaba tras 90 min)
- Markdown renderizado on-demand por pagina con `marked`
- Tabs: Resumen (API), Historial de cambios (API), Texto completo (SSG)
- Dark mode, SEO, JSON-LD, sitemap, RSS feed
- Deploy a Cloudflare Pages via GitHub Actions (6 min)

### Repos en GitHub (org: leyabierta)
- `leyabierta/leyabierta` — codigo (pipeline + API + web)
- `leyabierta/leyes` — 42,851 commits, 12,235 leyes, 18 jurisdicciones, orden cronologico

### Infraestructura
- Dominio: `leyabierta.es` registrado en DonDominio, NS delegados a Cloudflare
- Web: `leyabierta.es` en Cloudflare Pages, 12,282 paginas estaticas
- API: `api.leyabierta.es` en KonarServer (Hetzner), Docker + Cloudflare Tunnel (systemd)
- SQLite DB: 4.7GB con FTS5, 12,235 leyes
- GitHub Actions: `deploy-web.yml` (build + deploy en ~6 min) y `daily-pipeline.yml` (incremental Lun-Sab + full sync Domingo)
- Pipeline diario verificado con test incremental (3 normas nuevas detectadas y commiteadas correctamente)

## Lo que falta

### Prioridad alta
1. ~~**API en produccion**~~ — HECHO (2026-04-01). Docker + Cloudflare Tunnel en KonarServer, `api.leyabierta.es`
2. **SEO y optimizacion web** — Auditar meta tags, Open Graph, JSON-LD, Core Web Vitals, Lighthouse score. Optimizar para que las leyes aparezcan bien en Google y redes sociales
3. **Tabs Resumen/Reformas como SSG** — actualmente dependen de la API, deberian ser estaticas (sin API esas pestanas muestran "Cargando..." infinito)

### Prioridad media
4. **Post en Hacker News** — Preparar un Show HN con el pitch del proyecto: legislation-as-code, Git history for laws, open source, 12K+ Spanish laws desde 1835. Redactar titulo y primer comentario. Timing: cuando SEO y QA esten pulidos
5. **Newsletter / Weekly Digest** (feat branch futura) — Perfiles tematicos definidos (8), scripts parciales. Requiere trabajo serio antes de activar:
   - **Seguridad/GDPR:** encriptacion de emails en DB, politica de retencion, consentimiento explicito, derecho al olvido, audit log
   - **Tecnico:** templates HTML (web + email), arreglar send-digest.ts (referencia profile.materias inexistente), UI suscripcion, cron semanal
   - **Infra:** RESEND_API_KEY, dominio verificado para envio
   - No es critica para lanzamiento — las leyes se ven y buscan sin esto
6. **Mejora del markdown** — preservar CSS classes originales del BOE en los JSON cache (requiere re-fetch de las 12K normas). Actualmente se infieren por regex, lo cual cubre ~90% de los casos
7. **DB como release asset** — el daily pipeline deberia generar `leyabierta.db` y subirlo como release para que el servidor lo descargue
8. **Script actualizacion DB en servidor** — cron que descarga DB de GitHub Releases

### Prioridad baja
9. **Rate limiting y hardening** — Cloudflare Bot Fight Mode, CORS restrictivo en API

## Limitaciones conocidas

### Fechas pre-1970
Git no soporta fechas antes de Unix epoch (1970-01-01). 334 leyes (1835-1969) tienen su commit date clamped a 1970-01-02. La fecha real esta en:
- Frontmatter YAML (`fecha_publicacion`)
- Trailer del commit (`Source-Date`)
- La web y API usan la fecha real, no la del commit

### Build de Astro con 12K leyes
El glob loader nativo de Astro crashea con 12K archivos markdown (370MB). Solucionado con custom `lawsLoader` que solo lee frontmatter. El body se renderiza on-demand por pagina con `marked` en vez del pipeline remark/rehype de Astro.

### Cloudflare Pages free tier
- Max 20,000 archivos por deploy (usamos ~12,300 — margen OK)
- Max 500 builds/mes (usamos ~30 — margen OK)
- Bandwidth ilimitado

## Informacion clave del BOE

- **API base:** `https://www.boe.es/datosabiertos/api/`
- **Sin rate limits** documentados, sin API key, CORS abierto
- **12,235 leyes consolidadas** (1835-presente, 8,636 estatales + 3,599 autonomicas)
- **Atribucion requerida:** "Fuente: Agencia Estatal BOE" + link a boe.es

## Como continuar

```bash
cd ~/00_Programacion/01_Alex/leyabierta/leyabierta

# Ver que todo funciona
bun test
bun run check

# Build web local
LAWS_PATH=../leyes bun run --cwd packages/web build

# Dev server
LAWS_PATH=../leyes bun run web

# Rebuild leyes desde cache (~56 min)
bun run pipeline rebuild --repo ../leyes

# API local
bun run api
```
