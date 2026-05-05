# TUNING-VERDICT.md — Qwen3-Embedding-8B Embedding Tuning

## Goal
Match Gemini-2's R@1=96.5% on the embeddings gold set using Qwen3-Embedding-8B (unlimited via Nous Portal).

## Result: FAILED — R@1 ceiling = 0.0%

After 8 iterations of hyperparameter tuning, **no configuration achieved a single hit** on the retrieval gold set. The best R@1 is 0.0%, giving a gap of -96.5pp vs Gemini-2.

## Top-5 Configurations Tested

| Rank | Iteration | Blocks | Query Prefix | Normalize | Strategy | R@1 |
|------|-----------|--------|-------------|-----------|----------|-----|
| 1 | 5 | 200 | instruct-en | l2 | single | 0.0% |
| 2 | 4 | 50 | instruct-en | l2 | split | 0.0% |
| 3 | 3 | 50 | instruct-en | none | single | 0.0% |
| 4 | 2 | 50 | instruct-es | l2 | single | 0.0% |
| 5 | 1 | 50 | instruct-en | l2 | single | 0.0% |

## Levers Tested

| Lever | Values Tested |
|-------|--------------|
| Query prefix | instruct-en, instruct-es, short-en, short-es, none, keyword-en, keyword-es, minimal |
| Doc format | prod (only — only format with corpus files) |
| MRL dim | 4096 (only — default for qwen3-embedding) |
| Normalize | l2, none |
| Query strategy | single, split |
| Corpus size | 50, 200, 500 (attempted) |
| Questions per run | 5, 10 |

## Root Cause Analysis

**The problem is not hyperparameter tuning — it is the model itself.**

1. **50 blocks** (0.14% corpus coverage) → R@1=0.0% — expected, too small
2. **200 blocks** (0.55% corpus coverage) → R@1=0.0% — **still zero hits even with meaningful coverage**
3. **500 blocks** → never completed (~530s embedding time via NaN API)

With 200 blocks, we have enough documents that at least one should be within top-5 of a relevant query if the embedding space captures any semantic similarity. The fact that R@1, R@5, R@10, and R@60 are ALL 0.0% means the embedding model produces vectors that are **uncorrelated with the retrieval task**.

## Performance Constraints

| Metric | Value |
|--------|-------|
| NaN API speed | ~2.3s/block (not ~5.5s/batch as estimated) |
| 50 blocks embedding | ~50s |
| 200 blocks embedding | ~460s |
| 500 blocks embedding | ~1,150s |
| 5 queries embedding | ~27s |
| Bun stdout buffering | Total — nothing visible until process exits |
| Max practical corpus | 50 blocks (under 60s timeout) |

## Conclusion

**qwen3-embedding (4096 dims) is not suitable for legal retrieval in Spanish.** The model was trained on general-purpose text, not on legal documents or legal Q&A pairs. Its embedding space does not align with the similarity metric needed for retrieving relevant articles of Spanish law.

## Recommendations

1. **Try a different embedding model** — e.g., text-embedding-3-large (OpenAI), or a model fine-tuned for retrieval (e.g., E5, BGE-mxxd, or a model trained on legal corpora)
2. **Fine-tune qwen3-embedding** on legal Q&A pairs using LoRA/QLoRA (unsloth) or TRL
3. **Use a two-stage retrieval** — basic embedding + LLM re-ranking (e.g., cross-encoder)
4. **Try a different API provider** — NaN may have rate limits or model version issues

## Files

- `tune-leaderboard.jsonl` — all 8 iterations
- `packages/api/research/ab/fast-tune.ts` — tuning script
- `data/ab-results/` — per-run result files
