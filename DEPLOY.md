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
- Cloudflare Tunnel es conexión outbound (el servidor llama a Cloudflare, no al revés)
- GitHub Actions NO conoce la IP ni nombre del servidor
- No hay SSH keys del servidor en GitHub secrets
- Cloudflare filtra bots/DDoS antes de que lleguen al tunnel
- Rate limiting en Cloudflare protege la API
- HTTPS gratuito en ambos dominios (Cloudflare Universal SSL)

### Coste estimado

| Fase | Coste |
|------|-------|
| Ahora (0 usuarios) | Dominio DonDominio (~7 EUR/año + IVA) |
| Miles de usuarios | Dominio (~7 EUR/año + IVA) |
| Escala masiva | Cloudflare Pro $20/mes + dominio (mejora todo: WAF, cache, analytics) |

Todo usa free tiers: Cloudflare Pages (BW ilimitado, 20k archivos/deploy), Cloudflare Tunnel, GitHub Actions (repo público).

### Límites del free tier de Cloudflare Pages

| Límite | Valor | Uso estimado |
|--------|-------|-------------|
| Archivos por deploy | 20,000 | ~12,200 (12k leyes + assets) |
| Tamaño por archivo | 25 MiB | <1 MiB (HTML texto legal) |
| Builds por mes | 500 | ~30 (1/día) |
| Bandwidth | Ilimitado | — |
| Custom domains | 100 | 2 (apex + www) |

---

## Repos en GitHub

Organización: `leyabierta`

| Repo | Contenido |
|------|-----------|
| `leyabierta/leyabierta` | Código: pipeline + API + web (monorepo) |
| `leyabierta/leyes` | Legislación española: Markdown + git history |

---

## Fases de implementación

### Fase 0: Renombrado y organización de repos (COMPLETADO)

- Org `leyabierta` creada en GitHub
- Repos `leyabierta` y `leyes` creados y pusheados
- Todas las referencias actualizadas: leyes-es → leyes, leylibre → leyabierta
- Estructura local: `~/leyabierta/leyabierta/` (código) + `~/leyabierta/leyes/` (legislación)

### Fase 1: Astro estático (COMPLETADO)

- `output: "static"`, sin adapter, Cloudflare Pages puro (HTML en CDN)
- Custom `lawsLoader` que lee solo frontmatter YAML (3s para 12K leyes)
- Markdown body renderizado on-demand por página con `marked`
- Build completo: 12,282 páginas en 31 segundos
- Astro glob loader descartado (crasheaba tras 90+ min con 12K archivos / 370 MB)

### Fase 2: Dockerfile para la API (COMPLETADO)

- `Dockerfile`, `docker-compose.yml`, `.dockerignore`
- Base: `oven/bun:1-slim` + git (para GitService diffs)
- HEALTHCHECK contra `/health`
- Puerto `127.0.0.1:3000:3000` (solo localhost)

### Fase 3: Cloudflare Tunnel (COMPLETADO)

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

### Fase 4: GitHub Actions — CI/CD (COMPLETADO)

**`.github/workflows/deploy-web.yml`** — push a main o dispatch manual (COMPLETADO):
1. Checkout código + shallow clone de `leyabierta/leyes` (fetch-depth: 1)
2. Setup Node 24 + Bun (Astro 6 requiere Node >= 22.12.0)
3. Build Astro estático (31s para 12,282 páginas)
4. Deploy a Cloudflare Pages via wrangler (12K archivos, ~4 min upload)
- Tiempo total: ~6 min
- Secrets configurados: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Actions: checkout@v6, setup-node@v6, setup-bun@v2

**`.github/workflows/daily-pipeline.yml`** — dual cron + dispatch manual (COMPLETADO Y VERIFICADO):

Dos modos de operación:

| Día | Cron | Modo | Qué hace | Tiempo |
|-----|------|------|----------|--------|
| Lun-Sáb | 06:00 UTC | Incremental | Lista 12K norms del BOE, solo descarga las nuevas (no en StateStore) | ~2 min |
| Domingo | 04:00 UTC | Full sync | Re-descarga todas las normas, commitNorm salta duplicados (idempotente) | ~20-30 min |
| Manual | dispatch | Configurable | Con o sin `--force` | Depende |

**Verificado (2026-04-01):**
- Primer run: state seeded desde repo de leyes (12,235 norms), 0 pending, "Nothing to do" en 1m57s
- Test incremental: 3 normas eliminadas del state, pipeline las re-descargó y commiteó con fechas correctas en ~2 min

**Por qué dos modos:**
- El BOE no tiene un endpoint "qué cambió desde fecha X"
- El modo incremental (Lun-Sáb) es rápido pero solo detecta normas **nuevas**, no actualizaciones a normas existentes
- El full sync (Domingo) re-descarga todo y compara — `commitNorm` usa trailers (`Source-Id`, `Norm-Id`) para saber qué reformas ya están commiteadas y solo commitea las nuevas
- Si se cae un día, el siguiente lo recupera automáticamente

**Idempotencia:**
- `commitNorm()` llama a `loadExistingCommits()` que parsea todos los trailers del repo
- `hasCommitWithSourceId(sourceId, normId)` verifica si un commit ya existe
- Re-procesar una norma **nunca** duplica commits — solo añade reformas que faltan

**Cold start:**
- Si no hay `state.json` cacheado (primera ejecución o cache expirado), un step genera un state mínimo a partir de los archivos `.md` existentes en el repo de leyes
- Esto evita que el pipeline intente re-descargar 12K normas en la primera ejecución

**Caveats:**
- El full sync del domingo descarga ~12K normas del BOE (~24K requests). Con 4 workers y courtesy delay de 200ms, tarda ~20-30 min
- Si el BOE publica una **reforma a una norma existente** un lunes, no la veremos hasta el domingo (las normas **nuevas** sí se detectan inmediatamente)
- El StateStore (`data/state.json`) y los JSON cache se persisten entre runs via `actions/cache`

**Secrets necesarios:**
- `LEYES_PUSH_TOKEN`: Fine-grained PAT con write access a `leyabierta/leyes` (Contents: Read and write)
- `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`: para el deploy-web que se dispara automáticamente

### Fase 4c: Deploy API (COMPLETADO)

**`.github/workflows/deploy-api.yml`** — push a main (paths: `packages/api/**`, `packages/pipeline/**`, `Dockerfile`, `docker-compose.yml`) o dispatch manual:

1. Lint + test
2. Build Docker image
3. Push a `ghcr.io/leyabierta/api:latest` (+ tag `sha-XXXXXX`)

**Auto-update via Watchtower:**

El servidor no necesita ser notificado. Watchtower corre como sidecar en `docker-compose.yml` (profile `production`) y:

1. Cada 300 segundos (5 min) consulta GHCR por nuevas imágenes
2. Detecta que `ghcr.io/leyabierta/api:latest` tiene un digest nuevo
3. Descarga la imagen nueva
4. Rolling restart del contenedor API (sin downtime perceptible)
5. Limpia la imagen vieja (`WATCHTOWER_CLEANUP=true`)

**docker-compose.yml en producción:**
```bash
# En KonarServer: /opt/leyabierta/
docker compose --profile production up -d
```

Esto levanta dos contenedores:
- `api` — Elysia en `127.0.0.1:3000` (solo localhost, detrás de Cloudflare Tunnel via Traefik)
- `watchtower` — polling GHCR cada 5 min, solo actualiza contenedores con label `com.centurylinklabs.watchtower.enable=true`

**Flujo completo de deploy API:**
```
Push a main → GitHub Actions → build image → push GHCR
                                                   ↓
KonarServer ← Watchtower detecta nueva imagen (≤5 min)
           → pull image → rolling restart → API actualizada
```

**Dependencia del web build:**

`deploy-web.yml` comprueba que la API está activa antes de hacer build (`curl -sf https://api.leyabierta.es/health`). Si la API está caída, el build falla tras 10 reintentos. Esto es una limitación conocida: el build de Astro necesita la API para páginas que hacen fetch en build time (changelog, etc.).

### Fase 5: Actualización de DB en el servidor (COMPLETADO)

Script cron (`30 6 * * *`, 30 min después del pipeline):
```bash
#!/bin/bash
LATEST=$(curl -s https://api.github.com/repos/leyabierta/leyabierta/releases/latest \
  | jq -r '.assets[0].browser_download_url')
curl -L -o /tmp/leyabierta.db "$LATEST"
mv /tmp/leyabierta.db /opt/leyabierta/data/leyabierta.db
cd /opt/leyabierta/data/leyes && git pull
```

### Fase 6: Dominio y DNS

**Registrador:** DonDominio (~7 EUR/año + IVA). Elegido porque:
- Más barato con DNS completo para `.es`
- Permite delegar NS a Cloudflare (Strato NO lo permite para `.es`)
- Empresa española, precio consistente (registro = renovación)
- Cloudflare no vende dominios `.es` directamente

**Nota sobre SSL:** DonDominio no incluye SSL, pero es irrelevante. Cloudflare proporciona HTTPS gratuito (Universal SSL) para todo dominio proxied. No comprar SSL del registrador.

**Pasos:**
1. Registrar `leyabierta.es` en DonDominio
2. En DonDominio: cambiar nameservers a los de Cloudflare (`*.ns.cloudflare.com`)
3. En Cloudflare (panel gratuito):
   - Añadir sitio `leyabierta.es`
   - DNS: `leyabierta.es` → Cloudflare Pages (CNAME a `<proyecto>.pages.dev`)
   - DNS: `www.leyabierta.es` → redirect a apex (Page Rule o Redirect Rule)
   - DNS: `api.leyabierta.es` → Cloudflare Tunnel (CNAME automático al crear tunnel)
4. Activar: bot protection, DDoS, cache rules, HTTPS forzado
5. Verificar dominio en GitHub org (prevenir domain takeover)

### Fase 7: Rate limiting y protección

**Cloudflare (gratis):** Bot Fight Mode, cache rules para endpoints estáticos (ranks, materias, stats)

**Elysia (código):**
- Rate limiting por IP (middleware)
- CORS restrictivo: solo `leyabierta.es` y localhost
- Header `X-Robots-Tag: noindex` en respuestas API

---

## Orden de ejecución

| # | Fase | Estado | Siguiente paso |
|---|------|--------|---------------|
| 1 | Fase 0: Renombrado | HECHO | — |
| 2 | Fase 1: Astro estático | HECHO | — |
| 3 | Fase 2: Dockerfile API | HECHO | — |
| 4 | Fase 4: Deploy web (GitHub Actions) | HECHO | — |
| 5 | Fase 4b: Pipeline diario | HECHO | Verificado con test incremental |
| 6 | Fase 4c: Deploy API (GHCR + Watchtower) | HECHO | Auto-update cada 5 min |
| 7 | Fase 6: Dominio + DNS | HECHO | leyabierta.es apunta a Cloudflare Pages |
| 8 | Fase 3: Cloudflare Tunnel (API) | HECHO | api.leyabierta.es → localhost:3000 |
| 9 | Fase 5: Script DB servidor | HECHO | Cron diario + git pull |
| 10 | Fase 7: Rate limiting | PENDIENTE | Después de todo |

### Decisiones de infraestructura

| Decisión | Elegido | Alternativas descartadas | Razón |
|----------|---------|------------------------|-------|
| Registrador | DonDominio | Strato (no NS para .es), Namecheap (caro), Porkbun (no .es) | Más barato con NS delegation, empresa española |
| DNS | Cloudflare (gratis) | Strato DNS | Strato no permite NS delegation en .es |
| Web hosting | Cloudflare Pages | GitHub Pages (1GB límite), Netlify (300 min build), Vercel (no-comercial) | BW ilimitado, todo en Cloudflare, sin límites críticos |
| API hosting | Cloudflare Tunnel + KonarServer | Exponer servidor directamente | Sin puertos abiertos, DDoS gratis |
| SSL | Cloudflare Universal SSL (gratis) | SSL del registrador | Registrador SSL es irrelevante cuando el CDN termina HTTPS |

---

## Tamaño de datos estimado

| Dato | Tamaño |
|------|--------|
| JSON cache (raw) | 2.2 GB |
| Texto legislativo puro | ~1.9 GB |
| DB completa con FTS index | ~2.5-3 GB |
| DB sin historial de versiones | ~0.5 GB |

12,235 leyes consolidadas (1835-presente).

---

## Cron jobs en KonarServer

### Notificaciones diarias

```
0 9 * * * /opt/leyabierta/scripts/send-notifications.sh >> /opt/leyabierta/logs/send-notifications.log 2>&1
```

El script ejecuta `send-notifications.ts` dentro del contenedor Docker:

```bash
#!/bin/bash
docker exec leyabierta-api-1 bun run packages/api/src/scripts/send-notifications.ts
```

- **Hora:** 9:00 UTC diario
- **Qué hace:** Busca reformas con AI summary que no se han notificado aún, cruza con suscriptores por materias/jurisdicción, envía emails via Resend
- **Logs:** `/opt/leyabierta/logs/send-notifications.log`
- **Dependencia:** La API debe estar corriendo (ejecuta dentro del contenedor)

### Actualización de DB (Fase 5)

```
30 6 * * * /opt/leyabierta/scripts/update-db.sh
```

Descarga la última DB de GitHub Releases y hace `git pull` del repo de leyes.

---

## Variables de entorno en producción

**Archivo:** `/opt/leyabierta/.env.prod` (permisos `600`)

| Variable | Descripción |
|----------|-------------|
| `RESEND_API_KEY` | API key de Resend para envío de emails |
| `RESEND_AUDIENCE_ID` | ID de la audiencia en Resend (contactos suscritos) |
| `DB_PATH` | Ruta a la SQLite DB dentro del contenedor (e.g. `/data/leyabierta.db`) |
| `SITE_URL` | URL base del sitio (e.g. `https://leyabierta.es`) |

**IMPORTANTE:** No commitear valores reales de estas variables. Solo se documentan aquí los nombres y su propósito.
