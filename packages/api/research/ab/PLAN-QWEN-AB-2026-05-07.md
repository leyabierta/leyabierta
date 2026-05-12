# Plan: Qwen3-Embedding-8B vs Gemini-2-preview, fase end-to-end

**Fecha:** 2026-05-07
**Branch:** `feat/qwen3-nan-embeddings-ab`
**Objetivo:** Decidir si Qwen3-Embedding-8B (vía nan.builders, gratis) puede sustituir a Gemini-2-preview (de pago) en producción sin pérdida de calidad cara al usuario.
**Métrica norte:** R@1, R@5, R@10 sobre eval ciudadana #40 (50 queries en `packages/api/research/datasets/citizen-queries.json`), end-to-end con el stack de prod completo.

## Contexto de partida

A/B previo (`QWEN-NAN-AB-2026-05-07.md`) midió retrieval **puro** (vector simple sin penalties/RRF/rerank) sobre corpus reducido de 123 normas:

| Setup | Gemini R@1 | Qwen R@1 | Gap |
|---|---|---|---|
| Pure dense | 96.5 | 93.0 | -3.5 |
| Hybrid pool=30+rerank (réplica parcial de prod) | 68.4 | 59.6 | -8.8 |
| Vector pool=30+rerank | 64.9 | 64.9 | 0 |

Hallazgos clave:
- Qwen tiene sesgo histórico: prefiere Código Civil 1889 / Código Penal sobre LOPDGDD/Estatuto/LAU modernas
- Modern-bias query prompt cierra ~7pp de gap
- BM25 introduce ruido en ese harness; el reranker actual de prod tira R@1 incluso con Gemini
- El harness anterior NO replica fielmente prod (faltan article-type penalty, diversity, rank/jurisdiction boost, hierarchy-boost post-rerank, anchor norm injection, sub-chunk dedup)

**Decisión:** la métrica que importa es Qwen vs Gemini sobre **el stack de prod EXACTO**, sobre eval #40, no retrieval puro.

## Restricciones validadas

**Qwen3-Embedding-8B oficial spec** (https://huggingface.co/Qwen/Qwen3-Embedding-8B):
- Doc-side: **plain text, NO instruction**. Añadir prefijo perjudica.
- Query-side: `Instruct: {task}\nQuery:{q}`. Mejora 1-5%. Inglés recomendado.
- Dimensiones: 32–4096, default 4096 (MRL).

El embed actual de Qwen-NAN ya respeta esto. No hay margen en doc-side prompt.

**Cobertura actual de embeddings en SQLite:**
| Modelo | rows | normas distintas |
|---|---|---|
| `gemini-embedding-2` | 483.983 | 9.738 (production scope) |
| `qwen3-nan` | 60.281 | 123 (A/B previo) |

**Cobertura de eval #40 en Qwen-NAN store:** 29 queries con cobertura completa, 8 parcial, 13 sin cobertura.

## Plan staged

### Fase 1 — Construir harness, eval con cobertura existente (sin embed nuevo)

1. **Parametrizar `runRetrievalCore`** (`packages/api/src/services/rag/retrieval.ts`)
   - Añadir a `RunRetrievalCoreOpts`: `embeddingModelKey?: string` (default `EMBEDDING_MODEL_KEY`), `embedQueryFn?: (apiKey, modelKey, q) => Promise<{embedding, cost, tokens}>` (default `embedQuery`).
   - Reemplazar `embedQuery(apiKey, EMBEDDING_MODEL_KEY, question)` por la fn inyectada.
   - Cambio aditivo. Prod sigue idéntico (defaults).

2. **Construir índice in-memory por modelo**
   - `vector-index-singleton.ts` actual asume un solo modelo. Para eval, leer directamente desde `embeddings WHERE model=?` y armar `InMemoryVectorIndex` ad-hoc por variante.

3. **Escribir `eval-prod-replica.ts`** en `packages/api/research/ab/`
   - Carga `citizen-queries.json`
   - Para cada variante (A=Gemini, B=Qwen-NAN modern-bias):
     - Construye índice in-memory desde DB
     - Para cada query con cobertura: llama `runRetrievalCore({...opts, embeddingModelKey, embedQueryFn})`
     - Evalúa hit rank en `articles` (post-rerank) y en `allFusedArticles` (pre-rerank, diagnóstico)
   - Reporta: R@1, R@5, R@10, MRR@10 + per-question miss analysis
   - Subset: 29 queries fully-covered en Qwen store

4. **Correr fase 1**
   - Tiempo estimado: 50 queries × 2 variantes × ~2s/query (incl. analyzer LLM call) ≈ 4 min
   - Output: gap end-to-end real Qwen vs Gemini sobre prod stack

**Decision gate:**
- Si gap ≤ 3pp R@1 → ir a fase 2 (pilot embed para cubrir las 50 queries y confirmar)
- Si gap > 5pp R@1 → ir a fase 4 (interventions) sin pilot
- Si está entre 3-5pp → discutir antes de seguir

### Fase 2 — Pilot embed (14 normas faltantes)

1. **Identificar normas faltantes** (las 14 unique de `expectedNorms` no cubiertas en Qwen store)
2. **Adaptar `embed-corpus-full-qwen.ts`** o usar mini-script para esas 14 norms (~5k chunks)
3. **Tiempo:** ~30-60 min al ritmo observado (3-15 emb/s con backoff)
4. **Re-correr eval-prod-replica.ts** sobre las 50 queries completas, con haystack restringido a las ~137 normas (Qwen store completo) para ambos modelos vía filter

**Output:** señal sobre fairness y rendimiento Qwen+prod-stack en haystack pequeño (137 normas).

**Decision gate:**
- Qwen ≥ Gemini → proceder a fase 3 (full corpus, decisión prod-ready)
- Qwen < Gemini por ≤ 3pp → proceder a fase 3 + interventions paralelas
- Qwen < Gemini por > 5pp → fase 4 directamente, no embebir más

### Fase 3 — Full corpus embed

1. **Lanzar `embed-corpus-full-qwen.ts`** (ya escrito) en background con `--resume`
2. **Tiempo realista:** 8-20h (medido empíricamente con 429s frecuentes en nan.builders)
3. **Re-correr eval-prod-replica.ts** sobre 50 queries con haystack idéntico (9.738 normas) para Qwen y Gemini

**Output:** decisión-prod-ready Qwen vs Gemini.

### Fase 4 — Interventions (solo si Qwen pierde end-to-end)

Aplicar de más barata a más cara, una por una:

1. **Recency boost para fundamental ranks** — actualmente `applyLegalHierarchyBoost` exempta constituciones/códigos de age decay, lo que beneficia a Código Civil 1889 (Qwen weakness). Probar con cap de age decay aplicado a códigos también.
2. **Query prompt variants** — modern-bias actual cita 4 leyes específicas (LAU, LOPDGDD, etc.); riesgo de overfitting al eval. Probar versión genérica.
3. **HyDE** — query rewrite a jerga legal vía LLM antes de embed. Caro en latencia (+1 LLM call) pero ataca el gap jerga ciudadana ↔ jerga BOE. No requiere re-embed.
4. **Citizen-summary multi-vector** — embebir summaries en paralelo al raw text, búsqueda toma max(score). Requiere embed adicional (~484k chunks más). Solo si las 1-3 no cierran gap.
5. **MRL truncation a 3072** — separadamente, optimización de almacenamiento + 3.3× speed. Aplicar al final (independiente de calidad).

## Estructura de archivos

```
packages/api/research/ab/
├── PLAN-QWEN-AB-2026-05-07.md     ← este doc
├── QWEN-NAN-AB-2026-05-07.md      ← report A/B previo (retrieval puro)
├── citizen-queries.json (en datasets/) ← eval #40
├── corpus.ts                       ← buildCorpusPlan (123 normas, A/B previo)
├── eval-ab.ts                      ← retrieval puro variantes A-M (legacy)
├── eval-hybrid-rerank.ts           ← intento previo réplica prod (incompleto)
├── eval-misses.ts                  ← análisis cualitativo
├── debug-pipeline.ts               ← traza por etapas
├── embed-corpus-nanbuilders.ts     ← embed 123 normas via nan.builders
├── embed-corpus-full-qwen.ts       ← NUEVO: embed full corpus 9738 normas
├── eval-prod-replica.ts            ← NUEVO: harness fase 1, llama runRetrievalCore
└── nan-latency-bench.ts            ← caracterización API
```

## Cambios en código de prod (mínimos)

`packages/api/src/services/rag/retrieval.ts`:
```diff
 export type RunRetrievalCoreOpts = {
   db: Database;
   apiKey: string;
   cohereApiKey: string | null;
   question: string;
   ...
+  /** Override the embedding model key (default: EMBEDDING_MODEL_KEY = "gemini-embedding-2"). */
+  embeddingModelKey?: string;
+  /** Override the query embedding function (default: embedQuery). */
+  embedQueryFn?: typeof embedQuery;
 };

 export async function runRetrievalCore(opts: RunRetrievalCoreOpts) {
-  const { db, apiKey, ...rest } = opts;
+  const { db, apiKey, embeddingModelKey = EMBEDDING_MODEL_KEY, embedQueryFn = embedQuery, ...rest } = opts;
   ...
-  const [analysisResult, queryResult] = await Promise.all([
-    analyzeQuery(apiKey, question),
-    embedQuery(apiKey, EMBEDDING_MODEL_KEY, question),
-  ]);
+  const [analysisResult, queryResult] = await Promise.all([
+    analyzeQuery(apiKey, question),
+    embedQueryFn(apiKey, embeddingModelKey, question),
+  ]);
```

Esto requiere también:
- `embedQuery` aceptar Qwen-NAN como modelKey (actualmente solo soporta OpenRouter). Solución: el harness pasa una `embedQueryFn` custom que llama al endpoint nan.builders cuando key=qwen3-nan, sin tocar `embedQuery`.

## Notas para agentes que continúen

- **NO añadir prompt al doc-side de Qwen.** La doc oficial lo prohíbe. El embed actual ya es correcto.
- **NO usar `eval-hybrid-rerank.ts` como base.** No replica article-type penalty, diversity penalty, rank/jurisdiction boost, hierarchy-boost. Fue el harness que dio R@1=68.4% para Gemini cuando prod real saca más.
- **NO mezclar evaluación de modelo con evaluación de representación documental.** Citizen summaries, multi-vector, HyDE — son fase 4, no se mezclan con la decisión de modelo.
- **El vector index in-memory** se construye una vez por variante por sesión. Cargar 484k vectores Gemini ≈ 5.6 GB RAM. Qwen 4096 dims sería ~7.4 GB para 484k chunks. Validar memoria disponible antes del eval con corpus completo.
- **Qwen-NAN rate limits:** 5 conc / 100 RPM (memoria de proyecto). El embed-corpus-full-qwen.ts usa CONCURRENCY=5; respeta el límite si batch=32 ≤ 60s/req.

## Estado de tareas

Ver `TaskList` en la sesión activa. Tasks #3-#9 cubren las fases 1-3 + interventions. Cualquier agente puede tomar tasks pending; la única dependencia dura es 3 → 4 → 5 (refactor antes que harness antes que ejecución).
