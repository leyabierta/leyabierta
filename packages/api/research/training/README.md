# Reranker training (Fase 1b of RAG-FT)

Workflow + tooling for training the cross-encoder reranker on the dataset assembled in Fase 1a (`packages/api/research/datasets/reranker-v1.jsonl`).

> **Status:** scaffolding only. Pilot dataset is 136 pairs — too small for real training. This directory exists so that when the dataset is scaled to ~5K pairs, the training pipeline is already documented and the data converters are tested.

## Toolchain decision (and why we deviated from the plan)

The original `RAG-FT-PLAN.md` said "LoRA via mlx-lm" for the reranker. That was wrong: **mlx-lm is for autoregressive LLMs, not cross-encoders**. Cross-encoders (XLM-RoBERTa, BGE) need a different trainer.

Realistic options surveyed:

| Toolchain | Pros | Cons |
|---|---|---|
| **sentence-transformers + PEFT (PyTorch / MPS)** | Mature, well-documented for cross-encoder LoRA. Works on M4 Max via MPS backend. PEFT supports XLM-RoBERTa-LoRA out of the box. | Slower than MLX on Apple Silicon (~50-70% of CUDA-equivalent throughput). Requires Python env. |
| mlx-embeddings | Native MLX speed. Supports XLM-RoBERTa loading. | Cross-encoder training (vs bi-encoder) is not first-class yet. Would need custom training loop. |
| mlx-lm | — | Wrong abstraction; doesn't apply. |

**Decision: sentence-transformers + PEFT.** Maturity wins at this scale. We can revisit mlx-embeddings if/when training becomes a bottleneck.

## Prerequisites

```bash
# Python 3.11+ recommended.
python3 -m venv .venv
source .venv/bin/activate
pip install \
  'sentence-transformers>=3.0' \
  'transformers>=4.40' \
  'peft>=0.11' \
  'torch>=2.3' \
  'accelerate>=0.30' \
  'datasets>=2.18'
```

On Apple Silicon, PyTorch will use the **MPS backend** automatically when `torch.backends.mps.is_available()` is `True`. Verify:

```python
import torch
print(torch.backends.mps.is_available())  # should be True
print(torch.backends.mps.is_built())      # should be True
```

## Pipeline

```
reranker-v1.jsonl    →    convert-reranker-data.ts    →    triplets.jsonl
   (Fase 1a)             (this directory)                    (training input)

triplets.jsonl       →    train.py                    →    LoRA adapter (safetensors)
                          (sentence-transformers
                          + PEFT, MPS backend)

LoRA adapter         →    eval.py                     →    R@10 / R@5 deltas
                          (against eval-v2 holdout)
```

### 1. Convert dataset to triplet format

```bash
bun run packages/api/research/training/convert-reranker-data.ts \
  --in packages/api/research/datasets/reranker-v1.jsonl \
  --out packages/api/research/training/triplets.jsonl \
  --format triplet
```

Each input pair (query + positive + N hard negatives) expands to N triplets:

```jsonl
{"query": "...", "positive": "<positive article text>", "negative": "<hard neg 1>"}
{"query": "...", "positive": "<positive article text>", "negative": "<hard neg 2>"}
...
```

This is the exact format `sentence_transformers.losses.MultipleNegativesRankingLoss` expects.

### 2. Train (not yet implemented; spec only)

`train.py` will be a thin wrapper around `sentence_transformers.CrossEncoder` with PEFT LoRA. Target candidate base models (per the plan):

- `BAAI/bge-reranker-v2-m3` — 568M params, multilingual, strong baseline.
- `IIC/MEL` — XLM-RoBERTa-large continual-pretrained on BOE/Congreso (arXiv:2501.16011). Spanish-legal-specific.

LoRA hyperparameters as a starting point (revise after first runs):

```python
LoraConfig(
    r=16, lora_alpha=32, lora_dropout=0.05,
    bias="none", task_type=TaskType.FEATURE_EXTRACTION,
    target_modules=["query", "value"],  # XLM-RoBERTa attention
)
```

Training config:
- batch size: 16 (MPS memory permitting; halve if OOM)
- epochs: 3-5 (early-stop on validation R@10)
- lr: 2e-5
- warmup: 10% of total steps

### 3. Evaluate

`eval.py` runs the trained reranker on the eval-v2 holdout (50 untouchable questions) and reports:

- R@10, R@5, R@1 vs the Cohere baseline
- **R@10 broken down per register** (informal / formal / procedural) — this is the per-register decision we made in Fase 1a to catch register-shift regressions early.
- Inference latency per query (P50, P95).
- $ per query (always 0 for self-hosted; included for the comparison table).

Ship criteria from the plan: variant beats Cohere on factual correctness without R@10 regression and reduces cost by >50%. The cost gate is automatic ($0 vs $0.0025); the R@10 gate is the real bar.

## What's in this directory

- `README.md` (this file)
- `convert-reranker-data.ts` — JSONL pair → triplet converter (committed, tested)
- `train.py` — placeholder, to be added when dataset scales
- `eval.py` — placeholder, to be added when adapter exists
- `triplets.jsonl` — generated artifact, gitignored

## Open questions (to resolve before scaling training)

1. **Loss function**: `MultipleNegativesRankingLoss` (in-batch) vs `MarginMSELoss` (with teacher scores) — the second needs a teacher, the first doesn't. Default: in-batch MNR.
2. **Sequence length**: BGE-reranker-v2-m3 supports 8192 tokens but we'll cap at 512 to fit longer Spanish articles in batch. Articles >512 chars get truncated to first 512.
3. **Trap pairs**: should `is_trap: true` examples get higher loss weight? Probably yes (they're the adversarial cases the system fails on today). Hyperparameter tbd.
4. **Validation split**: we'll hold out 10% of `reranker-v1.jsonl` as a training-time validation set, separate from the eval-v2 holdout. Keeps the eval-v2 holdout truly unseen.
