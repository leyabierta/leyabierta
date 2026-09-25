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
| `repository_dispatch: leyes-updated` | **lo lanza el repo `leyes`** cada vez que `scripts/daily-pipeline.sh` le hace `push` en KonarServer |

La tercera es la que sorprende: **una vez que algo está en `main`, se desplegará en el siguiente ciclo diario aunque nadie toque el repo de código.** El flujo con `staging` da control sobre *cuándo entra algo en main*, no sobre si se despliega después — eso es automático.

**Cuándo se hace ese `push` a `leyes` importa.** Hasta el 2026-09-25 era el segundo paso del pipeline diario (justo después de generar los commits), ~20-30 minutos antes de que terminaran el ingest y los pasos de IA — así que el despliegue diario servía contenido de **ayer** (leyes nuevas, resúmenes de reformas y de artículos aparecían un día tarde). Desde entonces, `scripts/daily-pipeline.sh` hace ese `push` como su **último** paso (Step 9.6, después de ingest, ingest-analisis, los pasos de IA y el checkpoint de WAL), así que para cuando `leyes-updated` dispara el build, la base de datos que sirve la API ya tiene el contenido del día — nada cambió en `deploy.yml` ni en `leyes-rebuild-backstop.yml` para conseguir esto, solo el momento en el que el propio pipeline hace `push`. Si el pipeline muere antes de llegar a ese paso, un trap de error intenta igualmente publicar lo que ya se haya comitado localmente; si el `push` no llega de ninguna forma, `leyes-rebuild-backstop.yml` es la red de seguridad (comprueba cada 30 min si `leyes` avanzó y dispara el mismo evento).

### Mantener staging sana

`staging` debe reiniciarse desde `main` después de cada promoción, y sincronizarse con `main` si este avanza por otra vía. Cuanto más diverjan, más difícil es verificar el conjunto y más probable el conflicto.

```bash
git checkout staging
git merge --ff-only origin/main   # tras promocionar staging → main
```

Una `staging` que lleva meses sin sincronizarse deja de ser útil: acumula conflictos y su diff frente a main deja de significar nada.

## CI/CD: GitHub Actions

El despliegue es un único `deploy.yml` (web + API, ver la tabla de disparadores
más arriba). El pipeline diario (`scripts/daily-pipeline.sh`) corre en cron en
KonarServer, no en Actions — ver `docs/infrastructure.md` (privado) para el
cron, el contenedor y las variables de entorno, y la cabecera del propio
script para el detalle paso a paso (bootstrap → ingest → ingest-analisis → IA
→ OG images → emails → checkpoint de WAL → push a `leyes`).

**Secrets que usa `scripts/daily-pipeline.sh`:** `LEYES_PUSH_TOKEN` (PAT con
write access a `leyabierta/leyes`, usado para el `push` del último paso del
pipeline), `ALERT_WEBHOOK_URL` y `BETTERSTACK_HEARTBEAT_URL` (alertas y
liveness, opcionales). `leyes-rebuild-backstop.yml` (en GitHub Actions) usa por
su parte `LEYABIERTA_DISPATCH_TOKEN`, un PAT con permiso para lanzar
`repository_dispatch` contra `leyabierta/leyabierta` — configurado como secret
de GitHub Actions, no en el servidor.

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
