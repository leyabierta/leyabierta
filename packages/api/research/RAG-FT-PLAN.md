# RAG Fine-Tuning Plan (RAG-FT)

> Living doc. Updated as work progresses. See `## Status log` at the bottom for chronological history.

## TL;DR

Add fine-tuning as a **complement** to the current RAG pipeline, not a replacement. Three phases, prioritized by ROI based on academic evidence and current pipeline costs:

1. **Fase 1 — Reranker fine-tuned** (highest ROI): Replace Cohere rerank-4-pro with a self-hosted cross-encoder fine-tuned on (query, BOE article) pairs. Eliminates ~76% of per-query cost and removes external dependency.
2. **Fase 2 — RAFT-style synthesis** (medium ROI): Fine-tune a small LLM (Qwen 7B / Gemma 12B) on (query, retrieved-with-distractors, cited-answer) for citation faithfulness and refusal calibration.
3. **Fase 3 — Style/domain generator** (deferred): Citizen-summary style and domain adaptation, only after dataset grows past 10K validated examples.

Hardware: training runs on the developer's M4 Max 48GB via MLX-LM (LoRA/QLoRA). Serving runs on the existing Linux server via vLLM.

## Why this order (vs Gemini's suggestion)

The user originally asked Gemini, who suggested fine-tuning the citizen-summary generator. That was the **wrong priority** for two reasons:

- **Cost reality**: Per-query cost breakdown is `analyzer ~$0.0001 + synthesis ~$0.0006 + Cohere rerank ~$0.0025` ≈ $0.0032. The reranker is **~76% of the cost**, not the synthesizer. Replacing it has 4× the cost impact.
- **Failure mode reality**: Known failures (Q2 paternidad 16 vs 19 weeks, Q12 alquiler deduction post-2015) are **retrieval bugs**, not generation bugs. They surface because the retrieval brings derogated articles with literal numbers that win majority votes. Better reranking fixes those; better generation does not.
- **Evidence**: Microsoft "Fine-Tuning or Retrieval?" (arXiv:2312.05934, EMNLP 2024) shows RAG beats SFT for knowledge injection. Redis legal benchmark shows fine-tuned cross-encoders going 30→95% accuracy on legal data. RAFT (arXiv:2403.10131) shows +35% on HotpotQA when training the generator with retrieved distractors. The strongest quantitative evidence is on rerankers.

## Current state (snapshot 2026-04-27)

| Pipeline stage | Model | Pricing (OpenRouter) | Notes |
|---|---|---|---|
| Query analysis | `google/gemini-2.5-flash-lite` | $0.10/$0.40 per M tokens | ~$0.0001/query |
| Hybrid retrieval | gemini-embedding-2 (3072d) + FTS5 BM25 | embeddings already generated | 544K embeddings in DB |
| Reranking | `cohere/rerank-4-pro` (paid via OpenRouter) | **$0.0025 per search** | 80→15 candidates |
| Temporal enrichment | code path | $0 | version history headers |
| Synthesis | `google/gemini-2.5-flash-lite` | $0.10/$0.40 per M tokens | ~$0.0006/query |
| Citation verification | code path | $0 | post-hoc check |

**Eval gate (`packages/api/research/eval-gate.ts`):**
- 65 questions (22 base + 43 hard/adversarial), `data/eval-answers-504-omnibus.json`
- Retrieval: **R@10 = 95%** (57 in-scope)
- Answer quality: **72% factual correctness** (42/58, judge: Claude)
- Cost per run: ~$0.10

**Datasets already in DB usable for FT bootstrap:**
- `citizen_article_summaries`: 3,066 (article → plain-language summary) pairs.
- `embeddings`: 544,264 vectors over 566K blocks in 12,247 norms.
- 65 + 43 eval questions with expected norms.
- `ask_log`: empty (no production users yet).

**Known failure cases worth tracking:**
- Q2 paternidad: returns "16 semanas" (PGE 2018, derogated) vs current "19 semanas" (ET art.48.4). Retrieval issue — derogated articles with literal numbers outvote consolidated text.
- Q12 alquiler: returns 10.05% deduction without flagging it was eliminated post-2015. Retrieval issue.
- Q202 grabar al jefe: gives "No" based on CE art.18 statutory text, but jurisprudencia says "Sí". Out of scope for this plan (would require case law corpus).

## Hardware budget

**Local (M4 Max 48GB unified):**
- LoRA fine-tuning of cross-encoders (≤500M params): minutes to a few hours, fits easily.
- LoRA of 7B-12B LLMs: 4-12h per run, comfortable.
- QLoRA of 27B-32B: 6-12h per run, tight (peak ~22GB), works with grad-checkpointing + batch 1.
- Speed: ~350-500 tok/s on LoRA training (extrapolated from M1 Max 250 tok/s baseline).

**Cloud serving (existing Linux server, see `docs/infrastructure.md`):**
- Cross-encoder reranker: ONNX runtime or sentence-transformers, low memory.
- 7B-12B generator (if Fase 2 ships): vLLM with safetensors. Skip GGUF (MLX→GGUF buggy for Qwen/Gemma).

**Train→deploy flow:** train MLX (FP16 base, not MLX-quantized) → `mlx_lm.fuse` → safetensors → vLLM. Avoids the cuantized export bug.

## Dataset generation strategy

**No production users exist yet**, so we bootstrap from the corpus:

- **Queries**: Claude Code (the assistant in this session) generates plausible citizen questions for each article using the article text + frontmatter. No OpenRouter cost. Parallelizable via async agents sharded by jurisdiction or materia.
- **Positives**: the source article.
- **Hard negatives**: rank 2-10 results from the *current* retrieval pipeline run on each synthetic query. This trains the reranker on the exact mistakes the system makes today.
- **Cited answers** (Fase 2): Claude Code generates with the retrieved context (no Sonnet API call needed); validated by the existing post-hoc citation verifier and discarded if any citation is invalid.
- **Diversification**: existing `citizen_article_summaries` (3,066) inverted — given the summary, generate the question. Highest-quality seeds.
- **Holdout integrity**: the 65 + 43 evals never enter training. Plus 50 net-new questions written by humans (Benjamín, family, friends) as the untouchable test set.

All datasets versioned in `packages/api/research/datasets/` with provenance metadata (which model, which prompt, which date).

## Fase 0 — Pre-work (no training)

Goal: prove the dataset side is the bottleneck, not the model.

**Tasks:**
- **0a. Expand eval gate from 65 → 200 questions.** Coverage: every materia bucket, every jurisdiction (es + 17 CCAA), temporal-sensitive cases, adversarial premises. 50 untouchable holdout. Generated by Claude Code.
- **0b. (REFOLDED into Fase 1b)** — MEL drop-in as bi-encoder needs Python infra (sentence-transformers + 100GB+ of fresh embeddings on the 566K blocks) just to compare. Better path: evaluate MEL as one of the **base-model candidates** when training the Fase 1b cross-encoder reranker, against `bge-reranker-v2-m3`. Same infra, deeper signal.

**Exit criteria:**
- Eval gate runs at 200 questions with stable variance (<3pp run-to-run).
- MEL evaluated; decision documented (use as cascade encoder, ignore, or replace).

**Budget**: ~$0.30 (Gemini Flash Lite eval runs).

## Fase 1 — Reranker fine-tuned

Goal: replace Cohere rerank-4-pro with a self-hosted cross-encoder. Highest evidence (Redis: 30→95% on legal), highest cost impact (~76% of per-query cost).

**Tasks:**
- **1a. Dataset generation (5-10K pairs).** Async agents shard the corpus by jurisdiction/materia. Output JSONL: `{query, positive_id, hard_negatives: [...], source_article_id, materia, jurisdiction}`. Versioned at `packages/api/research/datasets/reranker-v1.jsonl`.
- **1b. Train.** Base candidates evaluated head-to-head: `BAAI/bge-reranker-v2-m3` (568M, multilingual) and `IIC/MEL` (XLM-RoBERTa-large continual-pretrained on BOE/Congreso, arXiv:2501.16011). LoRA via mlx-lm, 2-4h per run on M4 Max. Output: safetensors adapter.
- **1c. A/B test** behind `RERANKER_MODE` env flag:
  - **A**: Cohere rerank-4-pro (current).
  - **B**: FT cross-encoder only.
  - **C**: Cohere → FT cascade.
  - **Metrics**: R@10, R@5, factual correctness on 200-eval, P95 latency, $ per query.
  - **Ship criteria**: variant beats A on factual correctness without R@10 regression and reduces cost by >50%.

**Expected gain**: +5-15 R@10 points on Spanish-domain queries; **cost reduction $0.0025 → ~$0** per query.

**Budget**: ~$0 dataset (Claude Code), ~$1 eval runs.

### Fase 1a — Dataset implementation spec

**Schema** (`packages/api/research/datasets/reranker-v1.jsonl`, one row per training pair):

```jsonc
{
  "id": "rkr-000123",                       // stable ID, batch-sequential
  "query": "¿Cuántos días de permiso por nacimiento tengo?",
  "positive": {
    "norm_id": "BOE-A-2015-11430",
    "block_id": "a48",
    "block_type": "precepto",
    "title": "Artículo 48. Permisos retribuidos.",
    "text": "...",                           // article body at ingest time
    "rank": "ley",
    "jurisdiction": "es",
    "materias": ["Empleo y Trabajo"]
  },
  "hard_negatives": [
    {
      "norm_id": "...", "block_id": "...", "text": "...",
      "source": "semantic-topk"               // top-K of current pipeline minus gold
    },
    {
      "norm_id": "...", "block_id": "...", "text": "...",
      "source": "materia-sibling"             // same materia, different norm
    }
  ],
  "meta": {
    "generation": "synthetic-claude",         // synthetic-claude | real-user
    "generator_pass": "v1",
    "created_at": "2026-04-27"
  }
}
```

**Generation strategy: article-first.** We sample preceptos from the DB and ask Claude Code to generate plausible citizen queries that the article answers — not the reverse. This avoids the failure mode where queries are written first and then forced onto a marginal article.

**Sampling (deterministic, seeded):**
- Source: `blocks` table where `block_type = 'precepto'` and norm `status = 'vigente'`, joined on `norms`.
- Strata: by jurisdiction (state vs CCAA, weighted ~70/30 to mirror real query mix), then by rank (ley/lo > rd > orden, weighted by importance), then by materia (oversample underrepresented to fight long tail).
- Filters out: empty `current_text`, length < 80 chars (too short to ground a query), disposiciones derogatorias (`dd*`).
- Pilot N=50 first, eyeball, then scale to 5K.

**Query generation (Claude Code subagents, sharded by jurisdiction):**
Each subagent receives a batch of articles and produces 1-3 queries per article in mixed registers (formal "¿Cuál es el plazo de prescripción de delitos contra la Hacienda Pública?", informal "¿cuánto tarda hacienda en reclamar?", procedural "¿dónde puedo presentar el modelo 100?"). A small fraction (~10%) generate "trap" queries that *look* answerable by the article but actually require a different one — these become positives for that other article during cross-pollination, and get filtered if no match exists.

**Hard negative mining (two sources per pair):**
1. **Semantic top-K minus gold**: run the article's gold query through the current pipeline (vector + BM25 + RRF, no reranker), take top 20, drop the gold and its same-norm siblings, sample 1-2 from positions 5-15 (close enough to be confusable, far enough to be wrong).
2. **Materia sibling**: random precepto from a different norm with overlapping materia. Tests "right topic, wrong article" — the most common production failure mode.

**Register coverage decisions (post-v1/v2 A/B):**

The v1 prompt produced 56% informal / 35% formal / 9% procedural. v2 (with explicit procedural self-check) produced 35% informal / 35% formal / 29% procedural. In absolute counts (50-article pilot):

| | v1 | v2 | Δ |
|---|---|---|---|
| informal  | 75 | 48 | −27 |
| formal    | 46 | 48 | +2 |
| procedural | 12 | 40 | +28 |

Procedural cannibalised informal, not formal. v1 had a hole at procedural; v2 plugs it but at the cost of informal absolute count.

This matters because real citizen production queries (Google-style, lowercase, no accents) skew informal. The eval gate happens to be 85% formal-by-punctuation (questions written by AI agents with proper accents) — a weak proxy for production mix.

**For the 5K scale-up we'll prompt v3 with target 30 formal / 40 informal / 30 procedural** — informal as plurality, procedural covered, formal maintained. This is the explicit forward decision; v2 stays committed at pilot scale as the proof that prompt iteration moves the metric.

**Fase 1c addition:** report retrieval/reranker metrics _per register_ (R@10 informal, R@10 formal, R@10 procedural) so any per-register regression is visible at A/B time, not after deploy.

**Quality gates before scaling past pilot:**
- ≥80% of pilot queries pass human eyeball: "would a citizen actually ask this?".
- 0% of positives are derogatorias (`dd*`) — sampler enforces this. Disposiciones transitorias/adicionales/finales (`dt*`/`da*`/`df*`) are allowed as positives when their text is substantive, since citizens often ask about them (e.g. IRPF transitoria de vivienda habitual). The retrieval-time article-type penalty is a separate concern.
- ≥90% of pairs have both negative types populated.
- Queries length distribution: P50 ~12 words, P95 < 30 words.

**Output artifacts:**
- `packages/api/research/datasets/reranker-articles-batch.jsonl` — sampled articles ready for query generation (deterministic input).
- `packages/api/research/datasets/reranker-queries-batch-N.jsonl` — generated queries per shard (one file per subagent, easy to audit/discard).
- `packages/api/research/datasets/reranker-v1.jsonl` — assembled final dataset with hard negatives.
- `packages/api/research/datasets/reranker-v1.meta.json` — generation manifest (seed, counts, distribution, generator versions).

## Fase 2 — RAFT-style synthesis (deferred until Fase 1 ships)

Goal: fine-tune a small open-weight LLM to cite verbatim, refuse when context lacks the answer, and run self-hosted to eliminate synthesis API cost.

**Tasks:**
- **2a. RAFT dataset (3-5K examples).** Format: (query, 5 docs with 2-3 distractors, answer with `[BOE-A-XXXX-XXXX, Artículo N]` citations + explicit "no encontrado" examples). Generated by Claude Code; filtered through the existing citation verifier; versioned.
- **2b. Train.** Base candidates: `Qwen/Qwen2.5-7B-Instruct`, `google/gemma-3-12b-it`, `BSC-LT/salamandra-7b-instruct` (Spanish-leaning). LoRA via mlx-lm, 6-12h on M4 Max.
- **2c. Deploy.** Fuse to safetensors, serve via vLLM on Linux server.
- **2d. A/B test** behind `SYNTHESIS_MODEL` env flag against Gemini Flash Lite. Metrics: citation precision, refusal accuracy on out-of-scope, factual correctness, P95 latency, $/query.

**Expected gain**: +15-25% citation precision, +20% refusal accuracy out-of-scope (Finetune-RAG arXiv:2505.10792, Honest AI arXiv:2410.09699).

**Budget**: ~$0 dataset, ~$5 eval runs.

## Fase 3 — Style and domain generator (gated on Fase 2 success + 10K validated dataset)

Reserved for when an expert (Benjamín or similar) has validated ≥10K examples. Citizen-summary style fine-tuning + deeper domain adaptation. Out of scope until then.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Synthetic dataset bias (Claude generates queries Claude would ask) | Use mixed registers; humans write the holdout; varied prompts per shard |
| Catastrophic forgetting (arXiv:2308.08747) | LoRA only (no full FT); mix instruction-tuning data |
| Train→deploy friction (MLX→GGUF for Qwen/Gemma is buggy) | Stay on safetensors; serve with vLLM, not llama.cpp |
| Eval gate variance masking real gains | Expand to 200 first; report bootstrap confidence intervals |
| MLX vs Unsloth speed gap | Acceptable for cross-encoders and 7B; if 27B becomes critical, rent H100 spot |
| Maintenance cost (re-train when base model changes) | Pin base model versions; document re-train procedure |

## Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-04-27 | Order: reranker → RAFT → style | Cost (76% of $/query) + evidence (Redis 30→95%) > Gemini's suggestion |
| 2026-04-27 | Bootstrap dataset from corpus, not users | No production users yet; standard BGE/RAFT technique |
| 2026-04-27 | Generate datasets via Claude Code, not paid APIs | Zero incremental cost on top of subscription |
| 2026-04-27 | Train MLX, serve vLLM | Avoid MLX→GGUF buggy export path for Qwen/Gemma |
| 2026-04-27 | Prompt v2 over v1 for query generation | A/B on same 50-article pilot: procedural register 9% (v1) → 29% (v2). Other metrics held: 0 article-number leaks both runs, P50 word count 9→11, skips 4→2, trap rate ~8% both. v2 spec adds explicit procedural self-check rule before emitting. |

## Status log

- **2026-04-27** — Plan drafted and committed. Tasks tracked: Fase 0a (eval expansion), Fase 0b (MEL drop-in), Fase 1a-c (reranker). Fase 2/3 not yet broken down.
- **2026-04-27** — **Fase 0 done.** Eval gate expanded and re-baselined on the new set; Fase 0b refolded into Fase 1b. See entries below.
- **2026-04-27** — **Fase 0a done.** Eval gate expanded from 65 → 205 questions (155 train/dev + 50 holdout). Generated by 4 parallel Claude Code async agents sharded by slice (autonomic CCAA, underrepresented state materias, temporal-sensitive, procedural+adversarial). All 76 unique `expectedNorms` verified to exist in the DB; zero broken references. Files:
  - `data/eval-v2.json` (full 205, used to baseline) 
  - `data/eval-v2-train-dev.json` (155, freely iterable)
  - `data/eval-v2-holdout.json` (50, untouchable)
  - Per-slice raw outputs: `packages/api/research/datasets/eval-v2-{autonomic,materias,temporal,procedural}.json` (with `rationale` and `obsoleteNorms` fields preserved for human auditing)
  - Build script: `packages/api/research/build-eval-v2.ts`
  - Distribution: 150 clear / 33 cross-law / 22 out-of-scope; 18 with empty `expectedNorms` (genuinely out-of-scope or injection probes)
  - **Cost**: $0 (Claude Code subscription, no OpenRouter calls)
  - **Baseline measured (2026-04-27)**: on 137 in-scope train/dev questions, current pipeline (Gemini Flash Lite analyzer + hybrid retrieval + Cohere rerank-4-pro):
    - **R@1 = 50.4%**
    - **R@5 = 76.6%**
    - **R@10 = 87.6%**
    - decline rate 0.7%, avg latency 4.7s, total run 10.7 min
    - vs. old 65-omnibus baseline (R@10 = 95%): **−7.4pp on R@10** when widened to autonomic CCAA + underrepresented materias + temporal-sensitive + procedural — confirms the new eval discriminates harder.
    - File: `data/eval-v2-baseline.json` (commit `18d520c`, branch `sprint3/refactor-retrieval`).
    - Cost: actual ~$0.30 OpenRouter (analyzer + rerank only; synthesis path skipped via `_retrieveForEval`).
