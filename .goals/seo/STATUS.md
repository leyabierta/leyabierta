# Estado SEO y experimentos en curso

Dónde estamos, qué se está probando y cuándo se lee el resultado. Complementa
[`GOAL.md`](GOAL.md) (objetivos), [`PLAYBOOK.md`](PLAYBOOK.md) (qué puede tocar
el loop) y [`EVAL.md`](EVAL.md) (cómo se puntúa un plan).

> **Si vas a tocar el sitemap, el Worker o las URLs de reforma, lee primero la
> sección de experimentos.** Hay uno vivo y un cambio despistado lo invalida.

**Última actualización:** 2026-07-28

---

## Diagnóstico actual

Medido con la URL Inspection API sobre 1.800 URLs (`scripts/seo/inspect-urls.ts`),
no estimado:

| Cohorte | Muestra | Rastreadas | Indexadas |
|---------|---------|-----------|-----------|
| Páginas de ley `/leyes/<id>/` | 1.178 | 99,1% | **13,2%** |
| Reformas `/cambios/reforma/…` | 600 | **0%** | **0%** |
| Páginas clave | 22 | 59% | 45% |

Search Console, ventana de 28 días a 2026-07-25: 2 clics, 1.116 impresiones,
CTR 0,18%, posición media 54.

**Son dos problemas distintos, y confundirlos lleva a arreglar lo que no es:**

1. **Reformas — problema de rastreo.** Google no las descarga. Ninguna de las
   600 muestreadas tiene `lastCrawlTime`. No se puede juzgar el contenido de una
   página que nunca se ha visitado. → Experimento A.
2. **Leyes — problema de valor percibido.** Google las descarga sin problema
   (`pageFetchState: SUCCESSFUL` en 385/400) y decide no indexarlas. El texto
   legal es idéntico al del BOE, que es la fuente autoritativa. Ningún ajuste
   técnico arregla esto; hace falta que la página aporte algo que el BOE no da.

**Corolario para priorizar:** con el 13,2% indexado, optimizar títulos, meta
descriptions o datos estructurados de páginas que Google no indexa no mueve
nada. Primero indexación, después presentación.

---

## Experimentos

### A — Forma de URL de las reformas · **en curso**

**Desplegado:** 2026-07-28 · **Lectura:** a partir de **2026-08-18**

Las ~35k URLs `/cambios/reforma/?id=&date=` nunca se han rastreado, mientras las
páginas de ley con paths reales sí (99,1%). Hipótesis: 35k URLs que solo
difieren en query string se leen como navegación facetada, y Google no gasta
presupuesto de rastreo en eso para un dominio con nuestra autoridad.

Las 688 reformas de 2026 se reparten por hash en dos brazos —348 con path y 340
con query, medido sobre el sitemap desplegado— para que ambos tengan la misma
frescura y estructura de enlaces: la única diferencia sistemática es la forma
de URL. Las reformas anteriores
siguen en query form y se reportan aparte, sin sustentar el veredicto.

**Métrica primaria: `crawlRate`, no `indexedRate`.** Google debe descargar la
página antes de poder juzgarla, y el bloqueo está en la descarga.

| Resultado | Condición | Qué hacer |
|-----------|-----------|-----------|
| ✅ Éxito | path > 20% rastreadas **y** control < 5% | Migrar las ~34.3k restantes |
| ❌ Fracaso | path < 5% **y** control ≥ 5% | La forma de URL no era el bloqueo; ir a enlazado y autoridad |
| ⏳ Sin señal | ambos brazos planos | Googlebot no ha vuelto — ampliar ventana, **no** concluir |

Con una mediana de rastreo de 74 días en el resto del sitio, tres semanas puede
quedarse corto. "Cero en ambos brazos" es ausencia de datos, no evidencia
contra la hipótesis.

**Código:** `packages/web/src/lib/reform-experiment.ts`. El criterio de reparto
lo importan el Worker, el sitemap y la ficha de ley — no puede divergir.
**No cambies `EXPERIMENT_YEAR` ni el reparto mientras el experimento corra.**

```bash
# Leer el resultado (en KonarServer)
cd /opt/leyabierta/seo-repo && set -a && . /opt/leyabierta/.env.seo && set +a
SEO_INSPECT_BUDGET=600 bun run scripts/seo/inspect-urls.ts
bun run scripts/seo/experiment-report.ts
```

### B — Descubrimiento de páginas clave · **desplegado 2026-07-28**

`/datos/` y `/pregunta/` estaban en "Google no reconoce esta URL": no rechazadas,
simplemente nunca ofrecidas — faltaban en el sitemap. `/pregunta/` es lo que
más nos diferencia del BOE (responde en lenguaje llano) y era invisible.

Añadidas junto con `/cambios/recientes/`. La lista vive en
`packages/web/src/lib/site-pages.ts` y un test
(`packages/web/src/__tests__/sitemap-coverage.test.ts`) comprueba que toda
página estática esté en el sitemap o excluida explícitamente con su motivo, en
ambos sentidos: una ruta excluida tampoco puede aparecer en el sitemap.

> ⚠️ **El test no es gate en CI.** `deploy.yml` ejecuta `bun test || true` y
> `pr-checks.yml` no ejecuta tests, así que un fallo no bloquea el merge ni el
> despliegue. Vale como red para quien ejecute los tests en local, no como
> garantía automática. Convertirlo en gate es trabajo aparte: el `|| true` está
> ahí porque algunos tests del repo necesitan ficheros de datos que no existen
> en CI.

Sin criterio formal de éxito: es corregir una omisión, no una hipótesis. Se
comprueba en la siguiente pasada de inspección.

---

## Abierto, sin atacar todavía

- **Las 12.000 páginas de ley (13,2% indexadas).** Necesita diferenciación real
  de contenido: que el HTML lleve por delante lo único nuestro (resúmenes
  ciudadanos por artículo, historial de reformas, diffs entre versiones) en vez
  de replicar articulado que el BOE ya tiene. Es el trabajo grande y el único
  que mueve esa cifra.
- **Cero rich results.** `searchAppearance` viene vacío. El JSON-LD
  `Legislation` es correcto como dato semántico pero **Google no genera rich
  results para ese tipo**. Hoy sólo emitimos `Legislation` + `BreadcrumbList`
  en las fichas de ley y `Organization`/`WebSite` en el layout: **no hay
  `Dataset` ni `Article` en ninguna página**. Son tipos que Google sí soporta y
  candidatos claros (`Dataset` en `/datos/`, `Article`/`NewsArticle` en las
  reformas), pero añadirlos antes de que esas páginas estén indexadas es
  optimizar algo que no existe. `FAQPage` no aplica: Google lo restringió en
  2023 a sitios gubernamentales y de salud.
- **Autoridad de dominio.** El único backlink que Google detecta hacia la home
  es `libhunt.com`. Sin enlaces externos, el presupuesto de rastreo se queda
  corto por mucho que arreglemos lo técnico.
- **El tráfico de buscadores llega de Bing**, no de Google (238 visitas vs 0 en
  30 días de Umami). Google indexa poco y posiciona en el puesto 54.
