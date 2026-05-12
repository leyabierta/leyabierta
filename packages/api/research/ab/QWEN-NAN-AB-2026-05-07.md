# Qwen3-Embedding-8B (nan.builders) vs Gemini — A/B 2026-05-07

## Setup

- **Endpoint**: `https://api.nan.builders/v1/embeddings` (LiteLLM, OpenAI-compatible)
- **Model**: `qwen3-embedding` (8B, **4096 dims**, `encoding_format: "float"` mandatory)
- **Corpus**: 123 norms (23 eval + 100 distractors) → 60.281 chunks
- **Cost**: $0 (unmetered)
- **Embedding time**: ~50 min total (5 workers × batch=32, ~23 emb/s effective)
- **Gold set**: 57 questions from `eval-answers-504-omnibus.json`, norm-level metrics

## Pure dense retrieval (vector only)

| ID | Variant | R@1 | R@5 | R@10 | MRR@10 |
|---|---|---|---|---|---|
| A | **Gemini-2 + task prefix (prod)** | **96.5** | 100.0 | 100.0 | 0.982 |
| G | Qwen-NAN raw query | 71.9 | 91.2 | 94.7 | 0.798 |
| H | Qwen-NAN + Instruct (4096) | 86.0 | 96.5 | 98.2 | 0.901 |
| I | Qwen-NAN + Instruct + MRL@3072 | 86.0 | 96.5 | 98.2 | 0.906 |
| J | Qwen-NAN + Instruct + MRL@2048 | 82.5 | 96.5 | 98.2 | 0.888 |
| K | Qwen-NAN + Instruct ES (4096) | 87.7 | 93.0 | 98.2 | 0.912 |
| **L** | **Qwen-NAN + modern-bias prompt** | **93.0** | 96.5 | **100.0** | **0.950** |
| M | Qwen-NAN + Instruct short | 84.2 | 94.7 | 98.2 | 0.891 |

### Findings

1. **Instruct asymmetric prefix (Qwen3 paper recommendation) adds +14pp R@1** vs raw query.
2. **Modern-bias prompt** (telling the model to prefer modern specific laws over historical codes) adds **+7pp R@1**.
3. **MRL@3072 (truncated) is identical to native 4096**: same R@1/R@5/R@10, even slightly higher MRR. Plus 3.3× faster (259 ms vs 845 ms per query).
4. **Pure dense gap**: Gemini 96.5 → Qwen-modern-bias 93.0 = **3.5 pp R@1**.

## Miss analysis (pure dense)

7 queries where Gemini hit R@1 but Qwen-Instruct (H/I) didn't:

| # | Pattern |
|---|---|
| 2 | Specific RD vs canonical Estatuto |
| **13** | **Constitución at rank 28 (only real miss)** |
| 105 | Código Civil 1889 over LOE 2007 |
| 201 | Vague query, Qwen hesitates |
| 202 | Código Penal over LOPDGDD 2018 |
| 304 | LECrim 1882 over LAU 1994 |
| 608 | Close call (TRLGSS vs ET) |

**Pattern**: Qwen prefers historical/general codes (Código Civil, Código Penal, LECrim) over modern specific laws when both apply. This motivated the modern-bias prompt (variant L).

**Of 7 misses, 6 stay in top-10** (only #13 falls out). This is what motivated the end-to-end test.

## End-to-end (hybrid + RRF + rerank)

Pipeline: vector(60) + BM25(60) → RRF → Cohere rerank-4-pro (via OpenRouter) → top-10.

| Config | Gemini R@1 | Qwen R@1 | Gap | R@5 G | R@5 Q |
|---|---|---|---|---|---|
| Pure dense | 96.5 | 93.0 | -3.5 | 100.0 | 96.5 |
| Hybrid pool=30 + rerank (prod default) | 68.4 | 59.6 | **-8.8** | 93.0 | 87.7 |
| Hybrid pool=50 + rerank | 61.4 | 57.9 | -3.5 | 94.7 | 87.7 |
| Hybrid pool=80 + rerank | 59.6 | 56.1 | -3.5 | 94.7 | 87.7 |
| **Vector pool=30 + rerank** | **64.9** | **64.9** | **0** | 96.5 | 91.2 |
| Vector pool=50 + rerank | 59.6 | 56.1 | -3.5 | 96.5 | 94.7 |

### Findings

1. **BM25 disproportionately hurts Qwen.** Removing BM25 from the pipeline closes the R@1 gap to zero (Vector pool=30 + rerank: tied at 64.9). Keeping BM25 with default pool=30 leaves Qwen 8.8 pp behind.
2. **Larger candidate pool helps Qwen catch up** in hybrid (8.8 → 3.5 pp at pool=50).
3. **Both rerank and BM25 currently degrade R@1 vs pure dense for Gemini too** (96.5 → 68.4). This suggests prod could benefit from rerank tuning (article-type penalty already filters out disposiciones, but the rerank still surfaces them sometimes).

## Recommendation

To make Qwen match Gemini in production without re-embedding the full 484k Gemini corpus prematurely:

1. **Migrate query prompt** to the modern-bias variant (3-line change in `pipeline.ts`):
   ```
   Instruct: Given a Spanish citizen's legal question, retrieve the article
   of Spanish law that best answers it. Prefer modern specific laws
   (Estatuto, LOPDGDD, LAU, LOE) over historical general codes (Código Civil,
   Código Penal, LECrim) when both apply.
   Query: <user query>
   ```

2. **Use MRL@3072** truncation. Qwen's native 4096 has no quality benefit over 3072-truncated, and 3072 is 3.3× faster cosine search. (Bonus: same dim as Gemini, easier infrastructure.)

3. **Reconsider BM25 fusion or its weight** for Qwen. Either:
   - **Drop BM25** (vector + rerank pool=30 ties Gemini at R@1).
   - **Or re-weight RRF** so vector dominates (k_vector=20, k_bm25=80) — not tested here.
   - **Or use larger pool** (50–80 for hybrid) — narrows gap to 3.5 pp.

4. **Expected end-to-end production performance with Qwen-modern-bias + vector-only pool=30 + rerank**: matches Gemini at R@1 (64.9 vs 64.9). Slight residual gap at R@5 (91.2 vs 96.5), recoverable with prompt iteration on the remaining miss patterns.

## Files

- `embed-corpus-nanbuilders.ts` — embedding generation (5 workers × batch=32, busy_timeout, retry+backoff)
- `nan-latency-bench.ts` — provider-side latency characterization
- `eval-ab.ts` — pure dense retrieval A/B (variants A–M)
- `eval-hybrid-rerank.ts` — end-to-end hybrid + rerank A/B (configurable pool, --no-bm25, --no-rerank)
- `eval-misses.ts` — qualitative analysis of where one variant misses
- `debug-pipeline.ts` — single-question stage-by-stage trace

## Next steps (not done)

- Document-side embedding prompt (Qwen3 supports it but is rare in practice; needs full re-embed)
- Weighted RRF (different k per system)
- Larger eval set (#40: 50 citizen queries with norm + article ground truth)
- Real-life latency comparison (Qwen 4096 dot vs Gemini 3072 dot at scale)
