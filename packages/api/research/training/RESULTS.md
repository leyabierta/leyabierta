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
| MiniLM 3ep MNR (1968 pairs) | mmarco-mMiniLMv2 | 33M | MNR | 16 | 256 | 3 | 16.5% | 51.8% | **63.6%** | 61.5% | 67.4% | 57.5% |
| MiniLM 3ep MNR (mined negs) | mmarco-mMiniLMv2 | 33M | MNR | 16 | 256 | 3 | 19.1% | 47.8% | **63.2%** | 57.3% | 67.4% | 63.8% |
| MiniLM 3ep MNR (real eval-v2 train split, eval on holdout) | mmarco-mMiniLMv2 | 33M | MNR | 16 | 256 | 3 | 20.6% | 55.1% | **66.9%** | 63.5% | 67.2% | 73.9% | *(n=136, holdout baseline=81.6%)* |
| MiniLM 3ep MNR (grad acc eff=32) | mmarco-mMiniLMv2 | 33M | MNR | 8+acc4 | 256 | 3 | 16.9% | 53.3% | **67.3%** | 65.6% | 69.8% | 63.8% |
| bge-v2-m3 3ep MNR | bge-reranker-v2-m3 | 568M | MNR | 8 | 256 | 3 | — | — | **ABORTED** | — | — | — | *(~32s/step → 11h ETA, killed)* |

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

### 8. Real-query diagnostic (Exp 3, 2026-04-29): distribution IS a factor, but 396 pairs insufficient
Exp 3 took eval-v2 questions directly: 50/50 split (seed=99), 136 train, 136 holdout. Found the most relevant article per norm via BM25, mined BM25 negatives (positions 5..14). Converted to 396 triplets (66 training steps, 3 epochs). Train loss: 1.175 — model barely converged, 66 steps is too few for MNR to stabilize.

Result on holdout: R@10=**66.9%**, holdout no-rerank baseline=**81.6%** → gap of −14.7pp. The real-query model is slightly better than synthetic-only runs (63-65%) but still far below the baseline.

Key interpretation: this is NOT a clean distribution test because (a) the model undertrained (1.175 loss), (b) the positives were found by BM25, not gold article-level annotations. The 396 pairs are real queries but the training signal is still synthetic-quality (BM25-picked positives + BM25 negatives). To truly test whether real queries close the gap, we'd need 1000+ pairs with human-verified article-level gold. **The experiment falsifies "real queries alone are sufficient" — training data quantity AND annotation quality both matter.**

### 9. Gradient accumulation (eff_batch=32) not better than batch 16 (Exp 9, 2026-04-29)
MiniLM on triplets-v3v5, batch 8 + grad_acc 4 = eff_batch 32. Loss: 0.092 (vs 0.032 batch 16). R@10=67.3% — slightly above the 1968-pair runs (63-65%) but below the 824-pair run (68.4%).

Key insight confirmed: MNR loss uses in-batch negatives per micro-batch, not per gradient update. With batch_size=8, each forward pass has 8 negatives, not 32. Gradient accumulation adds nothing for in-batch negative diversity. The experiment was equivalent to "batch 8 MNR with correct gradients" and produced expected results.

### 10. bge-reranker-v2-m3 (568M) aborted — 32 s/step (~11h ETA)
Attempted batch 8, seq 256 on v3v5 triplets. First step: 21s, second: 32s/step. At 1971 steps this would take >11 hours on M4 Max MPS. Aborted. This model is not trainable on Apple Silicon without mixed precision or shorter sequences.

## What's actually worth trying next

In order of expected impact given what we now know:

1. **Hard-negative mining from real retrieval failures.** Take the eval-v2 queries (or a held-out training split), run the trained reranker, collect the top-K candidates that aren't the gold, and feed those as negatives in a second training pass. This grounds negatives in the model's actual confusion surface — not BM25's.
2. **Mix synthetic with curated real queries.** Hand-write or harvest 200-500 real citizen queries (from Search logs, Stack Exchange equivalents, /v1/ask logs once we have them) and weight them heavily. A 200-query curated subset may move the curve more than 5K synthetic.
3. **Cascade with Cohere instead of replacing.** Use FT as cheap 1st-pass filter (top-80 → top-30) and Cohere for top-15. Still cuts Cohere cost ~80% even if FT alone never beats no-rerank.
4. **Different base.** A multilingual reranker without an MS MARCO prior — or even a generic XLM-R fine-tuned from scratch as a cross-encoder — may be more tractable than fighting bge's prior.

Scaling the synthetic dataset further (1968 → 5K) is **not** in this list anymore. The 824 → 1968 controlled experiment is the evidence that path is not load-bearing.

### 6. Hard-negative mining from trained reranker did NOT improve (Exp 1, 2026-04-29)
For Exp 1 we mined hard negatives using the trained bge-base-mnr-v3 adapter itself: BM25 top-100 candidates per query → score all non-gold candidates → pick top-3 scoring (most confusable to the model) as negatives. This produced 1968 pairs × ~4 negatives each = 7852 triplets. The loss during training stayed high (0.23 final vs 0.032 for BM25 negatives), confirming the negatives are genuinely harder.

Result: R@10=**63.2%**, essentially identical to the BM25-negative runs (63.6% / 65.4% / 66.9%) and still −15.8pp below the no-rerank baseline (79.0%). Per-register: formal 67.4% (same as other runs), informal 57.3% (−4.1pp vs best MiniLM), procedural 63.8% (+6.3pp).

The informal register hurt most. This is consistent with the core hypothesis: the trained reranker's top confusables are themselves artifacts of the synthetic-query distribution. Mining from a model trained on synthetic data produces synthetic-flavored hard negatives — they don't bridge the distribution gap, they reinforce it. The model learns to separate articles that synthetic queries confuse, not articles that real citizen queries confuse.

**Implication: all three negative-mining approaches (BM25 5..15, BM25 larger window, reranker-mined) converge to similar failure points.** The bottleneck is NOT the negative type; it's the training query distribution itself. Exp 3 (real query diagnostic) is the critical next test.

### 7. MiniLM on 1968 pairs also regresses vs 824 (Exp 2, 2026-04-29)
To confirm that Exp 5 (bge-base 1968 pairs) wasn't a model-size artifact, we ran MiniLM 33M on the same 1968-pair / 5844-triplet dataset (identical fair config: batch 16, seq 256, 3ep, MNR). Result: R@10=**63.6%** — a **−4.8pp drop** from the MiniLM 824-pair run (68.4%), and the worst overall result after BCE-3ep.

Loss curve: 0.268 → 0.032 (healthy convergence). The model trained fine. The regression is purely distributional: more synthetic data from the same Claude-generation prompt shifts the model further from the eval-v2 lexical space, not closer. Per-register: formal 67.4% (−5.5pp), informal 61.5% (−3.1pp), procedural 57.5% (−6.3pp) — all three registers degraded simultaneously, ruling out a per-stratum rebalancing effect.

**Key finding:** this cross-validates Exp 5. The "more data hurts" pattern holds across both model sizes (33M and 278M) and across all three registers. The dataset generation prompt is the bottleneck, not the training infrastructure or model capacity. Hard-negative mining and real-query distribution (Exp 1 and Exp 3) are the next levers to test.

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
