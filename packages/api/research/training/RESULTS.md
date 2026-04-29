# Reranker training — results log

First training pass on the 824-pair / 2448-triplet dataset (v2 pilot + v3 scale-up). All evaluations use the same in-scope set of 272 questions with realistic retrieval candidates (vector + BM25 + RRF, top-80, no rerank).

| Run | Model | Params | Loss | Batch | Seq | Epochs | R@1 | R@5 | R@10 | informal R@10 | formal R@10 | procedural R@10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **No rerank** | — | — | — | — | — | — | 49.3% | 74.3% | **79.0%** | 78.1% | 82.2% | 72.3% |
| **Cohere (plan)** | rerank-4-pro | — | — | — | — | — | — | — | **87.6%** | — | — | — |
| Base bge | bge-reranker-v2-m3 | 568M | — (untrained) | — | 512 | — | 19.5% | 55.1% | 68.0% | 60.4% | 76.0% | 61.7% |
| MiniLM 1ep BCE | mmarco-mMiniLMv2 | 33M | BCE | 16 | 256 | 1 | 18.8% | 53.3% | 68.8% | 66.7% | 72.1% | 63.8% |
| MiniLM 3ep BCE | mmarco-mMiniLMv2 | 33M | BCE | 16 | 256 | 3 | 17.6% | 48.5% | 63.6% | 58.3% | 68.2% | 61.7% |
| MiniLM 3ep MNR | mmarco-mMiniLMv2 | 33M | MNR | 16 | 256 | 3 | 19.9% | 53.3% | **68.4%** | 64.6% | 72.9% | 63.8% |
| bge-base 3ep MNR (small) | bge-reranker-base | 278M | MNR | 4 | 128 | 3 | 16.5% | 47.1% | 64.3% | 56.2% | 69.8% | 66.0% |
| bge-base 3ep MNR (fair) | bge-reranker-base | 278M | MNR | 16 | 256 | 3 | 19.1% | 51.8% | 66.9% | 62.5% | 72.1% | 61.7% |

## Findings

### 1. BCE overfits hard at this scale
The legacy `CrossEncoder.fit()` uses `(query, doc, label∈{0,1})` and treats the task as binary classification. With 824 pairs × 3 epochs, MiniLM collapses to R@10=63.6% (vs 68.8% at 1 epoch). Train.py was rewritten to use the v5 `CrossEncoderTrainer` with `MultipleNegativesRankingLoss` (InfoNCE-style), which keeps performance stable at 3 epochs (68.4% vs 68.8% at 1 epoch BCE).

### 2. Untrained base rerankers HURT retrieval
bge-reranker-v2-m3 untrained drops R@10 from 79.0% to 68.0%, especially on informal (-17.7pp). Base rerankers are tuned on web search and apparently add noise on top of vector+BM25+RRF rankings that already work well for legal-Spanish.

The FT challenge therefore has two parts:
- Undo the base reranker's prior biases on legal-Spanish text.
- Learn the actual signals from our query→article gold pairs.

### 3. Memory is a real constraint (resolved)
First bge-base run was forced to batch 4 seq 128 by an MPS OOM at batch 8. With other apps closed (system reported 27GB workable), we re-ran at the standard batch 16 seq 256 — no OOM, MPS used ~24GB peak. Result is on the table as "bge-base 3ep MNR (fair)".

### 4. Bigger model + same dataset = WORSE generalization
With identical config (batch 16 × seq 256 × 3ep MNR), bge-base 278M reaches R@10=66.9% while MiniLM 33M reaches 68.4%. The 8× bigger model is empirically worse on our 824-pair dataset.

Best explanation: bge-base has stronger learned priors from web-search ranking. With only 824 contrastive pairs, MNR fine-tuning can't move it far enough to overcome those priors on legal-Spanish queries — it converges to a mix of the original biases and partial new signal. MiniLM has weaker priors so the same fine-tuning shifts it more.

This confirms the dataset is the bottleneck, not capacity. **Throwing parameters at 824 pairs hurts.** The right move is to scale data first, then choose model size.

## What's needed to move past the no-rerank baseline

The pipeline works; the dataset is the bottleneck. Next steps in order of expected impact:

1. **Scale dataset 824 → 5K+ pairs.** This is the lever the original RAG-FT plan already targets. With more pairs MNR has more contrastive scope and the model has enough signal to overcome base biases.
2. **Free memory / use a smaller base.** With ~30GB free we can train bge-reranker-base at batch 16 seq 256 — the configuration MNR was designed for. Or use a smaller multilingual base that fits comfortably (e.g. `bge-reranker-base` is the cap; `mMiniLM` already runs but is too small).
3. **Hard-negative mining beyond top-K BM25.** Current negatives come from BM25 top-K minus gold + materia siblings. After we have a trained reranker we can mine negatives that *the trained model* gets wrong, then retrain — iterative refinement.
4. **Cascade with Cohere instead of replacing.** If self-hosted FT can't beat Cohere on its own, route the trained reranker as a 1st-pass filter and keep Cohere for the top-15 final ordering. Still cuts most of Cohere's cost.

## Reproducing

```bash
cd packages/api/research/training
source .venv/bin/activate

# Train (replace base-model + output-dir per run):
python train.py --triplets ./triplets-combined.jsonl \
  --base-model cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 \
  --output-dir adapters/minilm-mnr-v1 \
  --epochs 3 --batch-size 16 --max-seq-length 256

# Eval:
python eval.py --eval ../../../../data/eval-v2.json \
  --candidates ./eval-candidates-realistic.jsonl \
  --reranker ft:adapters/minilm-mnr-v1 \
  --report eval-minilm-mnr-v1.json

# Baseline (no rerank):
python eval.py --eval ../../../../data/eval-v2.json \
  --candidates ./eval-candidates-realistic.jsonl \
  --reranker none \
  --report eval-baseline-no-rerank.json
```
