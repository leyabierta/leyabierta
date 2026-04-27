# Borradores para publicación pública

Pendientes de aprobación antes de publicar en GitHub. No commitear este archivo si decides borrar tras publicar.

---

## 1. GitHub Discussion (categoría: Ideas / RFC)

**Título:** `[RFC] Fine-tuning local como complemento al RAG (línea de trabajo "RAG-FT")`

**Cuerpo:**

```markdown
## Resumen

Estamos explorando si tiene sentido añadir **fine-tuning de modelos pequeños self-hosted** como complemento (no sustituto) al RAG actual de Ley Abierta. Esta Discussion abre el debate antes de comprometernos a la fase de implementación.

Plan completo: [`packages/api/research/RAG-FT-PLAN.md`](./packages/api/research/RAG-FT-PLAN.md)

## Por qué

El RAG actual (Gemini Flash Lite + retrieval híbrido + Cohere rerank) funciona razonablemente, pero tiene puntos de mejora medibles:

- **Coste por pregunta**: ~$0.0032 dominado por el reranker de Cohere (~76% del total).
- **Dependencia externa**: Cohere y OpenRouter son terceros. Para un proyecto de servicio público, la soberanía importa.
- **Fallos conocidos en retrieval**: el sistema cita artículos derogados o versiones antiguas en preguntas temporal-sensibles (p.ej. SMI, permisos parentales con cifras pre-reforma).

Hipótesis: fine-tunear un cross-encoder reranker pequeño (~500M params) sobre pares (consulta legal, artículo BOE) puede reducir coste a ~$0 y mejorar precisión en dominio español. Evidencia: [RAFT (Berkeley, 2024)](https://arxiv.org/abs/2403.10131), [Redis legal benchmark](https://redis.io/blog/improving-information-retrieval-with-fine-tuned-rerankers/), [MEL legal-español (2025)](https://arxiv.org/abs/2501.16011).

## Estado actual

Hemos ampliado el eval gate de 65 a 205 preguntas (155 train/dev + 50 holdout) cubriendo CCAA, materias infrarrepresentadas, casos temporal-sensibles y procedimentales/adversariales.

Baseline del pipeline actual sobre 137 preguntas in-scope:
- **R@1 = 50.4%**
- **R@5 = 76.6%**
- **R@10 = 87.6%**
- decline rate 0.7%, latencia media 4.7s

(Sobre el eval anterior de 65 preguntas, R@10 era 95% — el nuevo set es más diverso y discrimina más. La caída de 7pp es donde está el margen de mejora.)

## Plan en tres fases

1. **Fase 1 — Reranker fine-tuned**: sustituir Cohere por un cross-encoder local entrenado con LoRA. Datos generados desde el corpus BOE (no se necesitan usuarios reales aún). [Issue de tracking](#).
2. **Fase 2 — RAFT-style synthesis** (deferida): fine-tune de un LLM pequeño (7B-12B) para mejorar fidelidad de citaciones y refusal. Solo si Fase 1 ship.
3. **Fase 3 — Estilo y dominio** (gated): adaptación de estilo "ciudadano" del generador. Solo si tenemos un dataset validado por experto legal.

Hardware: entrenamos en local (Apple Silicon con MLX), servimos en el servidor Linux con vLLM.

## Por qué este orden

La intuición común sería empezar por fine-tunear el generador. Lo descartamos por dos razones:

1. **Coste**: el reranker es ~76% del coste por query, no la síntesis.
2. **Failure mode**: los fallos conocidos (citar artículos derogados, números obsoletos) son problemas de retrieval, no de generación. Un mejor reranker los arregla; un mejor generador no.

## Preguntas abiertas para feedback

- ¿Hay otros frameworks legales/dominio que merezca la pena considerar como base (más allá de `bge-reranker-v2-m3`, `IIC/MEL`)?
- El holdout de 50 preguntas está en el repo (synthetic). ¿Conviene generar un holdout adicional cerrado para evitar overfitting a futuro?
- Para el dataset de 5-10K pares (Fase 1a), ¿algún sesgo del corpus que deberíamos compensar?
- Si conoces a alguien (desarrollador o jurista) interesado en aportar preguntas reales o validar respuestas, este es el sitio para enlazarlo.

Cualquier feedback es bienvenido — desde "esta priorización tiene fallos" hasta sugerencias de modelos base, datasets externos, o métricas adicionales que medir.

---

*Este RFC se redactó en colaboración con Claude Code (Opus 4.7); el plan está en el repo y se actualiza con cada hito.*
```

---

## 2. Issues (uno por fase entregable)

### Issue #N: Fase 0 — Ampliar eval gate y baseline RAG-FT

**Status: cerrado / done en commit**

**Labels:** `enhancement`, `IA/resúmenes`, `pipeline`

**Título:** `Fase 0 RAG-FT — Ampliar eval gate de 65 a 205 preguntas y rebaselinar`

**Cuerpo:**

```markdown
Parte de la línea de trabajo RAG-FT ([RFC](#discussion-link)).

**Objetivo**: el eval anterior (65 preguntas omnibus) sobreestima el rendimiento real porque sólo cubre estatal + materias populares. Ampliar para discriminar mejor.

**Hecho:**
- [x] 140 preguntas nuevas generadas en 4 slices (autonomic CCAA, materias infrarrepresentadas, temporal-sensibles, procedimentales+adversariales).
- [x] 155 train/dev + 50 holdout. Todos los `expectedNorms` verificados contra el DB.
- [x] Baseline medido: R@1=50.4%, R@5=76.6%, R@10=87.6% (sobre 137 in-scope).
- [x] Plan completo: `packages/api/research/RAG-FT-PLAN.md`.

**Archivos:**
- `data/eval-v2.json`, `data/eval-v2-train-dev.json`, `data/eval-v2-holdout.json`
- `data/eval-v2-baseline.json` (resultados)
- `packages/api/research/datasets/eval-v2-{autonomic,materias,temporal,procedural}.json` (raw + rationales)
- `packages/api/research/build-eval-v2.ts` (merge script)
```

### Issue #N+1: Fase 1 — Reranker fine-tuned (sustituir Cohere)

**Labels:** `enhancement`, `IA/resúmenes`, `pipeline`, `help wanted`

**Título:** `Fase 1 RAG-FT — Reranker fine-tuned para sustituir Cohere`

**Cuerpo:**

```markdown
Parte de la línea de trabajo RAG-FT ([RFC](#discussion-link)).

**Objetivo**: entrenar un cross-encoder pequeño (~500M params) sobre pares (consulta legal en español, artículo BOE) y enchufarlo detrás de un flag para A/B contra Cohere rerank-4-pro.

**Por qué**: ~76% del coste por query es el reranker. Self-hosting elimina ese coste y la dependencia externa, además da margen para mejorar precisión en dominio español-legal.

**Plan:**

- [ ] **1a.** Generar dataset (5-10K pares positivos + hard negatives) desde el corpus BOE. Versionar en `packages/api/research/datasets/reranker-v1.jsonl`.
- [ ] **1b.** Entrenar dos candidatos en paralelo: `BAAI/bge-reranker-v2-m3` y `IIC/MEL`. LoRA via `mlx-lm` en Apple Silicon.
- [ ] **1c.** A/B detrás de `RERANKER_MODE` env flag: A=Cohere, B=FT-reranker, C=cascade. Métricas: R@10, factual correctness, P95 latencia, $/query.
- [ ] **Ship criterion**: variant gana en factual correctness sin regresión en R@10 y reduce coste >50%.

**¿Quieres ayudar?**
- Ideas de hard-negative mining más allá del top-K actual.
- Validación humana de un sample del dataset (¿son las queries plausibles? ¿el positivo es realmente la mejor respuesta?).
- Aportar 10-20 preguntas reales que tú harías como ciudadano para el holdout.

Plan detallado: `packages/api/research/RAG-FT-PLAN.md` (sección Fase 1).
```

### Issue #N+2: Fase 2 — RAFT-style synthesis self-hosted (deferida)

**Labels:** `enhancement`, `IA/resúmenes`

**Título:** `Fase 2 RAG-FT — RAFT-style synthesis self-hosted (gated en Fase 1)`

**Cuerpo:**

```markdown
Parte de la línea de trabajo RAG-FT ([RFC](#discussion-link)).

**Estado: en espera.** No se abre trabajo activo hasta que Fase 1 demuestre ship.

**Objetivo**: fine-tunear un LLM pequeño open-weight (Qwen 2.5 7B / Gemma 3 12B / Salamandra 7B) en estilo RAFT — entrenado con docs retrieved (incluyendo distractores) para que cite verbatim e ignore lo irrelevante.

**Plan provisional**: ver `packages/api/research/RAG-FT-PLAN.md` sección Fase 2.

Cierra cuando Fase 1 esté shippeada (o decidamos que no aporta).
```

### Issue #N+3: Fase 3 — Style/domain generator (placeholder)

**Labels:** `enhancement`, `IA/resúmenes`

**Título:** `Fase 3 RAG-FT — Style/domain (gated en Fase 2 + 10K dataset validado)`

**Cuerpo:**

```markdown
Placeholder. No se trabaja hasta que Fases 1 y 2 estén cerradas y tengamos ≥10K ejemplos validados por un experto legal.

Plan: `packages/api/research/RAG-FT-PLAN.md` sección Fase 3.
```

---

## Comandos para publicar (ejecutar tras aprobación)

```bash
# 1. Discussion (categoría Ideas — verifica el ID con `gh api repos/leyabierta/leyabierta/discussions/categories`)
gh api graphql -f query='...' # gh CLI no soporta directamente discussions create; alternativa: web UI

# 2. Issues
gh issue create --repo leyabierta/leyabierta --title "..." --body-file ... --label "enhancement,IA/resúmenes,pipeline"

# 3. Añadir issues al Project público
gh project item-add 1 --owner leyabierta --url <issue-url>
```

(Discussion creation vía gh CLI requiere graphql porque no hay subcommand directo. Alternativa: te doy el cuerpo y lo pegas en https://github.com/leyabierta/leyabierta/discussions/new)
