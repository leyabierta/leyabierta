# archive/2026-05/reports/

Historical analysis and decision documents archived 2026-05-13. These were written during specific research phases and are preserved for traceability — if a decision in the codebase references a phase or experiment, you can find the rationale here.

## Contents

| File | What it covers | Archived because |
|------|----------------|-----------------|
| `EMBEDDINGS-AB-2026-05-01.md` | Embeddings A/B interim report (2026-05-01 snapshot of Gemini vs Qwen3 embedding comparison) | Superseded by the final `QWEN-AB-2026-05-01.md` and `QWEN-NAN-AB-2026-05-07.md` in `research/ab/` |
| `RAG-EVAL-REPORT.md` | Phase 2/3 RAG eval report (2026-04-20); citizen query recall metrics before hybrid search | Eval pipeline rewritten in `packages/eval/` since April 2026; this predates packages/eval/ |
| `INT8-ROLLOUT.md` | int8 quantization rollout plan and risk assessment (2026-04-28) | Rollout complete; `quantize-vectors.ts` shipped; production embeddings now stored as int8 |
