# Goal: crecimiento de tráfico orgánico de leyabierta.es

North star de un loop autónomo y quincenal que mejora el SEO de Ley Abierta
tomando decisiones basadas en datos reales de Google Search Console (GSC) y
Umami. Inspirado en el diseño de `docs/async-experimentation-system.md`, pero
con GSC como fuente de verdad en vez de un eval harness.

## Criterios de éxito (en orden)

1. **Clics orgánicos.** Crecimiento sostenido de clics orgánicos mes a mes
   (GSC `clicks`). Baseline se fija en la iteración 0.
2. **Impresiones en KWs objetivo.** Aparecer y subir en keywords legislativas
   de intención informacional ("qué dice la ley de…", "artículo X de…",
   nombres de normas, "reforma de…").
3. **CTR.** Mejorar el CTR medio de las páginas ya indexadas (títulos y
   descriptions más atractivos), sin caer en clickbait ni desinformar.
4. **Cobertura.** Más páginas indexadas y sin errores en GSC.

## Constraints (líneas rojas)

- **Sitio público cívico.** Nunca desinformar, nunca clickbait, nunca falsear
  el contenido de una norma con tal de rankear. La precisión legal es sagrada.
- **Deploy solo vía PR.** El loop abre un Pull Request; un humano mergea. El
  loop NUNCA pushea a `main` ni despliega directamente. (Ver `PLAYBOOK.md`.)
- **Zona segura de edición.** Solo puede tocar la superficie SEO definida en
  `PLAYBOOK.md` (meta, JSON-LD, internal linking, hub pages, sitemap hints).
  NO puede tocar la API, el pipeline, datos, secrets, ni la lógica de negocio.
- **Verificación obligatoria.** Ningún PR se abre si `bun run build`,
  `bunx tsgo --noEmit` o `bun run check` (biome) fallan.
- **Presupuesto.** Coste de inferencia por iteración ≤ 5 €. Escalar a humano
  si se supera.
- **Privacidad.** Los snapshots de GSC/Umami y la bitácora (`data/seo/`) son
  privados (gitignored). El código y la gobernanza (`.goals/seo/`, `scripts/seo/`)
  son públicos — la transparencia del método es on-brand.

## Stop conditions (cualquiera)

- 3 iteraciones seguidas sin mejora medible en clics ni impresiones → escalar.
- Un PR del loop rompe algo en producción → pausar el cron, revisar.
- Presupuesto acumulado > 100 € → escalar.
- STOP humano.

## Fuera de alcance (por ahora)

- Retención / producto / PostHog. (Este loop es SOLO SEO.)
- Link building externo, outreach, backlinks de pago.
- Cambios de arquitectura de información que muevan URLs existentes sin
  redirects (riesgo de perder el ranking ya ganado).
- Contenido generado masivo de baja calidad ("programmatic SEO" spam).

## Contexto del sitio

- **Stack:** Astro static → Cloudflare Pages. ~12k+ páginas (`leyes/[id]`).
- **SEO actual:** `Base.astro` gestiona title/description/canonical/OG.
  Existen sitemap dinámico, robots.txt, llms.txt, feed.xml.
- **Palancas infrautilizadas (hipótesis iniciales):** JSON-LD / schema.org
  (no hay structured data), internal linking entre normas relacionadas,
  descriptions por página, hub pages temáticas para KWs que suban.
- **Analítica:** Umami self-hosted (`analytics.leyabierta.es`, cookieless).
- **Propiedad GSC:** `leyabierta.es`, verificada bajo la cuenta Google de Alex.
