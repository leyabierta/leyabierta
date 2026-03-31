# Ley Abierta — Plan de Despliegue

## Arquitectura

```
Registrador: DonDominio (~7 EUR/ano + IVA)
  NS delegados a Cloudflare (gratis)

Cloudflare (free tier — todo en un solo panel)
  DNS         → leyabierta.es + api.leyabierta.es
  Pages       → leyabierta.es (HTML estatico, CDN global, BW ilimitado)
  Tunnel      → api.leyabierta.es (proxy a servidor privado)
  Bot protection + DDoS + cache + analytics gratis

GitHub Actions (cron diario 06:00 UTC)
  1. Pipeline: descarga reformas del BOE
  2. Commitea en repo "leyes"
  3. Ingest: genera leyabierta.db
  4. Sube DB como release asset en GitHub
  5. Build Astro (static) → deploy a Cloudflare Pages (wrangler)

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
                         → Cloudflare Pages (wrangler pages deploy)

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
- HTTPS gratuito en ambos dominios (Cloudflare Universal SSL)

### Coste estimado

| Fase | Coste |
|------|-------|
| Ahora (0 usuarios) | Dominio DonDominio (~7 EUR/ano + IVA) |
| Miles de usuarios | Dominio (~7 EUR/ano + IVA) |
| Escala masiva | Cloudflare Pro $20/mes + dominio (mejora todo: WAF, cache, analytics) |

Todo usa free tiers: Cloudflare Pages (BW ilimitado, 20k archivos/deploy), Cloudflare Tunnel, GitHub Actions (repo publico).

### Limites del free tier de Cloudflare Pages

| Limite | Valor | Uso estimado |
|--------|-------|-------------|
| Archivos por deploy | 20,000 | ~12,200 (12k leyes + assets) |
| Tamano por archivo | 25 MiB | <1 MiB (HTML texto legal) |
| Builds por mes | 500 | ~30 (1/dia) |
| Bandwidth | Ilimitado | — |
| Custom domains | 100 | 2 (apex + www) |

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

### Fase 1: Astro estatico con Content Collections (COMPLETADO)

**Arquitectura:** `output: "static"`, sin adapter. Content Collections lee los Markdown del repo de leyes directamente desde disco. Cloudflare Pages puro (HTML en CDN, sin compute).

**Archivos modificados:**
- `packages/web/astro.config.mjs` — `output: "static"`, sin adapter
- `packages/web/package.json` — eliminada dependencia de `@astrojs/cloudflare`
- `packages/web/src/content.config.ts` — collection `laws` con glob loader
- `packages/web/src/pages/laws/[id].astro` — getStaticPaths() desde Content Collections
- `packages/web/src/pages/diff.astro` — pagina unica, diff 100% client-side
- `packages/web/src/pages/index.astro` — landing desde collection, busqueda client-side
- `packages/web/src/pages/alertas/confirmar.astro` — client-side token handling
- `packages/web/src/pages/alertas/cancelar.astro` — client-side token handling
- Feed RSS y sitemap generados desde Content Collections (sin API)
- Eliminado: `pages/api/subscribe.ts` (frontend llama API directamente)

**Paginas estaticas (build):** leyes, landing, anomalias, alertas, resumenes, feed, sitemap
**Client-side JS (runtime):** busqueda, diffs, resumen/historial tabs, suscripciones

### Fase 2: Dockerfile para la API (COMPLETADO)

**Archivos creados:** `Dockerfile`, `docker-compose.yml`, `.dockerignore`
- Base: `oven/bun:1-slim` + git (para GitService diffs)
- HEALTHCHECK contra `/health`
- Puerto `127.0.0.1:3000:3000` (solo localhost)
- Volume `./data:/data` para DB + repo leyes

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

**`.github/workflows/ci.yml`** — push a main y PRs (COMPLETADO):
- Install (`bun install --frozen-lockfile`), lint (`bun run check`), test (`bun test`)

**`.github/workflows/deploy-web.yml`** — push a main o dispatch manual (PENDIENTE):
1. Install deps (`bun install --frozen-lockfile`)
2. Build Astro estatico (`bun run build` en `packages/web`)
3. Deploy a Cloudflare Pages via `bunx wrangler pages deploy dist --project-name=leyabierta`
- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- El proyecto Cloudflare Pages se crea una vez desde el dashboard o con `wrangler pages project create leyabierta`

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

**Registrador:** DonDominio (~7 EUR/ano + IVA). Elegido porque:
- Mas barato con DNS completo para `.es`
- Permite delegar NS a Cloudflare (Strato NO lo permite para `.es`)
- Empresa espanola, precio consistente (registro = renovacion)
- Cloudflare no vende dominios `.es` directamente

**Nota sobre SSL:** DonDominio no incluye SSL, pero es irrelevante. Cloudflare proporciona HTTPS gratuito (Universal SSL) para todo dominio proxied. No comprar SSL del registrador.

**Pasos:**
1. Registrar `leyabierta.es` en DonDominio
2. En DonDominio: cambiar nameservers a los de Cloudflare (`*.ns.cloudflare.com`)
3. En Cloudflare (panel gratuito):
   - Anadir sitio `leyabierta.es`
   - DNS: `leyabierta.es` → Cloudflare Pages (CNAME a `<proyecto>.pages.dev`)
   - DNS: `www.leyabierta.es` → redirect a apex (Page Rule o Redirect Rule)
   - DNS: `api.leyabierta.es` → Cloudflare Tunnel (CNAME automatico al crear tunnel)
4. Activar: bot protection, DDoS, cache rules, HTTPS forzado
5. Verificar dominio en GitHub org (prevenir domain takeover)

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
| 4 | Fase 6: Dominio (DonDominio) + NS a Cloudflare | Manual | Registrar dominio |
| 5 | Fase 3: Cloudflare Tunnel | Manual (servidor) | Fase 6 |
| 6 | Fase 4: GitHub Actions (CI + deploy a Cloudflare Pages) | Codigo | Fases 0-2, 6 |
| 7 | Fase 5: Script DB | Manual (servidor) | Fases 4, 6 |
| 8 | Fase 7: Rate limiting | Codigo + Cloudflare | Fases 3, 4 |

Fases 0-2 son codigo. Fases 3-6 requieren acciones manuales. Fase 7 es mixta.

### Decisiones de infraestructura

| Decision | Elegido | Alternativas descartadas | Razon |
|----------|---------|------------------------|-------|
| Registrador | DonDominio | Strato (no NS para .es), Namecheap (caro), Porkbun (no .es) | Mas barato con NS delegation, empresa espanola |
| DNS | Cloudflare (gratis) | Strato DNS | Strato no permite NS delegation en .es |
| Web hosting | Cloudflare Pages | GitHub Pages (1GB limite), Netlify (300 min build), Vercel (no-comercial) | BW ilimitado, todo en Cloudflare, sin limites criticos |
| API hosting | Cloudflare Tunnel + KonarServer | Exponer servidor directamente | Sin puertos abiertos, DDoS gratis |
| SSL | Cloudflare Universal SSL (gratis) | SSL del registrador | Registrador SSL es irrelevante cuando el CDN termina HTTPS |

---

## Tamano de datos estimado

| Dato | Tamano |
|------|--------|
| JSON cache (raw) | 2.2 GB |
| Texto legislativo puro | ~1.9 GB |
| DB completa con FTS index | ~2.5-3 GB |
| DB sin historial de versiones | ~0.5 GB |

12,232 leyes consolidadas (1835-presente).
