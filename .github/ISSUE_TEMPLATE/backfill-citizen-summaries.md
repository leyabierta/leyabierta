# Backfill all 436K citizen summaries with Qwen 3.6

## Context

We ran an A/B experiment comparing Qwen 3.6 vs Gemini 2.5 Flash Lite for generating citizen-friendly legal summaries. The experiment is complete and Qwen 3.6 meets all exit conditions.

### Experiment Results

- **Qwen wins:** 7 vs Gemini 2 wins
- **Ties (good):** 21
- **Qwen empty rate:** 3.3% (1/30 substantive articles)
- **Qwen error rate:** 0%
- **Cost:** $0 (unlimited tokens via api.nan.builders)

See [VERDICT-FINAL.md](packages/api/research/ab/qwen36-citizen-summaries/VERDICT-FINAL.md) for full results.

## Task

Write and run `packages/api/src/scripts/backfill-citizen-summaries.ts` that:

1. Queries the DB for articles without citizen summaries (status='vigente', precepto, 200-2000 chars)
2. Processes them in batches of 5 concurrent (Qwen rate limit)
3. Uses the iteration 7 prompt (few-shot examples)
4. Retries on empty/error
5. Checkpoints every 100 articles
6. Logs failures to failures.jsonl
7. Writes results to citizen_article_summaries table

## Prompt to Use

Use the exact SYSTEM_PROMPT from `packages/api/research/ab/qwen36-citizen-summaries/run-iter-7.ts` (the few-shot version). Do NOT use the production prompt from `packages/api/src/services/citizen-summary.ts`.

## Parameters

- **Concurrency:** 5 (Qwen rate limit: max 5 concurrent, max 100 queries/minute)
- **Batch size:** 100 articles per checkpoint
- **Retry on empty:** 1x with stronger directive if article > 200 chars
- **Retry on error:** 2x max (524 → 2s wait, 429 → 65s wait)
- **Timeout:** 180s per article
- **Checkpoint interval:** Every 100 articles
- **Failure log:** failures.jsonl with article_id, error, response

## Estimated Runtime

- **Articles:** ~433K (436K total - 3K already have summaries)
- **Time:** ~433K × 30s / 5 concurrent = ~77 hours ≈ 3.2 days
- **Cost:** $0

## Safety

- Read-only DB access for sampling
- Checkpoint/restart capability (critical for a 3-day job)
- Failure logging for manual review
- Dry-run mode (--limit 100) for testing
- No production API changes

## Related

- Experiment repo: `packages/api/research/ab/qwen36-citizen-summaries/`
- Winning prompt: `run-iter-7.ts`
- Backfill outline in: `VERDICT-FINAL.md`
