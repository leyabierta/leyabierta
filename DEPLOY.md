# Ley Abierta — Despliegue

## Arquitectura general

```
BOE API → GitHub Actions (pipeline diario) → repo "leyes" (git commits)
                                            → leyabierta.db (release asset)
                                            → Cloudflare Pages (web estática)

Usuario → Cloudflare CDN → HTML estático (web)
       → Cloudflare Tunnel → API (búsqueda, diffs, changelog)
```

- **Web:** 100% estática, desplegada en Cloudflare Pages (CDN global, BW ilimitado)
- **API:** Elysia + SQLite, containerizada con Docker, detrás de Cloudflare Tunnel
- **Pipeline:** GitHub Actions con cron diario, descarga reformas del BOE
- **Dominio:** `leyabierta.es` (DonDominio) con DNS delegado a Cloudflare

## Ramas y despliegue

**`main` es la rama de producción. Todo lo que entra en `main` acaba desplegado.**

El trabajo se acumula primero en `staging`, que no despliega nada:

```
rama de trabajo  →  PR  →  staging     checks completos, cero despliegue
staging          →  PR  →  main        un solo merge, despliega
```

Así se puede integrar y verificar un conjunto de cambios entero antes de que llegue a los usuarios, en vez de desplegar pieza a pieza.

Los checks (`pr-checks.yml`, CodeQL, revisión automática) se disparan por `pull_request` sin filtrar por rama destino, así que un PR contra `staging` se verifica exactamente igual que uno contra `main`.

### Qué dispara realmente un despliegue

`deploy.yml` se activa por tres vías, y conviene conocer las tres:

| Disparador | Cuándo ocurre |
|------------|---------------|
| `push` a `main` | al mergear cualquier PR a main |
| `workflow_dispatch` | despliegue manual desde la pestaña Actions |
| `repository_dispatch: pipeline-finished` | **lo lanza `scripts/daily-pipeline.sh`** en KonarServer, al final del pipeline diario (tras ingest, ingest-analisis, los pasos de IA y el checkpoint de WAL) |

La tercera es la que sorprende: **una vez que algo está en `main`, se desplegará en el siguiente ciclo diario aunque nadie toque el repo de código.** El flujo con `staging` da control sobre *cuándo entra algo en main*, no sobre si se despliega después — eso es automático.

`pipeline-finished` se dispara al **final** del pipeline diario, no al principio: hasta el 2026-09-25 el disparo era `leyes-updated`, lanzado por el repo `leyes` en el instante en que se le hacía `push` (paso 1.5 de `daily-pipeline.sh`), ~20-30 minutos antes de que terminaran el ingest y los pasos de IA. El despliegue diario servía entonces contenido de **ayer** (leyes nuevas, resúmenes de reformas y de artículos), y el contenido de hoy no aparecía hasta el despliegue del día siguiente. `deploy.yml` ya no escucha `leyes-updated`; `leyes-rebuild-backstop.yml` es la red de seguridad si `pipeline-finished` nunca llega (el pipeline muere a mitad de camino, falta el token, etc.) — espera un margen (`GRACE_MINUTES`, por defecto 90 min) desde el último `push` a `leyes` antes de desplegar igualmente, para no adelantarse al pipeline diario en marcha.

### Mantener staging sana

`staging` debe reiniciarse desde `main` después de cada promoción, y sincronizarse con `main` si este avanza por otra vía. Cuanto más diverjan, más difícil es verificar el conjunto y más probable el conflicto.

```bash
git checkout staging
git merge --ff-only origin/main   # tras promocionar staging → main
```

Una `staging` que lleva meses sin sincronizarse deja de ser útil: acumula conflictos y su diff frente a main deja de significar nada.

## CI/CD: GitHub Actions

> **Nota:** las tres secciones siguientes describen workflows que ya no existen
> con esos nombres. Hoy el despliegue es un único `deploy.yml` (web + API) y el
> pipeline diario corre en cron en el servidor, no en Actions. Pendiente de
> reescribir esta parte.

### deploy-web.yml

**Trigger:** push a main (paths: `packages/web/**`, `packages/pipeline/**`) + dispatch manual

1. Checkout código + shallow clone de `leyabierta/leyes`
2. Setup Node 24 + Bun
3. Build Astro estático (~12K páginas en ~30s)
4. Deploy a Cloudflare Pages via wrangler

**Limitación conocida:** el build necesita que la API esté activa (hace fetch en build time para algunas páginas). Si la API está caída, el build falla tras 10 reintentos.

**Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

### deploy-api.yml

**Trigger:** push a main (paths: `packages/api/**`, `Dockerfile`) + dispatch manual

1. Lint (`bun run check`)
2. Tests (`bun test`)
3. Build Docker image
4. Push a GitHub Container Registry (`ghcr.io/leyabierta/api:latest`)

El servidor de producción detecta automáticamente la nueva imagen y se actualiza sin intervención manual.

**Secrets:** `GITHUB_TOKEN` (automático)

### daily-pipeline.yml

**Trigger:** cron dual + dispatch manual

| Día | Cron | Modo | Qué hace | Tiempo |
|-----|------|------|----------|--------|
| Lun-Sáb | 06:00 UTC | Incremental | Lista normas del BOE, solo descarga las nuevas | ~2 min |
| Domingo | 04:00 UTC | Full sync | Re-descarga todas las normas, detecta actualizaciones | ~20-30 min |
| Manual | dispatch | Configurable | Con o sin `--force` | Depende |

**Idempotencia:** `commitNorm()` parsea trailers existentes (`Source-Id`, `Norm-Id`) para no duplicar commits. Re-procesar una norma nunca duplica — solo añade reformas que faltan.

**Limitación:** el modo incremental (Lun-Sáb) solo detecta normas **nuevas**, no actualizaciones a normas existentes. Una reforma publicada un martes no se verá hasta el full sync del domingo.

**Secrets:** `LEYES_PUSH_TOKEN` (PAT con write access a `leyabierta/leyes`), `LEYABIERTA_DISPATCH_TOKEN` (PAT usado para lanzar el `repository_dispatch: pipeline-finished` que dispara el despliegue web al terminar el pipeline — el mismo PAT que usa `leyes-rebuild-backstop.yml`)

## Costes

| Componente | Coste |
|------------|-------|
| Dominio (DonDominio) | ~7 EUR/año + IVA |
| Cloudflare (Pages + Tunnel + DNS) | Gratis (free tier) |
| GitHub Actions | Gratis (repo público) |
| Servidor | Coste del VPS |

## Límites del free tier de Cloudflare Pages

| Límite | Valor | Uso estimado |
|--------|-------|-------------|
| Archivos por deploy | 20,000 | ~12,200 |
| Tamaño por archivo | 25 MiB | <1 MiB |
| Builds por mes | 500 | ~30 |
| Bandwidth | Ilimitado | — |

## Para contribuidores

No necesitas acceso al servidor de producción para contribuir. El flujo es:

1. Fork o branch del repo
2. Desarrolla localmente (`bun run api`, `bun run web`)
3. Abre un PR **contra `staging`**, no contra `main`

Tu PR pasa por los mismos checks que uno contra main, pero no despliega nada.
La promoción de `staging` a `main` la hacen los mantenedores cuando el conjunto
de cambios está verificado.

Los secrets de producción están configurados en GitHub y en el servidor. Si necesitas acceso, contacta a los mantenedores.
