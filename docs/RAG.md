# RAG: Preguntas y respuestas sobre legislación

## Qué es esto

Ley Abierta incluye un sistema de preguntas y respuestas legales (endpoint `POST /v1/ask`). Un ciudadano escribe una pregunta en lenguaje natural — "¿Cuánto dura la baja por paternidad?" — y el sistema busca los artículos de ley relevantes, los lee, y genera una respuesta con citas verificables a artículos concretos.

El sistema NO interpreta la ley ni da consejo legal. Es un **sintetizador**: explica lo que dicen los artículos que encuentra, con citas inline para que el ciudadano pueda verificar cada afirmación en la fuente original.

Principio fundamental: **"El LLM es un sintetizador, no un adjudicador."** Si la evidencia es correcta, cualquier modelo genera la respuesta correcta. El pipeline se encarga de entregar evidencia limpia; el LLM solo la narra.

---

## Arquitectura

```
Pregunta del ciudadano
        |
        v
 ┌─────────────────────┐
 │  1. Query Analysis   │  LLM extrae keywords, sinónimos legales,
 │     (Analyzer)       │  materias, jurisdicción, intent temporal
 └────────┬────────────┘
          |
          v
 ┌─────────────────────────────────────────────────────┐
 │  2. Hybrid Retrieval                                 │
 │                                                      │
 │  Vector search (coseno, 484K embeddings)             │
 │  + BM25 (keywords del ciudadano)                     │
 │  + BM25 sinónimos legales                            │
 │  + Named-law lookup (si nombra una ley concreta)     │
 │  + Core-law BM25 (7 leyes fundamentales)             │
 │  + Recent-BM25 (normas < 3 años)                     │
 │  + Collection density (leyes con más artículos)      │
 │  + Recency boost (normas reformadas recientemente)   │
 │                                                      │
 │  Fusión: Reciprocal Rank Fusión (RRF, k=60)         │
 └────────┬────────────────────────────────────────────┘
          |
          v
 ┌─────────────────────┐
 │  3. Reranking        │  Cohere Rerank 4 Pro reordena ~80 candidatos
 │                      │  + legal hierarchy boost
 │                      │  + diversity penalty
 │                      │  + article type penalty
 └────────┬────────────┘
          |
          v
 ┌─────────────────────┐
 │  4. Evidence Build   │  Top 15 artículos, ordenados en 3 niveles:
 │                      │  ley general > sectoral > autonomica > modifier
 │                      │  + metadata headers + top-1 highlighting
 └────────┬────────────┘
          |
          v
 ┌─────────────────────┐
 │  5. Temporal Enrich  │  (solo preguntas temporales)
 │                      │  Inyecta historial de versiones
 └────────┬────────────┘
          |
          v
 ┌─────────────────────┐
 │  6. Synthesis        │  LLM genera respuesta con citas inline
 │                      │  [BOE-A-XXXX-XXXX, artículo N]
 └────────┬────────────┘
          |
          v
 ┌─────────────────────┐
 │  7. Citation Verify  │  Verifica que cada cita existe en la DB
 └─────────────────────┘
```

### Detalle de cada etapa

**1. Query Analysis.** Un LLM barato (Gemini 2.5 Flash Lite, ~$0.0001/query) analiza la pregunta y extrae:
- `keywords`: términos del ciudadano ("paternidad", "alquiler")
- `legalSynonyms`: cómo aparecen esos conceptos en el texto legal ("nacimiento y cuidado del menor", "arrendamiento")
- `materias`: categorías temáticas ("Derecho laboral")
- `temporal`: si la pregunta es sobre cómo ha cambiado la ley
- `nonLegal`: si la pregunta no es sobre legislación (poemas, deportes)
- `jurisdiction`: si se refiere a una comunidad autónoma concreta
- `normNameHint`: si nombra una ley especifica ("Estatuto de los Trabajadores")

**2. Hybrid Retrieval.** Busca artículos relevantes por multiples vias en paralelo y fusiona los resultados con RRF. Cada via aporta candidatos desde un ángulo distinto:
- **Vector search**: similitud semántica entre la pregunta y 484K embeddings de artículos
- **BM25 keywords**: búsqueda por texto exacto con los términos del ciudadano
- **BM25 sinónimos**: búsqueda con los términos legales formales
- **Named-law lookup**: si el ciudadano nombra una ley, busca dentro de ella
- **Core-law BM25**: búsqueda con sinónimos dentro de 7 leyes fundamentales (ET, CC, CE, LAU, LGSS, LOPDGDD, TRLGDCU)
- **Recent-BM25**: búsqueda dentro de normas publicadas en los últimos 3 años
- **Collection density**: leyes con muchos artículos en el pool reciben un bonus
- **Recency boost**: normas reformadas recientemente puntuan más

**3. Reranking.** Cohere Rerank 4 Pro reordena los ~80 candidatos por relevancia semántica. Después se aplican ajustes deterministicos:
- **Legal hierarchy boost**: si una ley fundamental estatal (ET, CC, CE) fue eliminada por el reranker, sustituye al artículo sectoral/autonomico de menor rango
- **Diversity penalty**: artículos repetidos de la misma norma reciben penalización progresiva (1.0, 0.7, 0.5, 0.3)
- **Article type penalty**: disposiciones transitorias (0.3x), derogatorias (0.1x), finales (0.5x), adicionales (0.7x)

**4. Evidence Build.** Los artículos se ordenan en 3 niveles antes de entregarselos al LLM: ley general estatal primero, ley sectorial/reglamentaria segundo, ley autonomica tercero, leyes modificadoras al final. El primer artículo lleva una marca especial `>>> artículo PRINCIPAL <<<` para reforzar la primacy bias del LLM.

**5. Synthesis.** El LLM (Gemini 2.5 Flash Lite) genera la respuesta en lenguaje ciudadano con citas inline. El prompt le indica que es un sintetizador — no interpreta, no juzga, no usa su conocimiento de entrenamiento para cifras o plazos.

**6. Citation Verify.** Cada cita inline se verifica contra la base de datos para confirmar que el artículo citado existe.

---

## Controles de calidad

### Qué previene respuestas incorrectas

| Control | Qué hace | Coste |
|---------|----------|-------|
| Filtro de normas derogadas | `AND n.status != 'derogada'` en todas las queries SQL | $0 |
| Article type penalty | Disposiciones transitorias (0.3x), derogatorias (0.1x), finales (0.5x), adicionales (0.7x) | $0 |
| Diversity penalty | Cada artículo adicional de la misma norma puntua menos (1.0 → 0.7 → 0.5 → 0.3) | $0 |
| Legal hierarchy boost | Leyes fundamentales estatales no se eliminan del evidence a favor de normas sectoriales | $0 |
| Non-legal gate | Si el analyzer detecta que la pregunta no es legal, declina sin gastar en retrieval | $0 |
| Absorbed modifier penalty | Normas que `MODIFICA` otra ley cuya base se actualizo después reciben 0.05x | $0 |
| Periodic family detection | Series de normas anuales (SMI, IPREM): solo la más reciente puntua; las antiguas 0.02x | $0 |
| Publication age decay | Normas no fundamentales (reales decretos, ordenes) pierden relevancia con la edad: `1/(1+edad/5)` | $0 |
| Evidence ordering 3 niveles | Ley general > sectorial > autonomica > modificadora. El LLM ve primero lo más aplicable | $0 |
| Top-1 highlighting | El artículo principal se marca visualmente para reforzar primacy bias | $0 |
| Metadata headers | Cada artículo lleva contexto: `[TEXTO CONSOLIDADO | Última actualizacion: YYYY-MM-DD]` | $0 |
| Low confidence threshold | Si la mejor puntuación de retrieval es < 0.38, no se pasa evidencia al LLM | $0 |
| Numbers to digits | Convierte "diecinueve semanas" → "19 semanas" en la evidencia para evitar que el LLM "corrija" cifras | $0 |

### Por qué estos controles

El principio rector es que **el pipeline toma decisiones determinísticas y el LLM solo sintetiza**. Si le pasas 15 artículos al LLM donde 7 dicen "16 semanas" y 1 dice "19 semanas", el LLM dirá "16 semanas" — no porque sea malo, sino porque la evidencia está contaminada. La solucion no es un prompt mejor, sino evidencia más limpia.

Esto se validó empiricamente: 5 modelos distintos alucinaron "16 semanas" con evidencia contaminada. Con evidencia limpia, los 5 acertaron.

---

## Enriquecimiento contextual

### El problema

El vocabulario del ciudadano no coincide con el del texto legal. Ejemplo canónico:

- El ciudadano pregunta: **"¿Cuánto dura la baja por paternidad?"**
- El ET art. 48.4 (ley vigente) dice: "El **nacimiento**, que comprende el parto y el cuidado de menor [...] **diecinueve semanas**"
- La PGE 2018 (ley obsoleta) dice: "suspensión del contrato por **paternidad** durante **cinco semanas**"

El embedding de "paternidad" coincide mejor con la PGE que con el ET, porque el ET uso un término de género neutro en su reforma de 2019. Sin intervención, el sistema citaría la ley obsoleta.

### La solucion: sinónimos ciudadanos en los embeddings

Basado en el paper [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) de Anthropic, prepend al texto del artículo una lista de términos ciudadanos antes de generar el embedding:

```
title: Estatuto de los Trabajadores | text: artículo 48. Suspensión con reserva...

[Términos ciudadanos: baja por paternidad, baja por maternidad, permiso parental,
permiso por nacimiento de hijo, 19 semanas, 16 semanas, permiso del padre...]

El nacimiento, que comprende el parto y el cuidado de menor...
```

Esto hace que el embedding del ET art. 48 sea semánticamente cercano tanto a "paternidad" como a "nacimiento".

### Artículos enriquecidos actualmente

| artículo | Términos ciudadanos | Por qué |
|----------|---------------------|---------|
| ET art. 48 | paternidad, maternidad, permiso parental, nacimiento | Reforma de género neutro |
| ET art. 20 | test de drogas, reconocimiento médico, vigilancia de la salud | Términos técnicos vs coloquiales |
| CE art. 18 | mirar mi móvil, registrar mi casa, secreto comunicaciones | Derechos fundamentales en lenguaje cotidiano |
| LGSS arts. 327-330 | paro autónomo, cese de actividad, desempleo autónomos | Terminologia técnica de Seguridad Social |
| ET arts. 45, 53, 55 | embarazada, despido embarazada, nulidad despido | Proteccion por maternidad |
| LAU art. 7 | derechos inquilino, casero entrar piso | Arrendamientos en lenguaje cotidiano |
| LETA art. 33 | paro autónomo, compatibilizar paro | Regimen especial autónomos |

### Cómo añadir más enriquecimientos

1. Identifica el artículo con vocabulary mismatch (normalmente lo revela un fallo en el eval)
2. Añade una entrada al array `ENRICHMENTS` en `packages/api/research/contextual-enrichment-apply.ts`
3. Ejecuta: `bun run packages/api/research/contextual-enrichment-apply.ts`
4. Reinicia la API: `bun run api` (re-exporta embeddings automaticamente)
5. Corre el eval para verificar que no hay regresiones

Para restaurar los embeddings originales: `bun run packages/api/research/contextual-enrichment-restore.ts`

---

## Modelos y costes

| Componente | Modelo | Coste por query | Por qué |
|------------|--------|-----------------|---------|
| Analyzer | `google/gemini-2.5-flash-lite` | ~$0.0001 | Barato y rápido. Solo extrae keywords y flags |
| Embeddings | `google/gemini-embedding-2-preview` | ~$0.0000 (pre-generados) | #1 en MTEB general, 3072 dimensiones, 8K contexto, $0.20/M tokens |
| Reranker | `cohere/rerank-v4-pro` | $0 (free tier) | 1,000 req/mes gratis. Buena calidad de reranking |
| Synthesis | `google/gemini-2.5-flash-lite` | ~$0.0006 | Mejor balance coste/calidad. 98% norm hits |

**Coste total por query:** ~$0.001 (menos de una milesima de dolar).

**Coste de embeddings (one-time):** ~$16 para 484K embeddings de 9,738 normas vigentes.

### Formato de embeddings

Gemini Embedding 2 requiere prefijos inline:
- **Documentos:** `title: Estatuto de los Trabajadores | text: artículo 48. Suspensión...`
- **Queries:** `task: question answering | query: ¿Cuánto dura la baja por paternidad?`

El parámetro `task_type` de la API NO funciona con Gemini Embedding 2 — los prefijos deben ir en el texto.

### Almacenamiento de embeddings

Los embeddings se guardan como BLOBs en la tabla `embeddings` de SQLite (crash-safe, inserciones atómicas). Para la búsqueda vectorial, se exportan a un archivo binario plano (`data/vectors.bin` + `data/vectors.meta.jsonl`) que se lee en chunks de ~1GB para evitar cargar 6GB en memoria.

La búsqueda es fuerza bruta exacta (similitud coseno). A 484K vectores tarda ~13s — aceptable dado que la sintesis LLM añade 5-8s adicionales. Si se escala a millones de artículos (multi-pais), se migraria a HNSW.

---

## Evaluación

### Dataset

65 preguntas clasificadas en categorías:
- **clear**: preguntas directas con respuesta en un artículo ("¿Cuántas semanas de paternidad?")
- **cross-law**: preguntas que requieren multiples leyes ("derechos de una embarazada")
- **out-of-scope**: preguntas no legales o sin respuesta en el corpus ("mejor poema de Machado")

### Métricas

**Norm hit rate (retrieval):** ¿La respuesta cita la ley esperada? Métrica determinista, sin LLM.

**Answer quality (4 dimensiones, 1-5):** Juzgada por Claude Code como evaluador.
- **Correctness**: ¿Es factualmente correcta?
- **Completeness**: ¿Cubre todos los aspectos relevantes?
- **Faithfulness**: ¿Inventa algo que no está en la evidencia?
- **Clarity**: ¿Se entiende para un ciudadano?

### Resultados actuales

| Métrica | Valor |
|---------|-------|
| Norm hit rate | **93%** (mejores datos: 89-96% segun fase) |
| Correctness | 4.46 / 5 |
| Completeness | 4.23 / 5 |
| Faithfulness | 4.43 / 5 |
| Clarity | 4.62 / 5 |
| **Overall** | **4.43 / 5** |
| Out-of-scope correctly declined | 6/6 (100%) |

### Cómo ejecutar el eval

```bash
# Iniciar el servidor API
bun run api

# Recoger respuestas (65 preguntas)
bun run packages/api/research/eval-collect-answers.ts \
  --output data/eval-experiment-N.json

# Las respuestas se juzgan manualmente o con Claude Code como evaluador
```

---

## Cómo mejorar una respuesta incorrecta

### Paso 1: Diagnosticar

¿Es un problema de **retrieval** o de **synthesis**?

- **Retrieval**: el artículo correcto NO llega a la evidencia del LLM. Se ve en los logs: el artículo esperado no aparece entre los 15 artículos seleccionados.
- **Synthesis**: el artículo correcto SI está en la evidencia, pero el LLM lo ignora o malinterpreta.

### Paso 2: Arreglar

**Si es retrieval** (el artículo correcto no llega):
1. ¿Es un vocabulary mismatch? → Añadir enriquecimiento contextual al artículo (ver sección anterior)
2. ¿La norma no está embebida? → Verificar con `sync-embeddings.ts --dry-run`
3. ¿La norma es demasiado antigua y recibe age decay? → Revisar si deberia ser fundamental rank

**Si es synthesis** (el artículo llega pero la respuesta es incorrecta):
1. ¿El LLM usa cifras de su entrenamiento en vez del texto? → Verificar que `numbersToDigits()` convierte los números escritos a dígitos
2. ¿El LLM ignora el artículo principal? → Revisar el evidence ordering
3. ¿El prompt es ambiguo? → Mejorar las reglas en `SYSTEM_PROMPT`

### Paso 3: Verificar

```bash
# Correr el eval completo para verificar que no hay regresiones
bun run packages/api/research/eval-collect-answers.ts \
  --output data/eval-after-fix.json
```

---

## Decisiones arquitectonicas clave

### ¿Por qué búsqueda híbrida?

La búsqueda vectorial sola falla cuando hay vocabulary mismatch entre el lenguaje ciudadano y el legal. BM25 complementa capturando coincidencias exactas de términos. Además, cada via de búsqueda aporta candidatos desde ángulos distintos — collection density detecta leyes con muchos artículos relevantes, recent-BM25 prioriza normas recientes.

### ¿Por qué "sintetizador, no adjudicador"?

Probamos darle al LLM reglas para resolver conflictos entre artículos ("si uno es texto consolidado y otro es ley modificadora, usa el consolidado"). No funcionó: el LLM hacía juicios incorrectos, usaba su knowledge de entrenamiento, o simplemente ignoraba las reglas con evidencia ruidosa. La solucion fue mover TODA la lógica de filtrado al pipeline determinístico y dejar al LLM solo el trabajo de narrar.

### ¿Por qué flat array en vez de HNSW?

Simplicidad. Con 484K embeddings, la búsqueda exacta tarda ~13s — aceptable para nuestro caso de uso. Un array plano permite operaciones triviales de add/remove (añadir norma = append, eliminar derogada = filter). HNSW requiere reconstrucción del grafo. A escala multi-pais (millones), migraríamos a HNSW.

### ¿Por qué SQLite en vez de una base vectorial?

Un solo archivo, crash-safe, inserciones atómicas, consultas SQL para metadata. No necesitamos un servicio separado (Pinecone, Qdrant) para 484K vectores. SQLite almacena los embeddings como BLOBs; para la búsqueda se exportan a un archivo binario plano.

### ¿Por qué Gemini Embedding 2?

Es #1 en MTEB general y #7 en benchmarks legales (MLEB). Soporta 8K tokens de contexto (importante para artículos largos), cuesta $0.20/M tokens, y está disponible vía OpenRouter. No elegimos embeddings especializados en legal (Voyage-law-2) porque requieren vendor lock-in y no soportan español nativamente.

### ¿Por qué Cohere Rerank?

Free tier de 1,000 requests/mes. Calidad de reranking comparable a cross-encoders comerciales. Fallback a reranking basado en LLM si la API falla.

---

## Archivos clave

| Archivo | Qué hace |
|---------|----------|
| `src/services/rag/pipeline.ts` | Orquestador principal — todas las etapas |
| `src/services/rag/embeddings.ts` | Búsqueda vectorial, generación de embeddings, store SQLite |
| `src/services/rag/blocks-fts.ts` | Búsqueda BM25 a nivel de artículo |
| `src/services/rag/reranker.ts` | Cohere Rerank / fallback LLM |
| `src/services/rag/temporal.ts` | Enriquecimiento temporal (historial de versiones) |
| `src/services/rag/subchunk.ts` | Sub-chunking de artículos largos por apartados |
| `src/services/rag/rrf.ts` | Reciprocal Rank Fusión |
| `src/services/rag/jurisdiction.ts` | Resolución de jurisdicción (es, es-ct, es-pv...) |
| `research/contextual-enrichment-apply.ts` | Script de enriquecimiento contextual |
| `research/contextual-enrichment-restore.ts` | Restaurar embeddings originales |
| `research/sync-embeddings.ts` | Generación y sincronización de embeddings |
| `research/eval-collect-answers.ts` | Recolección de respuestas para evaluación |
