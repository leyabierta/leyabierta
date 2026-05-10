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
