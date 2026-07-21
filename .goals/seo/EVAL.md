# SEO loop — cómo se mide el éxito

Dos niveles de evaluación: el **benchmark de planes** (rápido, compara modelos)
y el **resultado real** (lento, lo dicta GSC iteración a iteración).

## 1. Resultado real (la métrica que importa)

Cada iteración registra en `data/seo/STATE.md` el snapshot de GSC agregado del
periodo, y el delta contra el periodo anterior:

- `clicks`, `impressions`, `ctr`, `position` (medias del sitio)
- Top-20 queries por clics y su movimiento (↑/↓/nuevo)
- Nº de páginas con ≥1 clic (cobertura efectiva)

Una acción se considera **ganadora** si, 2 iteraciones (≈4 semanas) después de
mergear su PR, las queries/páginas que tocó mejoran clics o posición sin dañar
al resto. El loop atribuye de forma aproximada (correlación, no causalidad
estricta — no hacemos A/B real sobre SEO porque el sitio es uno solo).

## 2. Benchmark de planes (compara NaN vs Claude)

Como el resultado real tarda semanas, para elegir modelo se compara la
**calidad de los planes** que cada modelo produce sobre el MISMO snapshot.
`benchmark.ts` corre cada modelo y puntúa su plan:

| Dimensión | Cómo se puntúa | Peso |
|-----------|----------------|------|
| Schema válido | El JSON parsea y cumple el schema de abajo | gate (0/1) |
| Cumple PLAYBOOK | 0 acciones en la blacklist; todo en whitelist | gate (0/1) |
| Especificidad | Acciones concretas (ruta + cambio exacto) vs vagas | 0–5 (juez Claude) |
| Fundamentación en datos | Cada acción cita una señal real del snapshot | 0–5 (juez Claude) |
| Priorización | Ataca striking-distance / CTR antes que lo especulativo | 0–5 (juez Claude) |
| Riesgo | Penaliza acciones agresivas sin `requires_human_review` | 0 a −5 |
| Coste | Tokens × precio del modelo | tiebreak |
| Latencia | Segundos hasta el plan | tiebreak |

El juez es Claude (fijo) para no favorecer a ningún candidato. El leaderboard
se guarda en `data/seo/benchmark-<fecha>.md`. **Los gates son eliminatorios:**
un plan que toca la blacklist o no parsea puntúa 0 aunque el resto sea bueno.

## 3. Schema del plan (salida del paso "plan")

```json
{
  "iteration": 3,
  "snapshot_date": "2026-07-21",
  "model": "nan-deepseek",
  "summary": "1-2 frases: la tesis de esta iteración",
  "actions": [
    {
      "id": "A1",
      "type": "meta | jsonld | internal-link | hub-page | copy | sitemap-hint",
      "hypothesis": "por qué esto sube el tráfico, citando una señal del snapshot",
      "signal": { "query": "reforma reglamento extranjería", "position": 12.4, "impressions": 830, "ctr": 0.006 },
      "files": ["packages/web/src/pages/leyes/[id].astro"],
      "change": "descripción concreta y accionable del cambio",
      "expected_impact": "qué métrica esperamos mover y en qué dirección",
      "effort": "S | M | L",
      "requires_human_review": false
    }
  ],
  "estimated_cost_eur": 0.0,
  "notes": "riesgos, dudas, qué medir la próxima vez"
}
```

## 4. Anti-goodhart

- No optimizar impresiones a costa de clics (impresiones de basura no valen).
- No inflar CTR con títulos engañosos: si el CTR sube pero el bounce en Umami
  se dispara y la posición cae después, la acción fue mala → revertir.
- La precisión legal SIEMPRE gana sobre la métrica. Un título que rankea pero
  tergiversa la norma es un fallo, no un éxito.
