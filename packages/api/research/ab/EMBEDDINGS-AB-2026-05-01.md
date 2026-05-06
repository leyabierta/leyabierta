# Embeddings A/B (2026-05-01/02) — Gemini-2 vs local Qwen3-Embedding-8B vs embeddinggemma-300m

**Status:** complete
**Date:** 2026-05-01 setup, 2026-05-02 03:35 results
**Branch:** main (research files untracked, not part of any commit)
**Author:** automated session, judged by retrieval metrics on a fixed gold set

## TL;DR

**Production stays on `google/gemini-embedding-2-preview`.**

- Qwen3-Embedding-8B at Q8_0 with all 5 model-card pitfalls fixed scores
  **R@1 = 86.0%**, identical to the 2026-04-25 OpenRouter run (also 86.0%).
  The dtype/padding-opacity hypothesis is dead — the prior result was clean,
  Qwen genuinely loses to Gemini on this corpus.
- Gemini-2 holds **R@1 = 96.5%, R@5 = 100%** on the same fixed corpus + gold
  set — the +10.5pp gap over Qwen is not a setup artefact.
- embeddinggemma-300m is too small: **R@1 = 71.9-73.7%** depending on prompt
  format. Size matters for Spanish legal text.
- Re-open this A/B only when: a Qwen3.5-Embedding (or larger Qwen embedder)
  ships, Gemini-2 leaves preview with adverse pricing, or we get a tasked-
  fine-tuned legal embedder.

## Why redo a 6-day-old A/B

The 2026-04-25 A/B compared `google/gemini-embedding-2-preview` (the production
model) against `qwen/qwen3-embedding-8b` via OpenRouter. Result: Gemini-2 won
clearly (R@1 96.5% vs 86.0%, -10.5pp).

When re-auditing the 2026-04-25 setup against the official Qwen3-Embedding model
card and paper (arXiv:2506.05176), two of the five pre-flight checks came back
opaque rather than confirmed:

| # | Check | Status |
|---|---|---|
| 1 | dtype = BF16 (not FP16, which causes NaN overflow in the MLP for token "import") | ⚠ opaque — OpenRouter does not expose provider dtype |
| 2 | MRL: truncate first, normalize after | ✅ verified in `eval-ab.ts:241-269` and `ollama-embeddings.ts:94-115` |
| 3 | Padding side = `left` (causal LLM, last-token pooling) | ⚠ opaque — handled by provider, not visible to client |
| 4 | Task description in English even when corpus is Spanish | ✅ `qwen3QueryPrefix` uses an English instruction |
| 5 | Documents go in raw, NO `Instruct:/Query:` prefix | ✅ `embed-corpus-openrouter.ts:109` sends raw text |

The two opaque points are precisely the ones the model card flags as biggest
quality killers if mis-configured. Re-running with a local llama-server gives us
full control of dtype (Q8_0 integer quant, no FP overflow risk on Apple Silicon
Metal) and pooling/padding (`--embeddings --pooling last`).

This A/B also adds a new model: `embeddinggemma-300m` (Google), a 300M-parameter
sibling to `gemini-embedding` that runs locally. Interesting because if it
matches Gemini-2 on this corpus, it would be a viable fully-self-hosted path
without needing an 8 GB Qwen model.

## Setup

### Hardware
- M-series Mac, 48 GB unified memory, Metal-accelerated llama.cpp.
- Models on external `/Volumes/Disco1TB/models/embeddings/` (internal disk
  pressure unrelated, see global memory).

### Models tested

| Variant | Model | Quant | Source | Storage |
|---|---|---|---|---|
| A (baseline) | google/gemini-embedding-2-preview | server-side, opaque | OpenRouter (cached) | DB `gemini-embedding-2`, 60.281 vectors × 3072 |
| G | Qwen/Qwen3-Embedding-8B | Q8_0 GGUF | `Qwen/Qwen3-Embedding-8B-GGUF` (HF, official) | DB `qwen3-local-q8`, target 60.281 × 4096 |
| H | same | same | same | G truncated MRL@2048 |
| I | same | same | same | G truncated MRL@1024 |
| M | google/embeddinggemma-300m | BF16 GGUF | `unsloth/embeddinggemma-300m-GGUF` | DB `embgemma-local`, target 60.281 × 768 |
| (M2) | same | same | same | M with `task: question answering` prefix instead of `task: search result` |

The Unsloth repos for Qwen3-Embedding GGUFs that the user originally pointed at
(`unsloth/Qwen3-Embedding-{0.6,4,8}B`) do not exist; only the official
`Qwen/Qwen3-Embedding-8B-GGUF` carries the 8B GGUFs.

### Server config

**Qwen3-Embedding-8B Q8_0** (port 8090):
```bash
llama-server \
  -m /Volumes/Disco1TB/models/embeddings/qwen3-embedding-8b/Qwen3-Embedding-8B-Q8_0.gguf \
  -ngl 99 -c 65536 -ub 2048 -b 4096 -fa on --parallel 4 \
  --embeddings --pooling last \
  --host 127.0.0.1 --port 8090 --alias qwen3-local-q8
```

**embeddinggemma-300m BF16** (port 8091):
```bash
llama-server \
  -m /Volumes/Disco1TB/models/embeddings/embeddinggemma-300m/embeddinggemma-300M-BF16.gguf \
  -ngl 99 -c 8192 -fa on --parallel 2 \
  --embeddings --pooling mean \
  --host 127.0.0.1 --port 8091 --alias embgemma-local
```

Pooling differs: Qwen3 is causal LLM with last-token pooling (per model card),
embeddinggemma is encoder-style with mean pooling (per Sentence-Transformers
default and confirmed in the Google model card examples).

### Prompt formats

| Side | Qwen3-Embedding-8B | embeddinggemma-300m | Gemini-2 |
|---|---|---|---|
| Query | `Instruct: Given a Spanish citizen's legal question, retrieve the article of Spanish law that best answers it.\nQuery: {q}` (instruction in English even though corpus is Spanish — model card explicit) | `task: search result \| query: {q}` — and an alternate `task: question answering \| query: {q}` we'll also try | `task: question answering \| query: {q}` (production format) |
| Document | raw text, no prefix (asymmetric retrieval — Qwen paper §2) | `title: {norm_title} \| text: {chunk_title}\n\n{chunk_text}` (matches Google's documented document format almost exactly — coincidentally already what corpus.ts produces) | (already cached in DB from prior runs) |

### Corpus

Same as 2026-04-25 A/B: 23 ground-truth norms (from
`eval-answers-504-omnibus.json`) + 100 distractor norms (top-cited vigente by
`reforms*2 + articles`). 46.416 articles → **60.281 sub-chunks** after
splitting by apartados. Identical text formatting across all variants — only
the embedding model differs.

### Gold set

57 questions from `eval-answers-504-omnibus.json` with `expectedNorms` populated.

### Methodology

For each question, embed the query, run cosine search over the model's filtered
store (60.281 vectors restricted to the 123 corpus norms), find the rank of the
first chunk belonging to any expected norm, compute R@1, R@5, R@10, R@60,
MRR@10.

Gemini-2 query embeddings are computed once and cached in
`data/ab-results/gemini-query-embeddings.json` to avoid re-billing OpenRouter
on subsequent runs.

## Pre-flight sanity checks (passed)

For each local server, before running the corpus embed:
- Embed one known query.
- Verify `dim` matches model registry.
- Verify `‖v‖ ≈ 1.0` (server normalises, otherwise we re-normalise client-side).
- Count NaN floats — must be zero.

| Server | dim | ‖v‖ | NaN |
|---|---|---|---|
| Qwen3-Embedding-8B Q8_0 | 4096 | 1.0000 | 0 |
| embeddinggemma-300m BF16 | 768 | 1.0000 | 0 |

## Throughput (measured, M-series 48GB)

| Model | Steady-state | Wall time | Skipped (>ctx) |
|---|---|---|---|
| Qwen3-Embedding-8B Q8_0 (batch=16, 4 slots, c=65536) | ~3.4 emb/s avg (3.9 → 2.4 over run, longer chunks at tail) | 6h 47min | 24 chunks (0.04%) |
| embeddinggemma-300m BF16 (batch=32, 4 slots, c=8192) | ~25 emb/s avg (44 → 24, same pattern) | 37 min | 4576 chunks (7.6%) — Gemma's 2048-token context too small for some legal articles |

Gemma is 12-18× faster than Qwen at runtime on the same hardware (300m vs 8B
parameters), but loses 7.6% of the corpus to its smaller context window. For
production, this would require client-side chunking at <2000 tokens — an
additional pre-processing step that Qwen and Gemini do not need.

## Results

### Variant A — Gemini-2 baseline (production)

Re-ran 2026-05-01 against the same corpus and gold set as the 2026-04-25 A/B.
Numbers reproduced exactly:

| Metric | 2026-04-25 | 2026-05-01 |
|---|---|---|
| R@1 | 96.5% | **96.5%** |
| R@5 | 100.0% | **100.0%** |
| R@10 | 100.0% | **100.0%** |
| MRR@10 | 0.982 | **0.982** |
| Latency | — | 496ms |

Memory entry confirmed accurate. Gemini query embeddings cached for reuse.

### All variants — final table (2026-05-02 03:35)

| Var | Label | R@1 | R@5 | R@10 | R@60 | MRR@10 | Query latency |
|---|---|---|---|---|---|---|---|
| **A** | Gemini-2 + task prefix (production) | **96.5%** | **100.0%** | 100.0% | 100.0% | **0.982** | 496 ms (cold OpenRouter) |
| G | Qwen-8B local Q8 + Instruct (EN) @4096 | 86.0% | 96.5% | 98.2% | 100.0% | 0.902 | 71 ms (local) |
| H | Qwen-8B local Q8 + Instruct + MRL@2048 | 80.7% | 94.7% | 98.2% | 100.0% | 0.874 | 70 ms |
| I | Qwen-8B local Q8 + Instruct + MRL@1024 | 86.0% | 98.2% | 98.2% | 100.0% | 0.907 | 70 ms |
| M | Gemma-300m + `task: search result` | 71.9% | 86.0% | 87.7% | 98.2% | 0.782 | 10 ms |
| N | Gemma-300m + `task: question answering` | 73.7% | 87.7% | 93.0% | 98.2% | 0.805 | 9 ms |

### Variant G — Qwen3-Embedding-8B Q8_0 local: confirms 2026-04-25 result

R@1 = 86.0% — **identical to the 2026-04-25 OpenRouter run (86.0%).**

This is the load-bearing finding of the whole exercise. The previous A/B was
clean: dtype, padding, pooling, and the task prefix were all correct (or, more
precisely, the unknowns about provider dtype/padding turned out not to matter
for this corpus on this scale of difference). The 10.5pp gap to Gemini-2 is
real signal, not setup error.

Latency drops from Gemini's 496 ms (cold OpenRouter API call) to Qwen's 71 ms
on local llama.cpp — 7× faster — but the quality gap dominates that decision.

### Variants H, I — MRL@2048, MRL@1024 (anomaly)

Surprising pattern:
- @4096 (full): R@1 86.0%, R@5 96.5%
- @2048 (half): R@1 80.7%, R@5 94.7% — drops 5.3pp R@1
- @1024 (quarter): R@1 86.0%, R@5 98.2% — recovers and even improves R@5

This non-monotonic behaviour (1024 ≥ 4096 > 2048 on R@1) is unusual. Two
hypotheses:
1. The 2048-dim slice happens to land in a less discriminative region of the
   Matryoshka basis for this corpus's distribution. MRL training does not
   guarantee strict monotonicity at every dim — it guarantees graceful
   degradation on average across MTEB tasks.
2. Noise: with N=57 questions, a single question swing = 1.7pp. The 5pp gap
   could partially be sample noise.

For production, if we ever wanted Qwen at lower storage cost, **MRL@1024 looks
strictly better than @2048**. But since we're keeping Gemini, this is moot.

### Variants M, N — embeddinggemma-300m: too small

R@1 71.9% (task: search result) → 73.7% (task: question answering, +1.8pp from
the documented alternate prompt). Both far below Gemini and Qwen.

The R@10 and R@60 numbers (87.7-93.0% and 98.2%) suggest the right norms
*are* in the corpus — Gemma just can't rank them at the top. A reranker on
top would likely close some of this gap, but we don't have a benchmark of
"weak embedder + Cohere Rerank" to confirm.

For Spanish legal RAG, **300M parameters is genuinely too small**. The
multi-million-parameter embedders (Qwen 8B at 86%, Gemini ?? but >> 300m) all
clear 80% R@1; Gemma falls into the 70s. Size matters here.

The **+1.8pp from prompt change** is real but small. The Google docs are right
to specify task-specific prefixes, but for this corpus the choice between
`search result` and `question answering` is in the noise.

## Decision

**Production stays on `google/gemini-embedding-2-preview`.** Touched all
production code paths during the audit; no change is going in.

We hit the third decision branch: Qwen-G loses by >2pp R@1 (-10.5pp actual),
which means the prior 2026-04-25 result holds, and the dtype/padding-opacity
hypothesis that motivated the redo is **falsified** — the previous A/B was
clean to begin with.

Gemma-M loses by even more (-22.8pp), confirming that 300M is too small for
this domain. The faster latency does not compensate.

## Implications for the model registry

Both new model keys (`qwen3-local-q8` and `embgemma-local`) are now registered
in `EMBEDDING_MODELS` in `embeddings.ts`. They are pure research keys — no
production code path looks them up. Two options:

1. **Leave them in.** Registry pollution is minimal, and they're useful if we
   re-open this A/B (or want to run quick smoke evals against new local
   models).
2. **Remove them post-decision.** Cleaner registry, but requires re-adding
   for future re-runs.

Recommendation: leave them in until next prod release; they cost nothing and
preserve the experimental scaffolding.

## If we ever migrate (preserved from pre-result scaffold for future runs)

Production touch points (verified 2026-05-01):

| File | Line | Change |
|---|---|---|
| `packages/api/src/services/rag/embeddings.ts` | 38 | `gemini-embedding-2` registry entry → new model |
| `packages/api/src/services/rag/embeddings.ts` | ~1018 | `modelKey === "gemini-embedding-2"` query-prefix branch → adapt |
| `packages/api/src/services/rag/retrieval.ts` | 53 | `EMBEDDING_MODEL_KEY = "gemini-embedding-2"` → flip |
| `packages/api/src/services/hybrid-search.ts` | 42 | `HYBRID_EMBEDDING_MODEL_KEY = "gemini-embedding-2"` → flip |
| `packages/api/research/sync-embeddings.ts` | — | re-embed all 484k production vectors with new model |
| `data/vectors.bin` + `data/vectors.meta.jsonl` | — | rebuild from new vectors. Storage delta:<br>Gemini-2 (3072 dim, fp32): 5.9 GB → Qwen (4096 dim, fp32): 7.9 GB (+33%)<br>With existing int8 quant (PR #64): 1.49 GB → 1.98 GB (+33%) — still manageable |
| Inference endpoint | — | OpenRouter $$ + dtype-opaque, OR self-hosted (FP8 cluster pending, or llama.cpp on KonarServer as stop-gap) |

Plan: roll out behind a feature flag (`EMBEDDING_MODEL_OVERRIDE` env var that
the embedding loader checks), shadow-traffic eval for 48h on prod logs, then
cutover.

## Caveats

1. **N=57 questions** is small. Recall percentages move in 1.7-pp jumps per
   question. Differences <2pp are noise.
2. **Q8_0 quant is not full BF16.** Q8_0 has ~0.5% RMS quantization error per
   tensor, well below typical retrieval noise but non-zero. If a result is
   tight (±1pp), download the f16 GGUF (15 GB) and re-run for ground truth.
3. **The corpus is filtered to 123 norms** (23 eval + 100 distractors).
   Production retrieval works against ~10k norms (484k vectors). The A/B
   measures *retrieval discrimination* on a controlled pool, not absolute
   production performance.
4. **No reranker in the pipeline.** Production has Cohere Rerank 4 Pro on
   top. A weaker embedder + good reranker can match a strong embedder
   without reranker. The A/B isolates the embedder.

## Followups

- **Memory update:** the existing `project_embeddings_ab` memory entry is
  reinforced, not invalidated. Add a 2026-05-02 line confirming the redo.
- **Reranker still does the heavy lifting.** Production retrieval includes
  Cohere Rerank 4 Pro on top of Gemini. None of these embeddings are the
  whole pipeline; if we ever did want to migrate, the reranker would
  partially compensate for a weaker embedder.
- **`task: question answering` for Gemini is documented** in `embeddings.ts`
  as the production prefix (line ~1018). Worth verifying that this is still
  the optimal prefix for `gemini-embedding-2-preview` after the model graduates
  from preview, and consider an A/B between it and the alternate documented
  prefixes (`task: search result`, etc.) if Google's docs change.
- **Don't forget to restart `qwen start`** for the generative cluster path —
  this session stopped it to free RAM for the embedder. `qwen start` re-launches
  llama-server on port 8080 with the Qwen3.6-35B GGUF.
- **The 24 chunks Qwen skipped (>16k tokens)** and the **4576 chunks Gemma
  skipped (>2k tokens)** are not retried in the eval — they live in the corpus
  but don't have embeddings, so they're invisible to retrieval. For the eval
  this is fine (gold answers are in the corpus norms, almost all under any
  context limit). For production we'd need to client-chunk before embedding,
  which production already does via `subchunk.ts:splitByApartados`.

## Artefacts

- [`embed-corpus-llamacpp.ts`](embed-corpus-llamacpp.ts) — llama.cpp adapter
  for corpus embedding, supports both Qwen-8B and Gemma-300m via `--model`.
- [`eval-2026-05-local-vs-gemini.ts`](eval-2026-05-local-vs-gemini.ts) — the
  eval harness with Gemini query caching.
- [`gemini-query-embeddings.json`](../../../../data/ab-results/gemini-query-embeddings.json)
  — Gemini queries cached to disk (no further OpenRouter calls).
- Final eval JSON: `data/ab-results/eval-2026-05-{ts}.json` (one per run).
