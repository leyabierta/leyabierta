# RAG Ciudadano — "Pregunta tus derechos"

Sistema interactivo donde un ciudadano pregunta sobre sus derechos en lenguaje natural
y recibe una respuesta anclada a artículos legislativos reales con enlaces verificables.

## Estado actual

- [x] **Phase 0: Validation Spike** ← benchmark completado
- [ ] Phase 1: Retrieval Foundation (embeddings + reranking) ← siguiente
- [ ] Phase 2: Temporal Awareness (versiones históricas + cadenas de reforma)
- [ ] Phase 3: UI básica (/pregunta con React island)
- [ ] Phase 4: Expansiones (multi-turn, alertas, situación)

> **Nota:** Graph Traversal (referencias cruzadas) se reclasificó a Phase 2
> porque las `referencias` son relaciones legislativas formales (SE MODIFICA,
> DEROGA, DESARROLLA), útiles para temporal awareness pero NO para cross-law
> Q&A semántico. Para eso se necesitan embeddings (Phase 1).

## Phase 0: Validation Spike

**Objetivo:** Validar con datos reales si la síntesis LLM aporta valor sobre búsqueda
mejorada, ANTES de invertir en embeddings o infraestructura nueva.

### Subset de datos

100 leyes estatales vigentes más reformadas (10-300 artículos cada una, ~13,500 artículos total).
Excluimos leyes masivas (Código Civil 2K+ arts, LEC 900+ arts) para mantener el spike manejable.

### Dos prototipos a comparar

| | Prototipo A: Búsqueda mejorada | Prototipo B: RAG básico |
|---|---|---|
| **Retrieval** | FTS5 + sinónimos estáticos | FTS5 + Query Analyzer (LLM) |
| **Síntesis** | Mostrar artículos + citizen_summaries | LLM sintetiza respuesta |
| **Citación** | Links directos a artículos | Citation verifier determinístico |
| **Coste/query** | $0 | ~$0.003 |
| **Riesgo alucinación** | Cero (no hay LLM) | Bajo (citation verifier) |

### Evaluación

20 preguntas reales de ciudadanos:
- 10 con respuesta clara en la legislación (vacaciones, despido, alquiler, IRPF...)
- 5 que requieren cruzar varias leyes
- 5 fuera de ámbito legislativo (→ debe responder "no lo sé")

Para cada pregunta evaluamos:
- ¿El ciudadano entiende la respuesta? (1-5)
- ¿Las citas son correctas y verificables? (sí/no)
- ¿La respuesta es completa? (1-5)
- Latencia (ms)
- Coste ($)

### Decision gate

Si Prototipo A es "suficientemente bueno" (media ≥ 3.5/5 en comprensión): ship A,
defer B. Si B es claramente mejor: proceder a Phase 1 con embeddings.

### Resultados del Benchmark (2026-04-09)

**Model:** google/gemini-2.5-flash-lite via OpenRouter
**Dataset:** 20 preguntas (10 clear, 5 cross-law, 5 out-of-scope), 52 leyes

| Strategy | Retrieval | Citation | Decline | Latency | Cost/q |
|----------|:---------:|:--------:|:-------:|:-------:|:------:|
| FTS5 only | 7% | 100% | 100% | 277ms | ~$0 |
| **FTS5 + LLM keywords** | **80%** | **100%** | **100%** | **1.0s** | **$0.0003** |
| FTS5 + LLM + materia | 80% | 90% | 100% | 1.3s | $0.0003 |
| FTS5 + LLM + materia + tags | 87% | 80% | 100% | 1.5s | $0.0003 |

**Coste total del benchmark:** $0.022 (80 queries). Est. mensual: **$0.82/mes** a 100 q/día.

#### Conclusiones

1. **FTS5 solo es inútil** (7%). Las preguntas ciudadanas no usan vocabulario legal.
2. **FTS5 + LLM keywords es el sweet spot.** El Query Analyzer transforma el lenguaje
   ciudadano a vocabulario legal ("embarazada" → "maternidad"). 80% retrieval, 100% citation accuracy.
3. **Materia/tags añaden ruido.** Más normas recuperadas pero artículos menos relevantes.
   Citation accuracy baja al mezclar evidence irrelevante.
4. **Decline accuracy 100% en todas.** Prompt injection, off-topic: todas rechazadas correctamente.
5. **Coste ridículo.** $0.0003/query. Presupuesto de $15/mes = 50,000 queries/mes.

#### Fallos pendientes (3 de 20 preguntas)

| Q | Pregunta | Root cause | Fix |
|---|----------|-----------|-----|
| Q5 | Salario mínimo | Art. 27 ET define mecanismo, no cifra. El decreto anual con la cifra no está en el subset | Añadir decretos de SMI al dataset |
| Q12 | Deducción alquiler | La deducción se eliminó en 2015. El LLM declina en vez de explicar el régimen transitorio | Fix de prompt: "explica cambios históricos" |
| Q15 | Consumidor defectuoso | Gap semántico: FTS no conecta "defectuoso" con artículos de garantía | **Embeddings** resolverían esto |

#### Hallazgo sobre Graph Traversal

La tabla `referencias` (98K relaciones) contiene:
- 49% reformas (SE MODIFICA, DEROGA) — útiles para temporal awareness
- 14% CITA — relaciones legislativas formales
- 13% DE CONFORMIDAD — relaciones reglamentarias

**NO** contiene relaciones temáticas cross-law (ET ↔ LGSS, Constitución ↔ leyes de privacidad).
El graph traversal se reclasifica a Phase 2 (temporal) en vez de cross-law Q&A.
Para cross-law se necesitan embeddings semánticos (Phase 1).

#### Decision: proceder a Phase 1

FTS5 + LLM keywords valida que el RAG aporta valor real sobre búsqueda simple.
El bottleneck ahora es retrieval semántico (embeddings) para los 3 fallos pendientes.

### Tecnologías del spike

- **LLM:** `google/gemini-2.5-flash-lite` via OpenRouter (ya lo usamos para reform summaries)
- **Retrieval:** SQLite FTS5 (ya existe en `norms_fts`)
- **DB:** `leyabierta.db` existente (no se crea nada nuevo)
- **Runtime:** Bun + TypeScript (stack existente)

### Scripts del spike

```bash
# 1. Generar citizen_article_summaries para el subset (pre-req, ~$3-5)
OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-generate-summaries.ts

# 2. Correr Prototipo A (búsqueda mejorada, sin LLM en runtime)
bun run packages/api/src/scripts/spike-search.ts

# 3. Correr Prototipo B (RAG básico con LLM)
OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-rag.ts

# 4. Comparar resultados
bun run packages/api/src/scripts/spike-compare.ts
```

### Estructura de archivos del spike

```
packages/api/src/
├── services/rag/
│   ├── README.md              ← este archivo
│   ├── spike-questions.ts     ← 20 preguntas de evaluación
│   └── spike-laws.ts          ← IDs de las 100 leyes del subset
├── scripts/
│   ├── spike-generate-summaries.ts  ← genera citizen summaries para el subset
│   ├── spike-search.ts              ← prototipo A (búsqueda mejorada)
│   ├── spike-rag.ts                 ← prototipo B (RAG con LLM)
│   └── spike-compare.ts            ← compara resultados lado a lado
```

## Restricciones de diseño

1. **El LLM nunca genera texto legal.** Solo sintetiza/traduce texto de la DB.
2. **Zero fabricated citations.** Citation verifier determinístico verifica cada cita.
3. **Si no sabe, dice "no lo sé."** Nunca inventa.
4. **Disclaimer legal en cada respuesta.**
5. **Coste < $15/mes** a 100 queries/día.

## Arquitectura objetivo (post-spike)

```
Pregunta del usuario
    │
    ▼
[Query Analyzer] ← LLM barato (extrae keywords + materias)
    │
    ▼
[Hybrid Retrieval] ← FTS5 (keyword) + embeddings (semántico) en paralelo
    │
    ▼
[Reranker] ← ordena por relevancia real
    │
    ▼
[Graph Expansion] ← sigue referencias cruzadas (1 hop)
    │
    ▼
[Temporal Resolution] ← versión vigente en fecha específica
    │
    ▼
[Evidence Assembly] ← empaqueta artículos + context
    │
    ▼
[Synthesis LLM] ← genera respuesta usando SOLO el evidence
    │
    ▼
[Citation Verifier] ← determinístico, verifica cada cita
    │
    ▼
Respuesta + citas verificables + disclaimer
```

## Docs y decisiones

- Design doc: `~/.gstack/projects/leyabierta-leyabierta/alex-main-design-20260409-120619.md`
- CEO plan: `~/.gstack/projects/leyabierta-leyabierta/ceo-plans/2026-04-09-rag-ciudadano.md`
- Plan file: `~/.claude-profiles/konar/plans/snuggly-watching-zebra.md`
