# Ley Abierta — Plan de Despliegue

## Arquitectura

```
GitHub Actions (cron diario 06:00 UTC)
  1. Pipeline: descarga reformas del BOE
  2. Commitea en repo "leyes"
  3. Ingest: genera leyabierta.db
  4. Sube DB como release asset en GitHub
  5. Build Astro (static) → deploy a Cloudflare Pages

Cloudflare
  Pages → leyabierta.es (HTML estatico, CDN global)
  Tunnel → api.leyabierta.es (proxy a servidor privado)
  Bot protection + DDoS gratis en ambos

Servidor privado (detras Tailscale, sin puertos abiertos)
  cloudflared (tunnel outbound → Cloudflare)
  Docker: Elysia API + SQLite
  Cron: descarga DB nueva de GitHub releases cada dia
  Clone de "leyes" repo (para git diff/history)
```

### Flujo de datos

```
BOE API → GitHub Actions → repo "leyes" (git push)
                         → leyabierta.db (release asset)
                         → Cloudflare Pages (astro build)

GitHub Releases ← servidor descarga DB (pull, no push)
repo "leyes"   ← servidor hace git pull (para diffs)

Usuario → Cloudflare CDN → HTML estatico (99% del trafico)
       → Cloudflare Tunnel → servidor API (solo busqueda/diffs)
```

### Seguridad

- El servidor NO tiene puertos abiertos al internet
- Cloudflare Tunnel es conexion outbound (el servidor llama a Cloudflare, no al reves)
- GitHub Actions NO conoce la IP ni nombre del servidor
- No hay SSH keys del servidor en GitHub secrets
- Cloudflare filtra bots/DDoS antes de que lleguen al tunnel
- Rate limiting en Cloudflare protege la API

### Coste estimado

| Fase | Coste |
|------|-------|
| Ahora (0 usuarios) | Dominio (~8 EUR/ano) |
| Miles de usuarios | Dominio (~8 EUR/ano) |
| Escala masiva | Cloudflare Workers $5/mes + dominio |

Todo usa free tiers: Cloudflare Pages, Cloudflare Tunnel, GitHub Actions (repo publico).

---

## Repos en GitHub

Organizacion: `leyabierta`

| Repo | Contenido |
|------|-----------|
| `leyabierta/leyabierta` | Codigo: pipeline + API + web (monorepo) |
| `leyabierta/leyes` | Legislacion espanola: Markdown + git history |

---

## Fases de implementacion

### Fase 0: Renombrado y organizacion de repos

**Archivos a modificar:**
- `package.json` (root) — name: "leyabierta"
- `packages/web/` — referencias a "Ley Libre" en templates
- `packages/api/src/index.ts` — nombre en swagger/health
- `packages/pipeline/` — author en commits ("Ley Abierta <bot@leyabierta.es>")

**Acciones manuales:**
- Crear org `leyabierta` en GitHub
- Crear repos `leyabierta` y `leyes`
- Push inicial

### Fase 1: Astro a modo estatico

**Archivos a modificar:**
- `packages/web/astro.config.mjs` — cambiar output de "server" a "static"
- `packages/web/src/lib/api.ts` — API_BASE en build time para paginas estaticas
- Eliminar dependencia de `@astrojs/node`

**Consideraciones:**
- Home, paginas de leyes, diffs, anomalias, feed, sitemap → estaticas
- Busqueda → client-side JS contra la API directamente
- Alertas/suscripciones → client-side JS contra la API

### Fase 2: Dockerfile para la API

**Archivos nuevos:**
- `Dockerfile` (solo API, no web)
- `docker-compose.yml` (API + volumes)
- `.dockerignore`

```dockerfile
FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/api/package.json packages/api/
COPY packages/pipeline/package.json packages/pipeline/
RUN bun install --production
COPY packages/api packages/api
COPY packages/pipeline packages/pipeline
COPY tsconfig.json .
EXPOSE 3000
ENV DB_PATH=/data/leyabierta.db
ENV REPO_PATH=/data/leyes
CMD ["bun", "run", "packages/api/src/index.ts"]
```

```yaml
# docker-compose.yml
services:
  api:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"  # Solo localhost, Cloudflare Tunnel expone
    volumes:
      - ./data:/data
    environment:
      - DB_PATH=/data/leyabierta.db
      - REPO_PATH=/data/leyes
```

### Fase 3: Cloudflare Tunnel

**En el servidor:**
1. Instalar `cloudflared`
2. `cloudflared tunnel create leyabierta`
3. Configurar tunnel: `api.leyabierta.es` → `http://localhost:3000`
4. Ejecutar como servicio systemd

**Config (`~/.cloudflared/config.yml`):**
```yaml
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: api.leyabierta.es
    service: http://localhost:3000
  - service: http_status:404
```

### Fase 4: GitHub Actions — CI/CD

**`.github/workflows/ci.yml`** — push a main:
- Install, lint (biome check), test (bun test)

**`.github/workflows/deploy-web.yml`** — push a main o dispatch manual:
1. Build Astro (output: static)
2. Deploy a Cloudflare Pages via `wrangler pages deploy`
- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

**`.github/workflows/daily-pipeline.yml`** — cron `0 6 * * *` + dispatch manual:
1. Checkout repos `leyabierta` y `leyes`
2. Run pipeline: `bun run pipeline bootstrap --country es`
3. Commit + push cambios en `leyes`
4. Run ingest: genera `leyabierta.db`
5. Subir DB como GitHub Release asset
6. Trigger deploy-web

### Fase 5: Actualizacion de DB en el servidor

Script cron (`30 6 * * *`, 30 min despues del pipeline):
```bash
#!/bin/bash
LATEST=$(curl -s https://api.github.com/repos/leyabierta/leyabierta/releases/latest \
  | jq -r '.assets[0].browser_download_url')
curl -L -o /tmp/leyabierta.db "$LATEST"
mv /tmp/leyabierta.db /opt/leyabierta/data/leyabierta.db
cd /opt/leyabierta/data/leyes && git pull
```

### Fase 6: Dominio y DNS

1. Comprar `leyabierta.es`
2. Nameservers → Cloudflare
3. DNS:
   - `leyabierta.es` → Cloudflare Pages (CNAME)
   - `api.leyabierta.es` → Cloudflare Tunnel (CNAME automatico)
4. Activar: bot protection, DDoS, cache rules

### Fase 7: Rate limiting y proteccion

**Cloudflare (gratis):** Bot Fight Mode, cache rules para endpoints estaticos (ranks, materias, stats)

**Elysia (codigo):**
- Rate limiting por IP (middleware)
- CORS restrictivo: solo `leyabierta.es` y localhost
- Header `X-Robots-Tag: noindex` en respuestas API

---

## Orden de ejecucion

| # | Fase | Tipo | Dependencias |
|---|------|------|-------------|
| 1 | Fase 0: Renombrado | Codigo + manual | Ninguna |
| 2 | Fase 1: Astro estatico | Codigo | Fase 0 |
| 3 | Fase 2: Dockerfile API | Codigo | Fase 0 |
| 4 | Fase 6: Dominio + Cloudflare | Manual | Comprar dominio |
| 5 | Fase 3: Cloudflare Tunnel | Manual (servidor) | Fase 6 |
| 6 | Fase 4: GitHub Actions | Codigo | Fases 0-2 |
| 7 | Fase 5: Script DB | Manual (servidor) | Fases 4, 6 |
| 8 | Fase 7: Rate limiting | Codigo + Cloudflare | Fases 3, 4 |

Fases 0-2 son codigo. Fases 3-6 requieren acciones manuales. Fase 7 es mixta.

---

## Tamano de datos estimado

| Dato | Tamano |
|------|--------|
| JSON cache (raw) | 2.2 GB |
| Texto legislativo puro | ~1.9 GB |
| DB completa con FTS index | ~2.5-3 GB |
| DB sin historial de versiones | ~0.5 GB |

12,232 leyes consolidadas (1835-presente).
