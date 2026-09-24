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

## Decision (2026-09-23, superseded)

The cron used `REFORM_SUMMARIES_MODEL`, default `qwen/qwen3.8-27b` with
reasoning off. Other generated content keeps `CONTENT_LLM_MODEL`.

## Follow-up (2026-09-24): gpt-6-luna with style rules

The maintainer liked Qwen's style (short, plain, impersonal) but the judge
found gpt-6-luna more faithful. So style rules modelled on Qwen's output were
appended to the prompt (`REFORM_STYLE_RULES` in `reform-summary-prompt.ts`):
short active sentences with a clear subject, 8–13 word headline, 2–3 sentence
summary of 200–320 characters, no semicolons, quotes, parentheses or lists,
article numbers only when needed, never talk about the input material, no
"ciudadanía"/"tú"/"usted", and no value judgements the text does not support
("agiliza", "mejora", "moderniza", "refuerza"). A second variant with four
Qwen examples as few-shot added nothing and was dropped.

Same judge and rubric as above, plus a separate 0–2 **style** criterion;
candidate `openai/gpt-6-luna` (reasoning `minimal`) with the style rules,
reference Qwen3.8-27B.

| Set | Total /10 | Fidelity | Style | Preferred cand./ref./tie | Fidelity 0 cand. vs ref. |
|---|---|---|---|---|---|
| Development (the 40 above, used to write the rules) | 8.72 vs 7.90 | 1.75 vs 1.25 | 1.80 vs 1.75 | 26 / 13 / 1 | 0 vs 5 |
| Held-out (40 new reforms, never used for tuning, full material) | 8.70 vs 8.18 | 1.68 vs 1.38 | 1.82 vs 1.77 | 23 / 15 / 2 | 1 vs 1 |
| Held-out, prompt as integrated in production (rerun 2026-09-24) | 9.03 vs 8.00 | 1.70 vs 1.30 | 1.90 vs 1.75 | 27 / 10 / 3 | 0 vs 5 |

The last row regenerates the held-out set with the production
`REFORM_SYSTEM_PROMPT` (`PROMPT_VERSION` 2026-09-25.1) and the cron's model
settings; the differences with the row above are generation and judge noise.
On the held-out outputs the summary averages about 285 characters (Qwen about
315), with no talk about "el texto facilitado".

**Decision (2026-09-24):** the cron uses `openai/gpt-6-luna` with reasoning
`minimal` and the style rules; published Qwen summaries are to be regenerated
with the same prompt.

## Limits

40 reforms per set, one LLM judge, no human adjudication yet. Rejudging the same outputs
changes the fidelity score in about a third of the cases, so read the Qwen vs
Qwen row as a tie.
