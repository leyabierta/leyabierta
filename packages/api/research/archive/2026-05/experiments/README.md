# archive/2026-05/experiments/

One-shot experiment scripts and concluded sub-experiments archived 2026-05-13.

## Contents

| Entry | What it did | Verdict / Archived because |
|-------|-------------|---------------------------|
| `quantize-vectors.ts` | Offline int8 quantization of the vector index — reads `data/vectors.bin` (Float32, ~5.5 GB) in chunks and writes `vectors-int8.bin` + `vectors.meta.jsonl`. Symmetric per-vector quantization, scale = max\|v\|. | Ran once to produce the int8 index. Referenced in JSDoc comments in `packages/api/src/services/rag/embeddings.ts` but not imported. Production embeddings now stored as int8; this script is only needed if re-quantization is required. |
| `qwen36-citizen-summaries/` | 7-iteration A/B experiment comparing Qwen3.6 vs Gemini 2.5 Flash Lite for generating citizen-language article summaries (≤280 chars + 3-5 tags). Included blind LLM judging with randomized X/Y labels. | **Verdict (2026-05-04):** Qwen3.6 wins 7–2 with 21 ties on 30 stratified articles. Exit conditions met. See `VERDICT-FINAL.md` and `POST-MORTEM.md` in the subfolder. Production backfill uses Qwen3.6 via NaN stack. |
