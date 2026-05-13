# archive/2026-05/evals/

Standalone eval scripts written before `packages/eval/` existed as the canonical eval harness. Archived 2026-05-13. These ran as one-off probes during April 2026; the active eval infrastructure is now in `packages/eval/src/`.

## Contents

| File | What it measured | Archived because |
|------|-----------------|-----------------|
| `eval-adversarial.ts` | Adversarial edge cases (hallucinations, wrong citations, temporal errors) on the 65-question omnibus set | Pre-packages/eval era; packages/eval/ harness covers adversarial now |
| `eval-citizen-bm25.ts` | BM25-only baseline for Issue #40 (Fase 2 hybrid search); measured Recall@1/5/10 via the DbService.searchLaws path | Issue #40 closed; BM25 now part of hybrid retrieval in production |
| `eval-citizen-hybrid.ts` | Hybrid search baseline (BM25 + vector) for Issue #40 | Same as above; hybrid retrieval shipped |
| `eval-citizen-quantized.ts` | Vector eval using int8-quantized embeddings | Quantization validated and shipped; packages/eval/ is the eval path |
| `eval-gate.ts` | Sprint 3 R@K probe asserting retrieval refactor is observably identical to pre-refactor prod | Sprint 3 complete; pipeline.ts still references this in a JSDoc comment for traceability |
| `eval-judge.ts` | LLM judge panel prototype (deliberation-based quality scoring) | Superseded by the judge harness in packages/eval/src/llm/ |
