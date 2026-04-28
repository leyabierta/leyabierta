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
| bge-base 3ep MNR | bge-reranker-base | 278M | MNR | 4 | 128 | 3 | 16.5% | 47.1% | 64.3% | 56.2% | 69.8% | 66.0% |

## Findings

### 1. BCE overfits hard at this scale
The legacy `CrossEncoder.fit()` uses `(query, doc, label∈{0,1})` and treats the task as binary classification. With 824 pairs × 3 epochs, MiniLM collapses to R@10=63.6% (vs 68.8% at 1 epoch). Train.py was rewritten to use the v5 `CrossEncoderTrainer` with `MultipleNegativesRankingLoss` (InfoNCE-style), which keeps performance stable at 3 epochs (68.4% vs 68.8% at 1 epoch BCE).

### 2. Untrained base rerankers HURT retrieval
bge-reranker-v2-m3 untrained drops R@10 from 79.0% to 68.0%, especially on informal (-17.7pp). Base rerankers are tuned on web search and apparently add noise on top of vector+BM25+RRF rankings that already work well for legal-Spanish.

The FT challenge therefore has two parts:
- Undo the base reranker's prior biases on legal-Spanish text.
- Learn the actual signals from our query→article gold pairs.

### 3. Memory is a real constraint
M4 Max 64GB with concurrent apps consuming ~45GB leaves ~17GB for training. bge-reranker-base at batch 8 seq 256 OOMs (request was for ~18GB). Forced to batch 4 seq 128, MNR loss gets only 3 in-batch negatives — far weaker contrastive signal than batch 16's 15 negatives. Result: bge-base R@10=64.3% is *worse* than MiniLM R@10=68.4% despite 8× more parameters.

To compare base sizes fairly we need batch 16+ across all runs. That requires either (a) freeing 20-30GB of system memory, (b) gradient accumulation (slower), or (c) smaller seq_length (sacrifices longer articles).

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
