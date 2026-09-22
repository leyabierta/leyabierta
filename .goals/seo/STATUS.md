# Estado SEO y experimentos en curso

Dónde estamos, qué se está probando y cuándo se lee el resultado. Complementa
[`GOAL.md`](GOAL.md) (objetivos), [`PLAYBOOK.md`](PLAYBOOK.md) (qué puede tocar
el loop) y [`EVAL.md`](EVAL.md) (cómo se puntúa un plan).

> Experimento A cerrado el 2026-09-22 (no concluyente): ya no hay nada vivo que
> proteja el sitemap, el Worker o las URLs de reforma. Lee su cierre antes de
> tocarlos de todos modos, para no repetir la apuesta.

**Última actualización:** 2026-09-23

---

## Diagnóstico actual

### Indexación — medición del 2026-09-22

Medido con la URL Inspection API (`scripts/seo/inspect-urls.ts`, tres pasadas de
600 desde local), no estimado. Es la lectura formal del experimento A.

| Cohorte | Muestra | Rastreadas | Indexadas | vs 2026-08-21 |
|---------|---------|-----------|-----------|---------------|
| Páginas de ley `/leyes/<id>/` | 2.337 | 99,1% | **15,9%** | = |
| Reformas — brazo path | 390 | **0%** | **0%** | = |
| Reformas — brazo query (2026) | 387 | **0%** | **0%** | = |
| Reformas — query histórica | 39 | 100% | 84,6% | (cohorte sesgada, ver abajo) |
| Páginas clave | 11 | 36,4% | 36,4% | = |

Un mes después, nada se ha movido. El 15,9% de las leyes es idéntico sobre una
muestra el doble de grande, lo que refuerza que es la tasa real y no ruido.

> La cohorte "query histórica" **no es evidencia de nada**: son las URLs que ya
> reciben impresiones, y entran en la barrida por la cohorte de páginas con
> ranking. Están rastreadas *porque* ya rankean. Sesgo de selección — no la uses
> como control del experimento A.

### Search Console — ventana de 28 días a 2026-09-17

| Métrica | 2026-09-17 | 2026-09-13 | 2026-08-15 |
|---------|-----------:|-----------:|-----------:|
| Clics | **3** | 2 | 1 |
| Impresiones | **2.304** | 2.167 | 1.066 |
| Posición media | **48,9** | 49,4 | 55,6 |
| Páginas con impresiones | **360** | 352 | 216 |

Las impresiones siguen subiendo y la posición media sigue mejorando. Aun así,
**por quinta iteración consecutiva no hay ninguna consulta en distancia de
ataque (posición 8–20) ni ninguna con CTR bajo**: las palancas 1 y 2 del
PLAYBOOK llevan vacías desde julio, y el patrón está lo bastante asentado como
para no ser ruido de una ventana mala. Lo que crece son head terms genéricos que
aterrizan en la home entre la posición 60 y 97 — "derechos legales españa" (38,
pos 62), "ley de empleo" (41, pos 70), "ley laboral españa" (35, pos 83).

**Revisión del 2026-09-22 (ventana a 2026-09-19):** sin cambios de fondo. Mismas
2.304 impresiones y 3 clics, posición 49,1, los tres sitemaps con 0 errores
(`sitemap-reformas.xml` descargado de nuevo el 22/09). Los hubs, `/datos/` y las
reformas en forma path siguen sin impresiones. Las consultas de marca siguen a
cero. El snapshot de Umami no se pudo sacar (el SSH a KonarServer daba
timeout desde el tailnet en uso).

### Colisión de marca con leyabierta.com · **detectado 2026-09-16**

Consultando GSC con un filtro `query contains "abierta"` sobre 90 días
(2026-06-16..2026-09-14): **cero impresiones** para "ley abierta" o
"leyabierta". Ni una. La única fila que devuelve el filtro es
"sociedad anonima abierta" (2 impresiones). No es que rankeemos mal para nuestro
propio nombre — es que Google no nos considera para él.

`leyabierta.com` **no es un dominio okupa**: es un proyecto homónimo real y vivo
("Ley Abierta — Leyes españolas en lenguaje claro", Next.js, desarrollado por
Wahandri), con `robots: index, follow`. Mismo nombre, mismo país, mismo tema.
Ante dos candidatos idénticos en nombre, Google se queda con el que tiene
señales externas — y el `.com` exacto además parte con ventaja en una consulta
de marca.

`/sobre/` es la única página nuestra que aparece para consultas de marca, con 5
impresiones en **posición 3,2**, y todas ellas anonimizadas por GSC (volumen tan
bajo que no las desglosa). Por eso es la página de identidad del proyecto.

**Qué se ha hecho (iteración 4, PR #159):** consolidación de entidad en el
JSON-LD de `Base.astro` (`alternateName`, `sameAs` a la organización de GitHub y
a la ficha de datos.gob.es, `subjectOf` con `publisher` de tipo
`GovernmentOrganization`, `mainEntityOfPage` → `/sobre/`) y un bloque «Dónde nos
citan» en `/sobre/` que lo corrobora en texto visible.

**Qué NO arregla eso:** el JSON-LD ayuda a que Google no confunda las dos
entidades; no decide cuál merece el nombre. Eso lo deciden las citaciones
externas que nombren "Ley Abierta" enlazando a leyabierta.es.

### Primer backlink gubernamental · **2026-09-16**

`datos.gob.es` ha publicado la ficha de Ley Abierta en su catálogo de
aplicaciones: <https://datos.gob.es/es/aplicaciones/ley-abierta>. El enlace a
`https://leyabierta.es` es **dofollow** — verificado: el `<a>` no lleva `rel`.

Es el segundo backlink detectado del proyecto (el primero era `libhunt.com`) y
el primero desde un dominio gubernamental. Es exactamente la palanca que esta
página lleva señalando desde agosto como el cuello de botella real. **Publicado
el mismo día, así que aún no hay nada que medir**: la primera lectura honesta es
la siguiente iteración, y el informe de enlaces de GSC tarda semanas en
reflejarlo.

### El dato que reencuadra el problema: no es el sitio, es Google

Umami, 28 días a 2026-09-20 — **1.099 sesiones, 1.726 páginas vistas**:

| Fuente | 2026-09-20 | 2026-09-16 | 2026-08-18 |
|--------|-----------:|-----------:|-----------:|
| Ecosistema Bing (Bing, Yahoo, DuckDuckGo, Ecosia) | **788** | 717 | 334 |
| Asistentes de IA (ChatGPT, Copilot, Perplexity) | **44** | 43 | ~25 |
| **Google** | **4** | 3 | 2 |
| datos.gob.es | 0 | 0 | — |

El tráfico total sigue subiendo semana a semana, y la asimetría, lejos de
corregirse, **se agrava en términos absolutos**: Bing manda 197 visitas por cada
una de Google, con 2.304 impresiones de Google en la misma ventana. Los mismos
artículos que Google deja en "Rastreada: actualmente sin indexar" a Bing le
parecen suficientemente útiles para posicionarlos.

**Eso descarta la calidad de página como causa raíz y apunta a autoridad de
dominio.** Un motor con menos exigencia de autoridad ya nos da tráfico; el que
más exige, no.

Tendencia semanal de páginas vistas, sostenida al alza: 397 → 467 → **551**
(semana del 14/09, completa).

De `datos.gob.es` todavía no ha llegado ni una visita, cuatro días después de
publicarse la ficha. No es alarmante — el tráfico de referencia desde un
catálogo institucional tarda en materializarse — pero es la primera lectura en
la que ya cabría esperar algo si el enlace estuviera generando clics directos.

El tráfico de asistentes de IA aterriza en fichas de ley concretas
(`/leyes/BOE-A-2024-24099`, `BOE-A-2015-10565`…), no en `/pregunta/`: nos están
citando como fuente. Valida el trabajo de agent-readiness.

**Son dos problemas distintos, y confundirlos lleva a arreglar lo que no es:**

1. **Reformas — problema de rastreo.** Google no las descarga. Ninguna de las
   777 muestreadas el 22/09 (ambos brazos) tiene `lastCrawlTime`, sea cual sea
   la forma de la URL (experimento A, cerrado). No se puede juzgar el contenido
   de una página que nunca se ha visitado.
2. **Leyes — problema de autoridad, no de contenido.** Google las descarga sin
   problema (99,1%) y decide no indexar el 84%. Bing sí las indexa y las
   posiciona. Ningún ajuste técnico de la página arregla esto.

**Corolario para priorizar:** con el 15,9% indexado, optimizar títulos, meta
descriptions o datos estructurados de páginas que Google no indexa no mueve
nada. Primero indexación, después presentación. Y la palanca de indexación en
Google es autoridad — enlaces externos — no ajustes on-page.

### Iteración 5 (2026-09-20): sin acciones, por diseño

Quinta iteración consecutiva sin ninguna consulta en distancia de ataque ni con
CTR bajo, y las tres cosas que quedaban por hacer dentro de la whitelist ya
estaban hechas o eran prematuras: la entidad de marca y el enlazado de hubs
(#159) llevan menos de dos semanas desplegados, y el sitemap de reformas
(#161) se acaba de confirmar arreglado. No se abrió PR — plan en
`data/seo/plan-claude-sonnet-5-2026-09-20.json`. Próxima decisión real: la
lectura del experimento A el 2026-09-22.

### Límite diario de Cloudflare Workers · 2026-09-19 — pico puntual, no un problema recurrente

Aviso de Cloudflare el 2026-09-19: `leyabierta-web` superó el límite diario
del plan Free (100.000 invocaciones/día). **No es tráfico malicioso.** Ese día
el Worker tuvo **153.469 invocaciones**, de las que GPTBot (~36,7k) y ClaudeBot
(~25,4k) fueron la mayor parte. Coincide con que `sitemap-reformas.xml` pasó a
0 errores (#161): los agentes de IA se pusieron al día con las ~34.400 reformas
que antes eran inalcanzables. Bloquearlos iría contra la estrategia de
agent-readiness y **no se ha considerado**.

**Revisión del 2026-09-22 — lo que dicen los datos, y qué hay que corregir de lo
escrito el 20/09.** Leído con `claude-in-chrome` contra la GraphQL del propio
dashboard (ver `scripts/seo/README.md` § Cloudflare):

| Día | Invocaciones | Subpeticiones a la API |
|-----|-------------:|-----------------------:|
| 14–18/09 (media) | ~21.000 | ~10.400 |
| **19/09** | **153.469** | **102.979** |
| 20/09 (#164 desplegado a las 17:00) | 25.841 | 16.476 |
| 21/09 | 29.632 | 18.263 |
| 22/09 | 28.000 | 14.751 |

1. **Fue un pico de un solo día, no una tendencia.** El 21/09 GPTBot y ClaudeBot
   ya ni aparecen entre los 15 agentes con más peticiones. Lo normal está entre
   20k y 30k invocaciones al día, **un 20–30% del límite**. No hace falta ni
   cambiar de plan ni limitar el acceso a nadie.
2. **#164 funciona, pero su efecto en la carga es despreciable.** Aciertos de
   caché del 21/09 (`requestSource=edgeWorkerCacheAPI`): **989 hits contra
   17.838 misses, un ~5%**. Los crawlers piden casi cada reforma una sola vez,
   y la Cache API es local de cada centro de datos, así que casi nunca se
   repite una URL en el mismo sitio. Las subpeticiones a la API no han bajado
   (han subido con el tráfico). La mejora de latencia de ~267ms a ~110ms del
   20/09 es real, pero solo en visitas repetidas, que son la excepción.
3. **Error conceptual en lo escrito el 20/09:** «confirmar que el arreglo
   reduce las invocaciones». La Cache API se ejecuta *dentro* del Worker, así
   que cada petición lo invoca igual haya hit o no. #164 solo podía ahorrar
   subpeticiones a la API, nunca invocaciones.
4. **Aviso para quien lea las analíticas de zona:** desde el 20/09 aparecen en
   `/cambios/reforma/` ~18k filas diarias con 504 y otras ~18k con 204 `PUT`.
   **No son errores servidos a nadie**: son el `cache.match` fallido y el
   `cache.put` de la Cache API, registrados con `requestSource:
   edgeWorkerCacheAPI`. Filtra por `requestSource: eyeball` para ver lo que
   reciben los visitantes (200 en todos los casos comprobados).
5. **Riesgo latente de #164:** el HTML cacheado vive 90 días
   (`s-maxage=7776000`) y enlaza los `/_astro/*.css|js` con hash del shell del
   momento. Si un deploy cambia esos hashes y los antiguos dejan de servirse,
   las reformas cacheadas saldrían sin estilos hasta que caduquen. Comprobado
   el 22/09: hoy todos los assets enlazados devuelven 200 (los estilos no
   cambian desde el 16/09), pero con un ~5% de aciertos el beneficio no
   compensa ese riesgo. **Pendiente de decidir:** revertir #164, o acortar el
   TTL de la caché del Worker a ~1 día.

**Googlebot, visto desde Cloudflare** (peticiones reales, 13–22/09): ~1.250 en
total, ~395 a `/leyes/*`, ~200 a reformas en forma query y **1** a reformas en
forma path. Es otra forma de medir el rastreo, sin gastar cuota de inspección,
y confirma la lectura del experimento A de abajo.

---

## Experimentos

### A — Forma de URL de las reformas · **cerrado 2026-09-22: no concluyente**

**Desplegado:** 2026-07-28 · **Leído 2026-08-21: ⏳ SIN SEÑAL** ·
**Leído 2026-09-22: ⏳ SIN SEÑAL → cerrado como no concluyente**

> #### Lectura final del 2026-09-22: cerrar, no migrar
>
> | Brazo | n | Rastreadas | Indexadas | Descubierta | Desconocida |
> |-------|---|-----------|-----------|-------------|-------------|
> | Tratamiento (path) | 390 | **0,0%** | 0,0% | 164 | 226 |
> | Control (query 2026) | 387 | **0,0%** | 0,0% | 154 | 233 |
>
> Ocho semanas después del despliegue, ambos brazos siguen a cero rastreadas y
> tienen un reparto casi idéntico de estados. Los logs de Cloudflare dicen lo
> mismo desde otro ángulo: **una sola** petición de Googlebot a una reforma en
> forma path en 10 días (13–22/09). La regla fijada en la lectura anterior se
> aplica tal cual: *si ambos brazos siguen a cero, cerrar como no concluyente y
> pasar a autoridad de dominio.* Google no rastrea ninguna de las dos formas de
> URL, así que el experimento no puede decidir cuál es mejor, y esperar más no
> lo cambia.
>
> **Qué se hace con el código:** nada. Las ~34k reformas se quedan en forma
> query y las 2026 repartidas como están. Migrar sin evidencia tiene coste
> (redirecciones, canonicals, sitemap) y ninguna ganancia demostrada. Se
> levanta la congelación de `reform-experiment.ts`, del reparto y del split del
> sitemap: ya no hay experimento que proteger, pero cualquier cambio ahí debe
> tener su propio motivo.
>
> **Qué nos deja:** el cuello de botella de las reformas no es la forma de la
> URL sino el presupuesto de rastreo, y eso es autoridad de dominio. Es la misma
> conclusión que para las leyes (ver el diagnóstico de arriba).

> #### Aviso del 2026-09-16 — no adelantes la lectura con impresiones
>
> En el snapshot de GSC de hoy hay **78 URLs de reforma con impresiones** (399
> en total). Es tentador leerlo como que el brazo query ya funciona. No lo es:
> son reformas **anteriores a 2026**, la cohorte "query histórica" que esta
> misma página marca como sesgada por selección. De las reformas de 2026 — los
> dos brazos del experimento — solo **una** tiene impresiones, y es del brazo
> control. El brazo path sigue con **cero** impresiones.
>
> La métrica primaria sigue siendo `crawlRate` medido con `inspect-urls.ts`, no
> las impresiones. La lectura sigue fijada al 2026-09-22.

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

### C — Hubs temáticos enlazados · **desplegado 2026-09-07 (PR #157)**

`/temas/fiscalidad/` y `/temas/empleo/` (de #149) llevaban 17 días en el sitemap
**sin un solo enlace interno**. La iteración 3 los enlazó desde la home
(`components/TopicHubs.astro`) y desde las 18 normas curadas
(`pages/leyes/[id].astro`), con el hub como nivel intermedio del
`BreadcrumbList`.

**Lectura del 2026-09-16 (9 días): cero impresiones en ambos hubs.** No es un
veredicto — nueve días es poco y el sitio tiene una mediana de rastreo de ~21
días — pero sí es la razón por la que **no se crean hubs nuevos** hasta que
estos dos registren algo. Multiplicar un patrón sin lectura es apostar dos veces
sobre la misma hipótesis.

**Lectura del 2026-09-20 (13 días): sigue en cero.** Sin cambios. El corte de
lectura sigue en 2026-10-01.

Criterio: si el 2026-10-01 siguen a cero impresiones, el problema no es el
enlazado interno y hay que dejar de invertir en hubs hasta que la autoridad de
dominio se mueva.

---

## Abierto, sin atacar todavía

- **Autoridad de dominio — ahora la prioridad número uno.** Los datos de Umami
  del 2026-09-16 (Bing 717 visitas, Google 3) descartan la calidad de página
  como causa raíz: el contenido le vale a Bing, a los asistentes de IA y no a
  Google. Lo que nos falta es lo que Google pondera y Bing no tanto: enlaces
  externos. Sin eso, ni el presupuesto de rastreo ni la indexación se mueven, y
  el resto de la lista de abajo son optimizaciones sobre páginas que Google no
  indexa.
  **Movimiento del 2026-09-16:** la ficha de `datos.gob.es` (dofollow) es el
  segundo backlink del proyecto y el primero gubernamental — ver arriba. Sigue
  siendo poco: dos enlaces no construyen autoridad. **Lo único que mueve esta
  aguja es trabajo humano**, y ahora tiene además una segunda razón: la colisión
  de marca con `leyabierta.com` sólo se rompe con citaciones externas que
  nombren "Ley Abierta" enlazando a leyabierta.es. Candidatos: prensa y blogs de
  datos abiertos, la comunidad de datos.gob.es, foros de transparencia,
  agregadores de proyectos cívicos.
- **Las 12.000 páginas de ley (15,9% indexadas).** Diferenciación de contenido:
  que el HTML lleve por delante lo único nuestro (resúmenes ciudadanos por
  artículo, historial de reformas, diffs entre versiones) en vez de replicar
  articulado que el BOE ya tiene. Sigue siendo trabajo grande y que merece la
  pena, pero ojo con la atribución: Bing ya indexa y posiciona estas mismas
  páginas sin esa diferenciación, así que no es lo que bloquea a Google.
- **Cero rich results.** `searchAppearance` viene vacío. El JSON-LD
  `Legislation` es correcto como dato semántico pero **Google no genera rich
  results para ese tipo**. Hoy sólo emitimos `Legislation` + `BreadcrumbList`
  en las fichas de ley y `Organization`/`WebSite` en el layout (este último
  ampliado con las señales de entidad de marca en #159): **no hay `Dataset` ni
  `Article` en ninguna página**. Son tipos que Google sí soporta y
  candidatos claros (`Dataset` en `/datos/`, `Article`/`NewsArticle` en las
  reformas), pero añadirlos antes de que esas páginas estén indexadas es
  optimizar algo que no existe. `FAQPage` no aplica: Google lo restringió en
  2023 a sitios gubernamentales y de salud.
- ~~**Sitemap de reformas: 158 errores, escalado a humano.**~~ **Resuelto
  (#161, 2026-09-16).** La causa era otra distinta de la que se llevaba semanas
  buscando: Google rechaza como "Invalid date" cualquier `<lastmod>` anterior
  al epoch de Unix (1970), por bien formado que esté el ISO. El detalle de la UI
  de Search Console lo confirmó con los números de línea exactos (90089, 90095,
  90155 → 1940-12-22, 1946-12-19, 1927-09-08, las tres primeras de 158 fechas
  pre-1970 en el XML servido). `sitemap-leyes.xml` ya aplicaba esta regla desde
  antes, inline; nunca se había llevado a `sitemap-reformas.xml`. El fix omite
  la etiqueta `<lastmod>` para esas 158 URLs (la URL se queda: una reforma de
  1927 es dato real) y comparte el helper entre los dos sitemaps para que no
  puedan volver a divergir.
  **Confirmado el 2026-09-20:** tras el reenvío del 16/09, `errors: 0`,
  `lastDownloaded` 2026-09-19. Cerrado.
