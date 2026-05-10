# Plan operativo — Generación del dataset de eval v3

**Fecha:** 2026-05-10
**Objetivo:** ~2000 preguntas balanceadas con ground truth `(norm, article)` multi-respuesta, generadas por pipeline multi-agente sobre NaN.
**Restricciones:** NaN expone Qwen 3.6 y Gemma 4 a coste cero, 100 RPM / 5 concurrentes, JSON mode + json_schema. Tiempo por pregunta no es un problema.
**Decisiones tomadas (2026-05-10):**

- Tamaño objetivo: ~2000, balanceado.
- Ground truth: multi-norm + artículo (los embeddings son por artículo).
- Panel: 3 jueces NaN + Alex en borderline.
- Auditar primero los 24 `eval-answers-*.json` antes de generar (hecho — ver `AUDIT-2026-05-10.md`).
- Ubicación: `packages/eval/` (nuevo paquete del workspace).

## Arquitectura del pipeline

```
Sampler (código, estratificado por materia × jurisdicción × rango × década)
    ↓ (norm, article) seeds
Persona Generator (qwen3.6) — 3 personas plausibles por seed
    ↓
Question Generator (alterna qwen3.6 y gemma4) — 1 pregunta por persona
    ↓
Leak Detector (qwen3.6, prompt distinto) — descarta si filtra BOE-ID, nombre exacto, art. nº, citas literales >5 palabras
    ↓
Answerability Checker (gemma4) — "¿esta norma responde a esta pregunta?"
    ↓
Citizen-Voice Critic (gemma4) — reescribe si suena a abogado; rechaza tras N intentos
    ↓
Alternative Finder (retrieval BM25+vectores + LLM votante) — enriquece expectedArticles
    ↓
Panel de 3 jueces (qwen3.6, gemma4, qwen3.6 con prompt adversarial)
    ↓
   3/3 accept → entra
   2/3        → entra
   1-2/3      → cola borderline para revisión humana
   0/3        → descarta
    ↓
Difficulty Scorer (qwen3.6) — easy/medium/hard
    ↓
Dedup (embeddings, cosine ≥ 0.85) — descarta duplicados
    ↓
Fila final del dataset (con provenance completa)
```

## Schema del output

`packages/eval/src/schema.ts` ya tiene el contrato. Campos clave:

- `id` — hash determinista del texto.
- `question`, `voice` (`citizen` | `formal`).
- `expectedNorms[]` y `expectedArticles[]` con flag `primary`.
- `materia` (BOE oficial), `jurisdiction` (ELI), `difficulty`.
- `split` (asignado al final con disjunción por norma).
- `provenance` — discriminated union según origen (humano vs agente).

## Roles (mapeo a archivos)

| Rol | Archivo | Modelo |
|---|---|---|
| Sampler | `src/sampling/strata.ts` | (código) |
| PersonaAgent | `src/agents/personas.ts` | qwen3.6-nan |
| QuestionGeneratorAgent | `src/agents/question-gen.ts` | qwen3.6-nan ⇄ gemma4-nan |
| LeakDetectorAgent | `src/agents/leak-detector.ts` | qwen3.6-nan |
| AnswerabilityAgent | `src/agents/answerability.ts` | gemma4-nan |
| CitizenVoiceCriticAgent | `src/agents/citizen-voice.ts` | gemma4-nan |
| AlternativeFinderAgent | `src/agents/alternatives.ts` | retrieval real + qwen3.6-nan |
| JudgePanel | `src/agents/judges.ts` | qwen3.6, gemma4, qwen3.6-adv |
| DifficultyScorerAgent | `src/agents/difficulty.ts` | qwen3.6-nan |
| DedupAgent | `src/agents/dedup.ts` | NaN embeddings (mismo modelo Qwen3-embed que prod) |

## Fases y entregables

### Fase 0 — Auditoría (HECHA)

Entregable: `docs/AUDIT-2026-05-10.md`.

Conclusión: 114 preguntas humanas reciclables (50 citizen + 64 RAG únicas).

### Fase 1 — Scaffolding (EN CURSO)

Entregables:
- `packages/eval/` creado.
- `src/schema.ts`, `src/pipeline.ts`, `src/agents/types.ts`, `src/cli.ts`. ✅
- `src/importers/` para reciclar las 114 humanas → schema v3. (Pendiente)
- `src/sampling/strata.ts` con cuotas por celda. (Pendiente)
- Prompts en `src/agents/prompts/` (un fichero por rol). (Pendiente)
- Cliente NaN en `src/llm/nan-client.ts` que envuelve `packages/api/src/services/nan.ts` y produce traces a Opik bajo `leyabierta-eval`. (Pendiente)

### Fase 2 — Pilot de 20

- `bun run packages/eval/src/cli.ts generate --pilot`
- Output: `datasets/pilot/run-<ts>.jsonl` + un `pilot-report.md` con todos los outputs intermedios visibles.
- Alex revisa manualmente las 20 + las que cayeron en cada filtro.
- Gate: ≥80% de aceptación humana. Si no, ajustamos prompts y repetimos.

### Fase 3 — Run grande (~2000)

- Cuotas por materia/jurisdicción definidas en `src/sampling/quotas.ts`.
- Stop conditions: target alcanzado, o tasa de aceptación cae <30% durante 200 seeds (señal de que algo se desvía).
- Borderline queue (~10-20% esperado) → cola JSONL para revisión humana posterior.
- Output: `datasets/v3/raw-<ts>.jsonl`.

### Fase 4 — Revisión humana de borderline

- TUI mínima (`bun run ... review-borderline`) que para cada item muestra: pregunta, expectedArticles, votos, razones; Alex pulsa `a`/`r`/`s`(skip).
- Tras revisión, se mergean al dataset.

### Fase 5 — Splits y validación

- Algoritmo: agrupa por norma, asigna grupos (no preguntas) a 70/15/15. Garantiza disjunción.
- Output: `datasets/v3/{train,val,test}.json` + `meta.json`.
- Decisión Qwen vs Gemini sobre `test` con bootstrap CI 95% → carpeta-decisión en el vault.

## Estimaciones

- ~10 llamadas NaN por pregunta × ~3s × 5 concurrentes ≈ 6s netos/pregunta.
- 2000 preguntas ≈ 3-4 h wall clock. Coste: 0€.
- Tiempo humano: ~1 h pilot + ~1-2 h borderline.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Mode collapse (preguntas todas parecidas) | 2 modelos generadores en alternancia + dedup por embedding + estratificación dura. |
| Jueces "amables" que aceptan todo | 1 de los 3 jueces usa prompt adversarial ("encuentra problemas"). Calibrar contra pilot humano. |
| Ground truth `expectedArticles` incorrecto | Alternative Finder corre nuestro retrieval real y un LLM votante; primary article siempre es el seed (irrefutable). |
| Filtros demasiado estrictos → 0 aceptaciones | Métricas de drop rate por etapa visibles en dashboard del run. Stop condition automático. |
| Generador filtra BOE-ID en la pregunta | Leak detector con regex + LLM. Test unitario con 20 ejemplos conocidos. |
| Dataset overfit a NaN/Qwen3 | Calibración final contra el set humano (50 citizen + 64 RAG). Si la correlación de R@K con el set humano es <0.7, revisar. |

## Decisiones cerradas (2026-05-10)

- **Opik:** reutilizamos `leyabierta-rag`. Diferenciamos por `name` de la trace
  (`eval-dataset-gen`, `eval-judge-panel`, `eval-alternative-finder`).
- **Article-level annotation de las 114 humanas: ANTES del pilot.**
  Sirve como prueba de fuego del Alternative Finder con ground truth conocido
  a nivel norma. Gate: ≥90% de coincidencia entre `expectedNorms` humano y
  la norma primaria devuelta por el agente. Por debajo de eso, ajustamos
  prompt y/o retrieval antes de seguir.
- **Held-out humano: 50 preguntas (25 citizen + 25 RAG)** estratificadas por
  materia, en `datasets/heldout/human-50.json`. El generador no ve sus
  normas como seeds; los jueces no las ven durante calibración. Métrica
  final: Spearman de R@K humano vs R@K agente ≥ 0.7.
