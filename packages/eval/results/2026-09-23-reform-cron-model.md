# Reform summaries: which model for the daily cron (2026-09-23)

Follow-up to `2026-09-23-reform-prompt-diff.md`. The new prompt was evaluated
with Qwen3.8-27B (AWQ INT4, vLLM, rented GPU), the model of the offline
backfill. The daily cron still generated reform summaries with
`google/gemini-2.5-flash-lite`, whose output with the new prompt had never been
judged.

## Method

- **Sample:** the same 40 reforms as the prompt evaluation (14 flagged as
  omnibus by the old rule, 14 whose first 500 characters were identical, 12
  random), with the final prompt.
- **Candidates:**
  - `google/gemini-2.5-flash-lite` (OpenRouter), called like the cron does;
  - `qwen/qwen3.8-27b` (OpenRouter, Zero Data Retention endpoints), reasoning
    off;
  - `openai/gpt-6-luna` (OpenRouter), reasoning `minimal`.
- **Reference:** the Qwen3.8-27B outputs from the rented GPU.
- **Judge:** Claude Sonnet via the CLI, blind, A/B order randomized, full or
  change-centred material, same rubric (fidelity, change captured, language,
  orthography, format, 0–2 each). Each candidate is judged in its own pair
  against the reference, so the reference's score moves between runs.

## Results

| Candidate vs Qwen (GPU) | Total /10 | Fidelity | Preferred cand./ref./tie | Fidelity 0 cand. vs ref. |
|---|---|---|---|---|
| gemini-2.5-flash-lite | 7.90 vs 8.68 | 1.12 vs 1.30 | 10 / 29 / 1 | 5 vs 2 |
| qwen/qwen3.8-27b (OpenRouter) | 8.72 vs 8.70 | 1.27 vs 1.38 | 22 / 17 / 1 | 2 vs 3 |
| gpt-6-luna | 9.03 vs 8.30 | 1.70 vs 1.20 | 31 / 6 / 3 | 2 vs 2 |

- flash-lite is clearly worse. One of its serious errors inverts the change
  (a new ban on circuses with wild animals read as an exemption).
- Qwen on OpenRouter matches the GPU Qwen: the same model, served by other
  providers.
- The judge preferred gpt-6-luna. The maintainer, reviewing the same pairs,
  preferred Qwen, so the project keeps one model, Qwen3.8-27B, for the
  backfill and the cron.

## Decision

The cron uses `REFORM_SUMMARIES_MODEL`, default `qwen/qwen3.8-27b` with
reasoning off. Other generated content keeps `CONTENT_LLM_MODEL`.

## Limits

40 reforms, one LLM judge, one human opinion. Rejudging the same outputs
changes the fidelity score in about a third of the cases, so read the Qwen vs
Qwen row as a tie.
