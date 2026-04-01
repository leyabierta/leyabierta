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

### Fase 0: Renombrado y organizacion de repos (COMPLETADO)

- Org `leyabierta` creada en GitHub
- Repos `leyabierta` y `leyes` creados y pusheados
- Todas las referencias actualizadas: leyes-es → leyes, leylibre → leyabierta
- Estructura local: `~/leyabierta/leyabierta/` (codigo) + `~/leyabierta/leyes/` (legislacion)

### Fase 1: Astro estatico (COMPLETADO)

- `output: "static"`, sin adapter, Cloudflare Pages puro (HTML en CDN)
- Custom `lawsLoader` que lee solo frontmatter YAML (3s para 12K leyes)
- Markdown body renderizado on-demand por pagina con `marked`
- Build completo: 12,282 paginas en 31 segundos
- Astro glob loader descartado (crasheaba tras 90+ min con 12K archivos / 370MB)

### Fase 2: Dockerfile para la API (COMPLETADO)

- `Dockerfile`, `docker-compose.yml`, `.dockerignore`
- Base: `oven/bun:1-slim` + git (para GitService diffs)
- HEALTHCHECK contra `/health`
- Puerto `127.0.0.1:3000:3000` (solo localhost)

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

### Fase 4: GitHub Actions — CI/CD (PARCIAL)

**`.github/workflows/deploy-web.yml`** — push a main o dispatch manual (COMPLETADO):
1. Checkout codigo + shallow clone de `leyabierta/leyes` (fetch-depth: 1)
2. Setup Node 24 + Bun (Astro 6 requiere Node >= 22.12.0)
3. Build Astro estatico (31s para 12,282 paginas)
4. Deploy a Cloudflare Pages via wrangler (12K archivos, ~4 min upload)
- Tiempo total: ~6 min
- Secrets configurados: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Actions: checkout@v6, setup-node@v6, setup-bun@v2

**`.github/workflows/daily-pipeline.yml`** — dual cron + dispatch manual (IMPLEMENTADO):

Dos modos de operacion:

| Dia | Cron | Modo | Que hace | Tiempo |
|-----|------|------|----------|--------|
| Lun-Sab | 06:00 UTC | Incremental | Lista 12K norms del BOE, solo descarga las nuevas (no en StateStore) | ~3-5 min |
| Domingo | 04:00 UTC | Full sync | Re-descarga todas las normas, commitNorm salta duplicados (idempotente) | ~20-30 min |
| Manual | dispatch | Configurable | Con o sin `--force` | Depende |

**Por que dos modos:**
- El BOE no tiene un endpoint "que cambio desde fecha X"
- El modo incremental (Lun-Sab) es rapido pero solo detecta normas nuevas, no actualizaciones a normas existentes
- El full sync (Domingo) re-descarga todo y compara — `commitNorm` usa trailers (`Source-Id`, `Norm-Id`) para saber que reformas ya estan commiteadas y solo commitea las nuevas
- Este approach es robusto: si se cae un dia, el siguiente lo recupera

**Idempotencia:**
- `commitNorm()` llama a `loadExistingCommits()` que parsea todos los trailers del repo
- `hasCommitWithSourceId(sourceId, normId)` verifica si un commit ya existe
- Re-procesar una norma no duplica commits — solo anade reformas que faltan

**Caveats:**
- El full sync del domingo descarga ~12K normas del BOE (~24K requests). Con 4 workers y courtesy delay de 200ms, tarda ~20-30 min
- Si el BOE publica una reforma un lunes y la norma ya estaba en el StateStore, no la veremos hasta el domingo
- El StateStore (`data/state.json`) y los JSON cache se persisten entre runs via `actions/cache`

**Secrets necesarios:**
- `LEYES_PUSH_TOKEN`: Fine-grained PAT con write access a `leyabierta/leyes` (Contents: Read and write)

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
| # | Fase | Estado | Siguiente paso |
|---|------|--------|---------------|
| 1 | Fase 0: Renombrado | HECHO | — |
| 2 | Fase 1: Astro estatico | HECHO | — |
| 3 | Fase 2: Dockerfile API | HECHO | — |
| 4 | Fase 4: Deploy web (GitHub Actions) | HECHO | — |
| 5 | Fase 6: Dominio + DNS | PENDIENTE | Registrar leyabierta.es en DonDominio |
| 6 | Fase 3: Cloudflare Tunnel | PENDIENTE | Instalar cloudflared en servidor |
| 7 | Fase 5: Script DB | PENDIENTE | Despues de Fase 3 |
| 8 | Fase 7: Rate limiting | PENDIENTE | Despues de todo |

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

12,235 leyes consolidadas (1835-presente).
