# Estado SEO y experimentos en curso

Dónde estamos, qué se está probando y cuándo se lee el resultado. Complementa
[`GOAL.md`](GOAL.md) (objetivos), [`PLAYBOOK.md`](PLAYBOOK.md) (qué puede tocar
el loop) y [`EVAL.md`](EVAL.md) (cómo se puntúa un plan).

> **Si vas a tocar el sitemap, el Worker o las URLs de reforma, lee primero la
> sección de experimentos.** Hay uno vivo y un cambio despistado lo invalida.

**Última actualización:** 2026-08-21

---

## Diagnóstico actual

Medido con la URL Inspection API sobre 1.800 URLs (`scripts/seo/inspect-urls.ts`),
no estimado:

| Cohorte | Muestra | Rastreadas | Indexadas | vs 2026-07-28 |
|---------|---------|-----------|-----------|---------------|
| Páginas de ley `/leyes/<id>/` | 1.173 | 98,9% | **15,9%** | +2,7 pp |
| Reformas — brazo path | 299 | **0%** | **0%** | = |
| Reformas — brazo query (2026) | 287 | **0%** | **0%** | = |
| Reformas — query histórica | 22 | 100% | 86,4% | (cohorte sesgada, ver abajo) |
| Páginas clave | 11 | 36,4% | 36,4% | — |

> La cohorte "query histórica" **no es evidencia de nada**: son las URLs que ya
> reciben impresiones, y entran en la barrida por la cohorte de páginas con
> ranking. Están rastreadas *porque* ya rankean. Sesgo de selección — no la uses
> como control del experimento A.

Search Console, ventana de 28 días a 2026-08-18: 1 clic, 1.111 impresiones,
CTR 0,09%, posición media 54,5. Sin ninguna consulta en distancia de ataque
(posición 8–20) ni con CTR bajo: todo cae entre la posición 40 y 90.

### El dato que reencuadra el problema: no es el sitio, es Google

Umami, mismos 28 días (893 visitas totales, +5% sobre el periodo anterior):

| Fuente | Visitas |
|--------|---------|
| Ecosistema Bing (Bing, Yahoo, DuckDuckGo, Ecosia) | **334** |
| Asistentes de IA (ChatGPT, Copilot, Kagi, Perplexity) | **~25** |
| **Google** | **2** |

Bing rastrea el sitio, lo indexa y manda 334 visitas. Google manda 2 con 1.111
impresiones. Los mismos artículos que Google deja en "Rastreada: actualmente sin
indexar" a Bing le parecen suficientemente útiles para posicionarlos.

**Eso descarta la calidad de página como causa raíz y apunta a autoridad de
dominio.** Un motor con menos exigencia de autoridad ya nos da tráfico; el que
más exige, no. Encaja con el único backlink detectado (`libhunt.com`).

El tráfico de asistentes de IA aterriza en fichas de ley concretas
(`/leyes/BOE-A-2024-24099`, `BOE-A-2015-10565`…), no en `/pregunta/`: nos están
citando como fuente. Valida el trabajo de agent-readiness. Está plano entre
quincenas (~12 vs ~13), así que es un canal real pero pequeño, no una tendencia
al alza que se pueda dar por hecha.

**Son dos problemas distintos, y confundirlos lleva a arreglar lo que no es:**

1. **Reformas — problema de rastreo.** Google no las descarga. Ninguna de las
   586 muestreadas (ambos brazos) tiene `lastCrawlTime`. No se puede juzgar el
   contenido de una página que nunca se ha visitado. → Experimento A.
2. **Leyes — problema de autoridad, no de contenido.** Google las descarga sin
   problema (98,9%) y decide no indexar el 84%. Bing sí las indexa y las
   posiciona. Ningún ajuste técnico de la página arregla esto.

**Corolario para priorizar:** con el 15,9% indexado, optimizar títulos, meta
descriptions o datos estructurados de páginas que Google no indexa no mueve
nada. Primero indexación, después presentación. Y la palanca de indexación en
Google es autoridad — enlaces externos — no ajustes on-page.

---

## Experimentos

### A — Forma de URL de las reformas · **en curso, ventana ampliada**

**Desplegado:** 2026-07-28 · **Leído 2026-08-21: ⏳ SIN SEÑAL** ·
**Próxima lectura: 2026-09-22**

> #### Lectura del 2026-08-21 — no concluir, no migrar
>
> | Brazo | n | Rastreadas | Indexadas |
> |-------|---|-----------|-----------|
> | Tratamiento (path) | 299 | **0,0%** | 0,0% |
> | Control (query 2026) | 287 | **0,0%** | 0,0% |
>
> Ambos brazos planos a cero, con muestra por encima del umbral de 200 que pide
> el reporte. Es el caso "⏳ Sin señal" de la tabla de decisión: Googlebot no ha
> vuelto a esa parte del sitio. **Ausencia de datos, no evidencia contra la
> hipótesis. No migres las ~34k restantes.**
>
> **Lo que sí se movió: el descubrimiento.** 167 de 276 URLs del brazo path
> pasaron a "Descubierta: actualmente sin indexar" (109 siguen desconocidas). En
> la línea base ninguna reforma era siquiera conocida por Google. Eso desplaza
> el cuello de botella de *descubrimiento* a *presupuesto de rastreo*, que es un
> problema de autoridad de dominio — ver el diagnóstico de arriba.
>
> **Confusores descartados** (comprobados el 2026-08-21): ambos brazos devuelven
> 200; los `rel=canonical` son correctos y apuntan a la forma que el sitemap
> anuncia; el enlazado interno es simétrico (un enlace por reforma desde la
> ficha de ley, ambos con `?from=law`, que el canonical limpia); y ninguna
> reforma aparece en los dos brazos a la vez (377 únicas en path, 34.169 en
> query, intersección 0).
>
> **Por qué 2026-09-22 y no antes:** la mediana de rastreo del sitio es de ~21
> días, pero las reformas nunca se han rastreado, así que no hay periodicidad
> que aplicar. Un mes más da margen a que Googlebot vuelva. Si en esa lectura
> ambos brazos siguen a cero, cerrar como **no concluyente** y pasar a autoridad
> de dominio: el experimento no puede decidirse si Google no rastrea, y seguir
> esperando no lo cambia.

Las ~35k URLs `/cambios/reforma/?id=&date=` nunca se han rastreado, mientras las
páginas de ley con paths reales sí (99,1%). Hipótesis: 35k URLs que solo
difieren en query string se leen como navegación facetada, y Google no gasta
presupuesto de rastreo en eso para un dominio con nuestra autoridad.

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
contra la hipótesis. (Confirmado en la lectura del 2026-08-21: eso es
exactamente lo que pasó.)

**Código:** `packages/web/src/lib/reform-experiment.ts`. El criterio de reparto
lo importan el Worker, el sitemap y la ficha de ley — no puede divergir.
**No cambies `EXPERIMENT_YEAR` ni el reparto mientras el experimento corra.**

```bash
# Leer el resultado (en KonarServer)
cd /opt/leyabierta/seo-repo && set -a && . /opt/leyabierta/.env.seo && set +a
SEO_INSPECT_BUDGET=600 bun run scripts/seo/inspect-urls.ts
bun run scripts/seo/experiment-report.ts
```

> **Ojo con el presupuesto de inspección.** La cola se estratifica por brazo
> (`REFORM_SAMPLE_PER_ARM`, 300 por defecto) y `reforma-path` va primero por
> orden alfabético, así que una única pasada de 600 se gasta entera en el brazo
> tratamiento y deja el control sin muestra. La lectura del 2026-08-21 necesitó
> **tres pasadas de 600** (1.800 de la cuota diaria de 2.000) para llegar a
> n≥200 en ambos brazos. Presupuesta el día entero si vas a leer el experimento.
>
> También se puede leer desde local con la clave de servicio
> (`SEO_GSC_SA_JSON=…`), pero eso arranca sin la caché `inspections.json` del
> servidor: la mezcla de cohortes cambia y el `indexedRate` global no es
> comparable con el del servidor. Las tasas **por cohorte** sí lo son.

### B — Descubrimiento de páginas clave · **desplegado 2026-07-28**

`/datos/` y `/pregunta/` estaban en "Google no reconoce esta URL": no rechazadas,
simplemente nunca ofrecidas — faltaban en el sitemap. `/pregunta/` es lo que
más nos diferencia del BOE (responde en lenguaje llano) y era invisible.

Añadidas junto con `/cambios/recientes/`. La lista vive en
`packages/web/src/lib/site-pages.ts` y un test
(`packages/web/src/__tests__/sitemap-coverage.test.ts`) comprueba que toda
página estática esté en el sitemap o excluida explícitamente con su motivo, en
ambos sentidos: una ruta excluida tampoco puede aparecer en el sitemap.

> ✅ **El test es gate en CI desde el 2026-07-28** (PR #146). `pr-checks.yml`
> ejecuta `bun test` sin `|| true` en el job "Lint & test", y `deploy.yml`
> también. Un fallo bloquea el merge y el despliegue. (Este aviso decía lo
> contrario hasta el 2026-08-21; era cierto cuando se escribió y se quedó
> obsoleto al mergear #146.)

Sin criterio formal de éxito: es corregir una omisión, no una hipótesis. Se
comprueba en la siguiente pasada de inspección.

**Comprobado el 2026-08-21:** las cinco páginas están servidas (200) y presentes
en `sitemap-leyes.xml`, junto con las dos hubs temáticas de #149. Las páginas
clave siguen en 36,4% indexadas sobre n=11 — muestra demasiado pequeña para
leer nada. Las consultas que suben en GSC (`ley de empleo` 23 imp.,
`ley impuesto renta personas físicas` 11 imp. en posición 41) mapean contra las
hubs, pero se desplegaron hace días: es demasiado pronto para atribuirlo.

---

## Abierto, sin atacar todavía

- **Autoridad de dominio — ahora la prioridad número uno.** Los datos de Umami
  del 2026-08-21 (Bing 334 visitas, Google 2) descartan la calidad de página
  como causa raíz: el contenido le vale a Bing, a los asistentes de IA y no a
  Google. Lo que nos falta es lo que Google pondera y Bing no tanto: enlaces
  externos. Hoy Google detecta **un** backlink hacia la home (`libhunt.com`).
  Sin eso, ni el presupuesto de rastreo ni la indexación se mueven, y el resto
  de la lista de abajo son optimizaciones sobre páginas que Google no indexa.
- **Las 12.000 páginas de ley (15,9% indexadas).** Diferenciación de contenido:
  que el HTML lleve por delante lo único nuestro (resúmenes ciudadanos por
  artículo, historial de reformas, diffs entre versiones) en vez de replicar
  articulado que el BOE ya tiene. Sigue siendo trabajo grande y que merece la
  pena, pero ojo con la atribución: Bing ya indexa y posiciona estas mismas
  páginas sin esa diferenciación, así que no es lo que bloquea a Google.
- **Cero rich results.** `searchAppearance` viene vacío. El JSON-LD
  `Legislation` es correcto como dato semántico pero **Google no genera rich
  results para ese tipo**. Hoy sólo emitimos `Legislation` + `BreadcrumbList`
  en las fichas de ley y `Organization`/`WebSite` en el layout: **no hay
  `Dataset` ni `Article` en ninguna página**. Son tipos que Google sí soporta y
  candidatos claros (`Dataset` en `/datos/`, `Article`/`NewsArticle` en las
  reformas), pero añadirlos antes de que esas páginas estén indexadas es
  optimizar algo que no existe. `FAQPage` no aplica: Google lo restringió en
  2023 a sitios gubernamentales y de salud.
- **Sitemaps: pendiente de verificar.** El 2026-08-21 se reenvió
  `sitemap-reformas.xml` (`scripts/seo/resubmit-sitemap.ts`) para forzar
  revalidación: seguía reportando 160 errores de "fecha inválida" semanas
  después de desplegar el filtro `isPlausibleReformDate`, con `lastSubmitted`
  congelado en 2026-07-22. Google no recalcula al instante — **volver a mirar
  el contador de errores a partir del 2026-08-24**. Si sigue en 160, el fix no
  cubre todos los casos y hay que volver a mirar los datos, no el sitemap.
