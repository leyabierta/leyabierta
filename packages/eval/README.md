# @leyabierta/eval

Generación y mantenimiento del dataset canónico de evaluación de retrieval/RAG para Ley Abierta.

Reemplaza el set de 50 preguntas (`packages/api/research/datasets/citizen-queries.json`) por un dataset versionado (~2000 preguntas) con ground truth a nivel **norma + artículo**, generado mediante un pipeline multi-agente sobre NaN (Qwen 3.6 + Gemma 4) con voto de 3 jueces y revisión humana en borderline.

## Estado

- **Fase 0** (auditoría): hecha — ver `docs/AUDIT-2026-05-10.md`
- **Fase 1** (scaffolding): en curso
- **Fase 2** (pilot 20): pendiente
- **Fase 3** (run grande 2000): pendiente
- **Fase 4** (splits + decisión Qwen vs Gemini sobre el set nuevo): pendiente

## Estructura

```
packages/eval/
├── README.md            # este fichero
├── package.json
├── docs/
│   ├── AUDIT-2026-05-10.md           # auditoría de datasets existentes
│   └── PLAN-DATASET-GEN-2026-05-10.md # plan operativo del pipeline
├── datasets/
│   ├── seeds/            # 114 preguntas humanas reciclables (citizen + RAG)
│   ├── pilot/            # 20 preguntas del pilot (con outputs intermedios)
│   └── v3/               # dataset final (~2000)
└── src/
    ├── schema.ts         # tipos canónicos
    ├── importers/        # lectores de citizen-queries.json y eval-answers-*.json → schema v3
    ├── sampling/         # estratificación corpus → (norm, article) candidates
    ├── agents/           # personas, generador, leak-detector, critic, jueces
    ├── pipeline.ts       # orquestación end-to-end
    └── cli.ts            # `bun run packages/eval/src/cli.ts ...`
```

## Principios

1. **Grounded:** cada pregunta nace de un `(norm, article)` real del corpus.
2. **Multi-respuesta:** `expectedNorms[]` y `expectedArticles[]` admiten varias respuestas válidas.
3. **Multi-modelo:** Qwen y Gemma alternan como generadores y como jueces.
4. **Consenso 2/3:** una pregunta entra solo si 2 de 3 jueces NaN la aceptan.
5. **Humano en borderline:** cuando el voto no es unánime, va a una cola para revisión manual.
6. **Disjoint splits:** la misma norma nunca aparece en train + val + test.

## Comandos previstos

```bash
# importar las 114 preguntas humanas existentes al schema nuevo
bun run packages/eval/src/cli.ts import

# pilot de 20 preguntas (ajuste de prompts)
bun run packages/eval/src/cli.ts generate --pilot

# run grande
bun run packages/eval/src/cli.ts generate --target 2000

# revisar la cola de borderline interactivamente
bun run packages/eval/src/cli.ts review-borderline

# producir splits train/val/test desde el set aceptado
bun run packages/eval/src/cli.ts split
```

## Pilot review workflow

Mientras el pipeline no sea completamente fiable, **toda pregunta aceptada pasa
por una revisión estructurada** antes de incorporarse al dataset. La revisión
la realiza un subagente (Devin/Claude) sobre un Markdown autocontenido que
incluye texto de los artículos relevantes, votos del jurado y una plantilla
para verdict + score.

Flujo end-to-end:

1. **Generar el batch**

   ```bash
   bun run packages/eval/src/cli.ts generate --pilot
   ```

   Produce `packages/eval/datasets/pilot/accepted-<stamp>.jsonl`.

2. **Construir el input de revisión**

   ```bash
   bun run packages/eval/src/cli.ts review-batch \
     packages/eval/datasets/pilot/accepted-<stamp>.jsonl
   ```

   Genera `review-input-<stamp>.md` con una sección por pregunta. Cada sección
   trae texto del artículo seed, alternativas, votos del jurado y un bloque
   `Reviewer task` con `Verdict: KEEP | MARGINAL | DROP` y `Score (0-3 each):
   C / A / L / S = ?/?/?/? = ?/12` para rellenar.

3. **Lanzar el subagente de revisión**

   El orquestador (Devin/Claude) llama a `run_subagent` con instrucciones del
   tipo: "lee este Markdown, rellena cada bloque Reviewer task con tu
   verdict (KEEP/MARGINAL/DROP), las cuatro puntuaciones C/A/L/S y una
   rationale de una línea, y escribe el resultado en
   `<misma-ruta>-reviewed.md`". El subagente devuelve el Markdown completo con
   los bloques `Verdict: <valor>` rellenos.

4. **Resumir y filtrar**

   ```bash
   bun run packages/eval/src/cli.ts review-batch-summarize \
     packages/eval/datasets/pilot/review-input-<stamp>-reviewed.md
   ```

   Produce:

   - `review-summary-<stamp>.md` — distribución de verdicts, medias por eje,
     desglose por voice/materia entre los KEEP, tabla por pregunta.
   - `keep-<stamp>.jsonl` — subconjunto de `EvalQuestion` con verdict KEEP
     (apto para integrar al dataset).
   - `marginal-drop-<stamp>.jsonl` — borderline + descartes (cola para iterar
     prompts o anotación humana).

   El parser tolera secciones malformadas: avisa por stderr y las omite en vez
   de fallar.

## Gemini legacy stack (for A/B only)

The `rag-gemini-legacy` retriever resurrects the pre-Phase-6 Gemini+Cohere stack as an eval-only plugin so you can run a true A/B comparison against the Qwen baseline. It uses `gemini-embedding-2` (3072 dims, OpenRouter) for query embeddings, reads the 483K corpus vectors from `data/vectors-gemini.bin`, and reranks with Cohere rerank-4-pro (direct or via OpenRouter).

**Step 1 — Export the Gemini vectors (one-time, ~15 min, ~5.7 GB output):**

```bash
bun run packages/api/scripts/export-gemini-vectors.ts
```

**Step 2 — Run the A/B eval:**

```bash
# Gemini legacy stack
bun run packages/eval/src/run-eval.ts \
  --in data/eval-subset-v2.jsonl \
  --retriever rag-gemini-legacy \
  --out data/results-gemini.jsonl

# Qwen prod stack (baseline)
bun run packages/eval/src/run-eval.ts \
  --in data/eval-subset-v2.jsonl \
  --retriever rag-direct \
  --out data/results-qwen.jsonl

# Compare
bun run packages/eval/src/compare-ab.ts \
  --a data/results-qwen.jsonl \
  --b data/results-gemini.jsonl
```

**Env vars required:**

| Var | Required for |
|-----|-------------|
| `OPENROUTER_API_KEY` | Gemini query embeddings (`google/gemini-embedding-2-preview`) + Cohere rerank via OpenRouter if no direct key |
| `COHERE_API_KEY` | Direct Cohere rerank (optional; preferred over OpenRouter — cheaper, lower latency) |

At least one of `COHERE_API_KEY` or `OPENROUTER_API_KEY` must be set for construction to succeed. `OPENROUTER_API_KEY` is always required for the Gemini embedding step.

**Dry-run check (no queries processed):**

```bash
bun run packages/eval/src/run-eval.ts \
  --in data/eval-subset-v2.jsonl \
  --retriever rag-gemini-legacy \
  --dry-run
```

If `data/vectors-gemini.bin` is missing, this exits with:
```
[rag-gemini-legacy] vectors-gemini.bin not found at ...
Export the Gemini vectors first:
  bun run packages/api/scripts/export-gemini-vectors.ts
```

## Monitoring long runs

A full `generate --target 2000+` run can take hours. The pipeline writes
`packages/eval/datasets/.progress.json` (atomically updated every ≈1s).
In a second terminal:

    bun run packages/eval/src/cli.ts watch

You'll see a live dashboard with progress bar, acceptance rate, ETA,
drop reasons, last accepted, last borderline. Safe to run at any time
(renders whatever's in the file) and to leave unattended.
