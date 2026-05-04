# Qwen 3.6 vs Gemini 2.5 Flash Lite — Citizen Summaries Experiment

## The Story

We needed to generate citizen-friendly summaries for 436,000 Spanish legal articles. The production model (Gemini 2.5 Flash Lite) costs ~$0.01 per 30-article run. Qwen 3.6 has unlimited tokens for free. Could it produce summaries of equal quality?

**Answer: Yes.** After 7 iterations of prompt engineering, Qwen 3.6 meets all exit conditions.

## The Numbers

| Metric | Qwen 3.6 | Gemini 2.5 Flash Lite |
|--------|----------|----------------------|
| Wins | **7** | 2 |
| Ties (good) | 21 | 21 |
| Empty rate | 3.3% | 0% |
| Error rate | 0% | 0% |
| Cost per run | **$0** | ~$0.01 |

## What Worked

### 1. Few-shot examples were the highest-leverage change

Qwen had been consistently returning empty for borderline substantive articles despite explicit instructions. The examples showed it exactly what "borderline but must summarize" looks like.

### 2. Structured thinking + examples = powerful combo

The `<think>...</think>` thinking format gives the model a reasoning space; few-shot examples give it the right patterns to follow in that space.

### 3. Test changes one at a time

Iteration 7 only changed the prompt (added examples). Everything else was carried forward from previous iterations.

## What Didn't Work

- Increasing max_tokens (32000 vs 8000) — no effect
- Temperature changes — 0.2 was already optimal
- Schema changes — production schema worked fine

## The Full Experiment

7 iterations, 9 run folders, 270 cached Gemini outputs, all documented in the repo:

- [GOAL.md](packages/api/research/ab/qwen36-citizen-summaries/GOAL.md) — experiment design
- [VERDICT-FINAL.md](packages/api/research/ab/qwen36-citizen-summaries/VERDICT-FINAL.md) — final results
- [POST-MORTEM.md](packages/api/research/ab/qwen36-citizen-summaries/POST-MORTEM.md) — full learnings
- [run-iter-7.ts](packages/api/research/ab/qwen36-citizen-summaries/run-iter-7.ts) — winning prompt

## Next Steps

1. Write the backfill script (see issue #XXX)
2. Run it against all 436K articles (~4 days, $0 cost)
3. Update the online lazy-gen path to use Qwen instead of Gemini

## Credits

This experiment was conducted as part of [Ley Abierta](https://github.com/leyabierta/leyabierta) — an open-source engine that mirrors all Spanish legislation as Markdown + Git history.

**Principles:** Open source forever. No monetization. No paywalls. Citizen-first.

**License:** AGPL-3.0 (tooling) + public domain (legislative content).
