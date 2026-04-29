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
| bge-base 3ep MNR (1968 pairs) | bge-reranker-base | 278M | MNR | 16 | 256 | 3 | 18.4% | 44.9% | 65.4% | 62.5% | 65.9% | 70.2% |

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

### 5. Doubling the dataset (824 → 1968 pairs) did NOT move the curve
On 2026-04-29 we ran a controlled scale-up: 500 fresh articles (zero overlap with prior batches) sampled with seed 2027, dispatched to 10 parallel Sonnet agents using the v3 prompt, validated (0 parse errors / 0 ID mismatches / 0 article-number leakage / 33.6% formal / 39.2% informal / 27.1% procedural — within tolerance), assembled into `reranker-v5.jsonl` (1279 pairs, 98.7% with both negative types), concatenated with v3 → 1968 pairs / 5844 triplets, and trained bge-base with the identical fair config (batch 16, seq 256, 3ep, MNR). Loss curve healthy (0.37 → 0.02). Result: R@10=65.4%, **−1.5pp vs the 824-pair run** (66.9%) and still −13.6pp from the no-rerank baseline.

Per-register movement was non-uniform:
- formal: 72.1% → 65.9% (−6.2pp)
- informal: 62.5% → 62.5% (flat)
- procedural: 61.7% → 70.2% (+8.5pp)

The procedural gain is real (the v3 prompt over-indexes on procedural framings vs the v2 pilot, and 1968 pairs of that distribution moves it). But formal regresses by the same magnitude, so overall stays put.

**Implication: more synthetic data from the same generation prompt is not the lever.** The original RAG-FT plan presumed scaling to 5K+ would close the gap; this experiment falsifies that assumption. The real bottlenecks are upstream:

1. **Distribution mismatch.** Synthetic queries from Claude don't sit in the same lexical space as the eval-v2 holdout queries. Loss going to 0.02 means the model memorises the synthetic pattern, not the citizen-query pattern. More of the same data deepens the memorisation without bridging the gap.
2. **Negative quality, not negative volume.** Current hard negatives are BM25 top-5..15 minus gold. If the trained reranker fails on candidates that BM25 ranks *outside* top-15 (or *inside* top-5 for a different reason), those are the negatives that would teach. We're not mining those.
3. **The base reranker prior dominates.** bge-reranker-base is trained on web-search MS MARCO. The legal-Spanish prior shift needs either much more data than 5K, a different base (multilingual legal pretraining), or a different loss that decouples relevance learning from web-search bias.

## What's actually worth trying next

In order of expected impact given what we now know:

1. **Hard-negative mining from real retrieval failures.** Take the eval-v2 queries (or a held-out training split), run the trained reranker, collect the top-K candidates that aren't the gold, and feed those as negatives in a second training pass. This grounds negatives in the model's actual confusion surface — not BM25's.
2. **Mix synthetic with curated real queries.** Hand-write or harvest 200-500 real citizen queries (from Search logs, Stack Exchange equivalents, /v1/ask logs once we have them) and weight them heavily. A 200-query curated subset may move the curve more than 5K synthetic.
3. **Cascade with Cohere instead of replacing.** Use FT as cheap 1st-pass filter (top-80 → top-30) and Cohere for top-15. Still cuts Cohere cost ~80% even if FT alone never beats no-rerank.
4. **Different base.** A multilingual reranker without an MS MARCO prior — or even a generic XLM-R fine-tuned from scratch as a cross-encoder — may be more tractable than fighting bge's prior.

Scaling the synthetic dataset further (1968 → 5K) is **not** in this list anymore. The 824 → 1968 controlled experiment is the evidence that path is not load-bearing.

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
