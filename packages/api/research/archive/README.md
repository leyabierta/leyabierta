# research/archive

Experimentos descartados o cerrados. Se conservan para trazabilidad: cualquier decisión documentada en los post-mortems del repo puede apuntar aquí. **No es código vivo** — no se ejecuta en producción ni en CI, los imports relativos pueden estar desfasados y dependen de versiones de servicios que tal vez ya no existen tal cual.

Si quieres reproducir uno de estos experimentos, el primer paso es leer el `.md` adyacente (cuando exista) o el header del script — la mayoría documenta sus propias precondiciones.

## Subcarpetas

| Carpeta | Qué contiene | Por qué se archivó |
|---|---|---|
| `hyde/` | Implementación de HyDE (hypothetical document embeddings) y sus tests | Probado en Phase 4 del A/B Gemini→Qwen, no mejoró retrieval lo suficiente para justificar la latencia |
| `phase4/` | Scripts de monitoreo y reporting de la Phase 4 del A/B Qwen vs Gemini | Phase 4 cerrada con verdict en `docs/qwen-vs-gemini-decision-r2.md` |
| `contextual-enrichment/` | Experimentos de enriquecimiento contextual de embeddings (vocabulario ciudadano) | Sustituido por la generación de citizen summaries con Qwen 3.6 (ver `ab/qwen36-citizen-summaries/`) |
| `spikes/` | Spikes iniciales del RAG (preguntas, datasets, baselines, evals multi-modelo) | Iteración inicial del pipeline RAG. Superado por los evals canónicos de `research/eval-*.ts` |
| `ab-misc/` | Helpers one-shot del A/B (recovery merges, subset extractors, primeros gold-eval) | Acciones puntuales de cleanup post-run, ya no aplicables |

## ¿Y los gold-evals y DGT/Justicio?

Esos scripts **no están aquí**. Se movieron a `packages/eval/src/sources/` porque siguen vivos como fuentes del dataset v3 en curso.
