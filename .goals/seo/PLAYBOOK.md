# SEO loop — Playbook (reglas del juego)

Estas son las reglas que gobiernan qué puede y qué no puede hacer el agente en
cada iteración. El paso "plan" propone acciones; el paso "implement" (`claude -p`)
las ejecuta. **Ambos deben respetar este playbook al pie de la letra.**

## Zona segura de edición (WHITELIST — solo esto)

El agente SOLO puede editar/crear ficheros dentro de estas rutas y para estos
fines:

| Área | Rutas | Qué puede hacer |
|------|-------|-----------------|
| Meta por página | `packages/web/src/pages/**/*.astro` (props de `<Base>`) | Mejorar `title`, `description`, `ogTitle`, `ogDescription`, `canonicalUrl`. |
| Structured data | `packages/web/src/components/**`, `packages/web/src/layouts/Base.astro` | Añadir JSON-LD (`schema.org`: `WebSite`, `BreadcrumbList`, `Legislation`/`Article`, `FAQPage`, `Organization`). |
| Internal linking | `packages/web/src/components/**`, `packages/web/src/pages/leyes/[id].astro` | Bloques de "normas relacionadas", enlaces contextuales entre páginas ya existentes. |
| Hub / landing pages | `packages/web/src/pages/**` (nuevas rutas informacionales) | Crear páginas temáticas que agrupen normas por materia/keyword, con contenido veraz derivado de datos ya publicados. |
| Sitemap hints | `packages/web/src/pages/sitemap.xml.ts` | Ajustar `priority`/`changefreq`. NO eliminar URLs. |
| Copy on-page | `packages/web/src/pages/**`, `packages/web/src/components/**` | Mejorar encabezados (H1/H2), texto introductorio veraz, alt text. |

## Prohibido (BLACKLIST — abortar si el plan lo requiere)

- ❌ Tocar `packages/api/**`, `packages/pipeline/**`, `packages/eval/**`,
  `packages/search-lab/**`, `packages/shared/**`, `data/**`, `scripts/**`
  (salvo `scripts/seo/**` que es este propio sistema, y aun así NO en la
  iteración automática).
- ❌ Modificar `robots.txt`, añadir `noindex`, o cambiar `canonical` de forma
  que desindexe páginas — salvo que el plan lo justifique explícitamente y
  lo marque con `requires_human_review: true`.
- ❌ Mover o renombrar URLs existentes sin redirect (perder ranking ganado).
- ❌ Tocar secrets, `.env*`, `docker-compose.yml`, workflows de `.github/`.
- ❌ Instalar dependencias nuevas sin marcar `requires_human_review: true`.
- ❌ Contenido falso, clickbait, o que tergiverse el contenido de una norma.
- ❌ Generación masiva de páginas de baja calidad (programmatic spam).
- ❌ `git push` a `main`, merge, o deploy directo. SOLO branch + PR.

## Cómo se decide una iteración (paso "plan")

1. Leer el snapshot GSC (`data/seo/gsc-<fecha>.json`) y Umami
   (`data/seo/umami-<fecha>.json`).
2. Leer `data/seo/STATE.md` (mejor-hasta-ahora, qué se descartó) y las últimas
   2 entradas de `data/seo/PROGRESS.md`.
3. Priorizar señales, en este orden:
   - **Striking distance:** queries en posición media 8–20 con impresiones
     altas → pequeñas mejoras de título/contenido pueden empujarlas a la
     página 1. Máximo ROI.
   - **CTR bajo con buena posición:** posición ≤ 10 pero CTR por debajo de la
     media → reescribir title/description.
   - **KWs en alza:** queries con más impresiones que el periodo anterior →
     reforzar con internal linking y contenido.
   - **Páginas con impresiones pero 0 clics:** revisar intención y snippet.
4. Elegir 3–6 acciones **independientes** (que no colisionen entre sí).
5. Emitir el plan como JSON (schema en `EVAL.md`). Cada acción incluye:
   ruta(s), tipo, hipótesis, impacto esperado, y si necesita revisión humana.

## Cómo se ejecuta (paso "implement")

1. `claude -p` recibe el plan JSON ganador y este playbook.
2. Aplica SOLO las acciones dentro de la whitelist.
3. Verifica: `bun run check` (biome). El build (`astro build`) es el gate real y
   corre en CI sobre el PR (`pr-checks.yml`), o localmente con `SEO_RUN_BUILD=1`.
   NO uses `tsgo`/`tsc`: no está configurado para el paquete Astro y escupe
   cientos de errores falsos preexistentes.
4. Si algo falla → revierte los cambios de esa acción y sigue con las demás.
   Si todo falla → aborta sin abrir PR y registra el fallo en PROGRESS.
5. Commit en la rama `seo-loop/iter-<N>-<fecha>`, push por deploy key. La Action
   `seo-open-pr.yml` abre el PR (el host no tiene token de API de GitHub).
6. El PR pasa por `pr-checks.yml` (build+smoke, vía trigger push). Un humano
   revisa y mergea. `claude-code-review.yml` es `pull_request`-only y no
   auto-corre en PRs del bot.

## Escalar a humano (NO auto-decidir)

- Cualquier acción con `requires_human_review: true`.
- El plan quiere tocar algo de la blacklist.
- Coste de la iteración > 5 €.
- Caída de clics/impresiones > 20% respecto al periodo anterior (posible
  penalización o bug) → NO improvisar, avisar.
- Dos iteraciones seguidas cuyo PR fue rechazado por el humano.
