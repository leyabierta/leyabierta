# Goal: get Qwen 3.6 to tie or beat Gemini 2.5 Flash Lite on citizen summaries

## Context

You are working in the `leyabierta` repository. Ley Abierta is an open-source civic project that mirrors all Spanish legislation as Markdown + Git history and exposes it through an API and web frontend so any citizen can search, compare versions, and understand how laws change. Read `CLAUDE.md` at the repo root for full project conventions.

One feature is **citizen summaries**: every law article gets a short (≤280 char) plain-language summary in Spanish, plus 3-5 search-friendly tags. Today only 3,066 of 436,164 articles (0.7%) have one, because generating them via the production model (Google Gemini 2.5 Flash Lite over OpenRouter) at scale costs money and was de-prioritised.

The user has access to **Qwen 3.6** with unlimited tokens via a custom OpenAI-compatible endpoint (5 concurrent / 100 queries per minute). If Qwen produces summaries of comparable quality to Gemini, we can backfill all 436K articles for free. The integration target is a new **offline backfill script**, not the production online lazy-gen path.

## Qwen endpoint details

- **Base URL:** `https://api.nan.builders/v1`
- **Model:** `qwen3.6` (thinking model — produces reasoning traces before output)
- **API Key:** hardcoded as fallback in `run.ts`: `sk-1WqPsfFrl3YHyBg52xRvTg`
- **Rate limit:** max 5 concurrent, max 100 queries per minute
- **Error handling:** 524 (gateway timeout) → retry after 2s; 429 (rate limit) → wait 65s
- **max_tokens:** 32000 (thinking model needs room for reasoning + output)
- **temperature:** 0.2 (low for consistency)

## Gemini endpoint details (control — DO NOT CHANGE)

- **Base URL:** `https://openrouter.ai/api/v1`
- **Model:** `google/gemini-2.5-flash-lite`
- **max_tokens:** 500
- **temperature:** 0.2

## Full iteration history

### Iteration 1 — Baseline (original production prompt)
- **Prompt:** Original production `SYSTEM_PROMPT` from `citizen-summary.ts`
- **Qwen wins:** 8 (27%) | **Gemini wins:** 10 (33%) | **Tie:** 12 (40%)
- **Qwen empty rate:** ~17% (5/30 substantive articles returned empty)
- **Qwen errors:** 1 timeout (120s)
- **Judge notes:** When Qwen responds, it slightly beats Gemini head-to-head. Blocker is false-empty rate.

### Iteration 2 — Retry-on-empty wrapper
- **Change:** Added retry wrapper — if `citizen_summary === ""` and article length > 300, retry once with stronger directive ("Este artículo SÍ es sustantivo, genera resumen obligatoriamente")
- **Qwen wins:** 10 (33%) | **Gemini wins:** 6 (20%) | **Tie:** 14 (47%)
- **Qwen empty rate:** ~3% (1/30) — big improvement
- **Qwen head-to-head wins:** 8 vs Gemini 4
- **Verdict:** Retry wrapper helped significantly. Empty rate dropped from 17% to 3%.

### Iteration 3 — Prompt tightening (closed whitelist for empty)
- **Change:** Replaced open-ended "puramente procedimental o técnico" with closed whitelist (entrada en vigor, derogación, asignación de rango, declaración de carácter de ley orgánica, contenido puramente organizativo interno sin efecto sobre derechos ciudadanos) + explicit "en caso de duda, genera un resumen breve"
- **Qwen wins:** 12 (40%) | **Gemini wins:** 6 (20%) | **Tie:** 12 (40%)
- **Qwen empty rate:** 0/30
- **Qwen head-to-head wins:** 10 vs Gemini 4
- **Verdict:** Best iteration so far. Prompt tightening was the highest-leverage change.

### Iteration 4 — Regression
- **Change:** ??? (check run folder for hypothesis)
- **Qwen wins:** 8 (27%) | **Gemini wins:** 10 (33%) | **Tie:** 12 (40%)
- **Verdict:** Regressed to baseline. Something went wrong. Check `run-2026-05-04T.../iteration-N-hypothesis.md` for what was changed.

### Iteration 5 — Structured thinking format + max_tokens 32000
- **Change:** Added structured thinking format (`<think>\nOBJETIVO/HECHOS/ETIQUETAS/RESUMEN\n</think>`) and bumped max_tokens to 32000
- **Qwen wins:** 8 (27%) | **Gemini wins:** 10 (33%) | **Tie:** 12 (40%)
- **Verdict:** Same as baseline. Structured thinking alone didn't help.

### Iteration 6 — Hardened system prompt (3rd person, no editorial)
- **Change:** Added explicit 3rd person requirement (no tú/tu/tienes), explicit ban on editorial commentary, stronger "when empty" rules, added Example 3 showing correct 3rd person pattern, added `VERIFICACIÓN` step in thinking format
- **Qwen wins:** 8 (27%) | **Gemini wins:** 10 (33%) | **Tie:** 12 (40%)
- **Qwen empty rate:** 0/30
- **Judge Claude notes:** Qwen fixed the 2nd person problem (no more "tienes derecho"/"tus datos"). But completeness issues persist (loses detail in cases 25, 29). Gemini still has occasional empty responses.
- **Verdict:** Tone improved, but completeness and empty-rate didn't improve further. Prompt is now "good enough" on tone but not winning.

### Summary of all iterations

| Iteration | Key Change | Qwen Wins | Gemini Wins | Tie | Empty Rate |
|-----------|-----------|-----------|-------------|-----|------------|
| 1 | Baseline (original prompt) | 8 | 10 | 12 | ~17% |
| 2 | Retry-on-empty wrapper | 10 | 6 | 14 | ~3% |
| 3 | Prompt tightening (closed whitelist) | 12 | 6 | 12 | 0% |
| 4 | ??? (regression) | 8 | 10 | 12 | ~17% |
| 5 | Structured thinking + max_tokens 32000 | 8 | 10 | 12 | 0% |
| 6 | Hardened prompt (3rd person, no editorial) | 8 | 10 | 12 | 0% |

**Best result:** Iteration 3 (12 wins, 6 Gemini wins, 0% empty). But never achieved Qwen wins ≥ Gemini wins consistently.

## What has been tried (and failed)

1. **Retry-on-empty wrapper** — helped in Iteration 2 but didn't sustain
2. **Closed whitelist for empty** — helped in Iteration 3 but didn't sustain
3. **Structured thinking format** — no effect (Iteration 5)
4. **max_tokens 32000** — no effect (Iteration 5)
5. **3rd person enforcement** — fixed tone but didn't improve win rate (Iteration 6)
6. **No editorial commentary rule** — fixed tone but didn't improve win rate (Iteration 6)
7. **Better examples** — added Example 3 in Iteration 6, no effect

## What has NOT been tried yet

1. **Few-shot examples in system prompt** — show 2-3 examples of substantive vs procedural inputs with expected outputs, especially targeting the empty-article failure mode
2. **Different temperature** — try 0.0 or 0.1 instead of 0.2
3. **Schema descriptions** — add descriptions to JSON schema fields that can change model behaviour
4. **Disable/limit thinking** — if the endpoint supports `reasoning_effort` or `enable_thinking` parameters, test with thinking disabled or limited (thinking models sometimes over-think and produce empty outputs)
5. **Post-processing validation** — if Qwen returns empty for an article > 200 chars, automatically retry with a completely different prompt that says "THIS IS A SUBSTANTIVE ARTICLE. YOU MUST GENERATE A SUMMARY."
6. **Two-pass generation** — first pass: classify as substantive/procedural. Second pass: only generate summary for substantive. This separates the classification task from the summarization task.
7. **Different sampling strata** — the current strata might favour Gemini's strengths. Try different article distributions.
8. **Chain-of-thought in user prompt** — instead of system prompt, add a thinking step in the user message
9. **Output format constraints** — instead of JSON schema, use a simpler format that the model handles better
10. **Temperature sweep** — try 0.0, 0.1, 0.2, 0.3 to find optimal

## Exit condition for this loop

Iterate until **all** of these are true on a fresh A/B run with 30 stratified samples:

1. **Qwen wins ≥ Gemini wins** (strict — not "wins + ties ≥ Gemini").
2. **Qwen empty-rate on substantive articles ≤ 5%** (≤ 1 case out of 30 where Qwen wrongly returned empty).
3. **Qwen error/timeout rate ≤ 5%** (≤ 1 case out of 30).

If you achieve this, write a final `VERDICT-FINAL.md` summarising what you changed, the final numbers, and a recommended `backfill-citizen-summaries.ts` script outline (don't write the backfill script — just the outline). Then stop.

**There is no iteration cap.** Iterations are free (Qwen is unlimited tokens; Gemini is ~$0.01 per run). Keep iterating until the exit condition is met. Stop early *only* if you reach a point where it is genuinely infeasible — i.e. you have systematically tried prompt tuning, retry wrappers, few-shot, schema descriptions, reasoning-budget tuning, structural variations, and post-processing, and the failure mode is intrinsic to the model. In that case, write `VERDICT-FINAL.md` documenting exhaustively what was tried, why each thing failed, and your honest recommendation.

"It's hard" is not infeasible. "I tried 20 prompt variants and the empty-rate is stuck at 17% regardless of how aggressively I tell it not to be empty" *is* infeasible. Bias toward continuing rather than declaring defeat.

## What you can change

You are tuning **only the Qwen call path**. Constraints:

- **Do NOT modify `packages/api/src/services/citizen-summary.ts` or any production code.** All experiments live under `packages/api/research/ab/qwen36-citizen-summaries/`.
- **Gemini side stays as control** with the original production prompt and schema. Do not retune Gemini — the goal is to find a Qwen configuration that matches or beats the production baseline, not to win by hobbling Gemini.
- For Qwen you may change: system prompt wording, schema (within reason), temperature, max_tokens, retry-on-empty wrapper logic, sampling strategy, post-processing.

## How to iterate — the loop

For each iteration:

1. **Decide what to change** based on the previous run's verdict. Write a one-paragraph hypothesis to `iteration-N-hypothesis.md` in the run folder.
2. **Modify only the Qwen path** in a copy of `run.ts` (duplicate as `run-iter-N.ts`). Keep Gemini identical.
3. **Run the harness.** Output goes to `run-<timestamp>/`. Cost: $0 for Qwen, ~$0.01 for Gemini.
4. **Judge.** Spawn 3 parallel Sonnet sub-agents with the same blind-judge prompt (see below). The exact prompt is preserved at the bottom of this file.
5. **Aggregate** the 3 verdicts into `verdict.md` for that run. Cross-reference `report-key.json` to de-anonymise X/Y → gemini/qwen. Compute the headline numbers.
6. **Check exit condition.** If met → write `VERDICT-FINAL.md` and stop. If not → next iteration with one more change. Do not change two things at once.

You may run multiple iterations in parallel only if they test orthogonal changes. Don't parallelise prompt variants — they need head-to-head comparison.

## Tools & conventions

- Runtime: **bun**. Type-check with `bunx tsgo --noEmit`. Lint/format with `bunx biome check --write`.
- Don't run the production API server, web server, or any cron. This is research only.
- The production DB is `data/leyabierta.db`. Read-only is fine; you're only sampling articles. Do not write to it from research scripts.
- Sub-agents: use the `Agent` tool with `subagent_type: general-purpose`, `model: sonnet`, `run_in_background: true`. Launch the 3 judges in a single message so they run in parallel. Wait for all 3 to complete before aggregating.
- **Do NOT run `git commit`, `git push`, `git merge`, or any destructive git operation.** All work stays as uncommitted changes for the user to review.
- Do not open pull requests, do not run `/ship`, `/land-and-deploy`, or any workflow that creates remote artifacts.

## Self-check before declaring success

Before writing `VERDICT-FINAL.md`:

- Re-read 5 random Qwen outputs from the final run yourself (not via judges). Confirm they actually look good — no factual errors, correct tone, accents intact. If any look bad, that's a signal the judges may have been lenient; rerun with a stricter judge prompt before declaring victory.
- Confirm the final-run sample was drawn fresh from the DB (not reused from a previous iteration), so you're not overfitting.

## Key files reference

- **Harness:** `packages/api/research/ab/qwen36-citizen-summaries/run-iter-6.ts` (latest)
- **Production prompt:** `packages/api/src/services/citizen-summary.ts` (DO NOT MODIFY)
- **Previous runs:** `packages/api/research/ab/qwen36-citizen-summaries/run-2026-05-04T*/`
- **Best run:** Iteration 3 (12 Qwen wins, 6 Gemini wins, 0% empty)
- **Latest run:** Iteration 6 (8 Qwen wins, 10 Gemini wins, 0% empty, tone fixed)

## Goal — exit condition for this loop

Iterate until **all** of these are true on a fresh A/B run with 30 stratified samples:

1. **Qwen wins ≥ Gemini wins** (strict — not "wins + ties ≥ Gemini").
2. **Qwen empty-rate on substantive articles ≤ 5%** (≤ 1 case out of 30 where Qwen wrongly returned empty).
3. **Qwen error/timeout rate ≤ 5%** (≤ 1 case out of 30).

If you achieve this, write a final `VERDICT-FINAL.md` summarising what you changed, the final numbers, and a recommended `backfill-citizen-summaries.ts` script outline (don't write the backfill script — just the outline). Then stop.

**There is no iteration cap.** Iterations are free (Qwen is unlimited tokens; Gemini is ~$0.01 per run). Keep iterating until the exit condition is met. Stop early *only* if you reach a point where it is genuinely infeasible — i.e. you have systematically tried prompt tuning, retry wrappers, few-shot, schema descriptions, reasoning-budget tuning, and structural variations, and the failure mode is intrinsic to the model (e.g. Qwen consistently makes the same factual errors no matter how the prompt is framed, or the endpoint has a hard ceiling we cannot work around). In that case, write `VERDICT-FINAL.md` documenting exhaustively what was tried, why each thing failed, and your honest recommendation.

"It's hard" is not infeasible. "I tried 20 prompt variants and the empty-rate is stuck at 17% regardless of how aggressively I tell it not to be empty" *is* infeasible. Bias toward continuing rather than declaring defeat.

## What you can change

You are tuning **only the Qwen call path**. Constraints:

- **Do NOT modify `packages/api/src/services/citizen-summary.ts` or any production code.** All experiments live under `packages/api/research/ab/qwen36-citizen-summaries/`.
- **Gemini side stays as control** with the original production prompt and schema. Do not retune Gemini — the goal is to find a Qwen configuration that matches or beats the production baseline, not to win by hobbling Gemini.
- For Qwen you may change: system prompt wording, schema (within reason), temperature, max_tokens, retry-on-empty wrapper logic, sampling strategy, post-processing.

Things that have plausible upside (try them, don't all at once — change one variable per iteration so you can attribute the effect):

1. **Tighten the "return empty" guidance.** The current rule "Si un artículo es puramente procedimental o técnico, devuelve citizen_tags vacío y citizen_summary vacío" is what Qwen over-applies. Replace with a closed whitelist (entrada en vigor, derogación, asignación de rango, declaración de carácter de ley orgánica, contenido puramente organizativo interno sin efecto sobre derechos ciudadanos) and add an explicit "en caso de duda, genera un resumen breve."
2. **Retry-on-empty wrapper.** If `citizen_summary === ""` and `article.length > 300`, retry once with a stronger directive ("Este artículo SÍ es sustantivo, genera resumen obligatoriamente").
3. **Few-shot examples in the system prompt.** Show 2-3 examples of substantive vs procedural inputs and the expected outputs.
4. **Reasoning budget.** Qwen 3.6 is a thinking model; bump `max_tokens` headroom (currently 8000) only if you see truncation in the failures.
5. **Try disabling/limiting thinking** if the endpoint exposes a way (look for `reasoning_effort`, `enable_thinking`, etc. in the chat completions params — test against the endpoint, not assumed).
6. **Better schema description.** The current schema has bare `type: string`; adding descriptions per field can change model behaviour.

Avoid:
- Retraining Gemini's prompt to be worse.
- Adding model-specific post-processing for Gemini.
- Changing the input sample distribution to favour Qwen's strengths.
- Caching results across iterations — every iteration runs a fresh sample of 30 from the DB so we don't overfit to a memorised sample. (You can optionally fix the sample with a deterministic seed for an iteration to A/B-compare two prompt variants on identical inputs, but for the final accept/reject run, sample fresh.)

## How to iterate — the loop

For each iteration:

1. **Decide what to change** based on the previous run's verdict (start with the prompt tightening — it's the highest-leverage change). Write a one-paragraph hypothesis to `iteration-N-hypothesis.md` in the run folder.
2. **Modify only the Qwen path** in a copy of `run.ts` (don't edit the original — duplicate it as `run-iter-N.ts` or accept a `--qwen-prompt` flag). Keep Gemini identical.
3. **Run the harness.** Output goes to `run-<timestamp>/`. Cost: $0 for Qwen, ~$0.01 for Gemini.
4. **Judge.** Spawn 3 parallel Sonnet sub-agents with the same blind-judge prompt as the first run. The exact prompt the first run used is preserved at the bottom of this file under "Judge prompt template" — copy it verbatim, only change the path to the new `report-blind.md`.
5. **Aggregate** the 3 verdicts into `verdict.md` for that run. Cross-reference `report-key.json` to de-anonymise X/Y → gemini/qwen. Compute the headline numbers.
6. **Check exit condition.** If met → write `VERDICT-FINAL.md` and stop. If not → next iteration with one more change. Do not change two things at once.

You may run multiple iterations in parallel only if they test orthogonal changes (e.g. iteration 3a tries prompt X, iteration 3b tries retry-wrapper Y). Don't parallelise prompt variants — they need head-to-head comparison.

No iteration cap. See "Goal — exit condition for this loop" above for when to stop.

## Tools & conventions

- Runtime: **bun**. Type-check with `bunx tsgo --noEmit`. Lint/format with `bunx biome check --write`.
- Don't run the production API server, web server, or any cron. This is research only.
- The production DB is `data/leyabierta.db`. Read-only is fine; you're only sampling articles. Do not write to it from research scripts.
- The Qwen endpoint requires no key besides the one already hardcoded as a fallback in `run.ts` (`sk-1WqPsfFrl3YHyBg52xRvTg`, base URL `https://api.nan.builders/v1`). Respect the rate limit: max 5 concurrent, max 100 queries per minute.
- Gemini calls go through OpenRouter; key is in the user's local `.env` as `OPENROUTER_API_KEY`.
- Sub-agents: use the `Agent` tool with `subagent_type: general-purpose`, `model: sonnet`, `run_in_background: true`. Launch the 3 judges in a single message so they run in parallel. Wait for all 3 to complete before aggregating.
- **Do NOT run `git commit`, `git push`, `git merge`, or any destructive git operation.** All work stays as uncommitted changes for the user to review. Do not amend existing commits. Do not push to `main` or any branch under any circumstance, even if a tool/skill suggests it. If a sub-agent or skill tries to commit/push, override it.
- Do not open pull requests, do not run `/ship`, `/land-and-deploy`, or any workflow that creates remote artifacts.

## Self-check before declaring success

Before writing `VERDICT-FINAL.md`:

- Re-read 5 random Qwen outputs from the final run yourself (not via judges). Confirm they actually look good — no factual errors, correct tone, accents intact. If any look bad, that's a signal the judges may have been lenient; rerun with a stricter judge prompt before declaring victory.
- Confirm the final-run sample was drawn fresh from the DB (not reused from a previous iteration), so you're not overfitting.

---

## Judge prompt template

Use this verbatim for each Sonnet sub-agent (replace `<RUN_PATH>` with the actual run folder path):

```
You are a blind A/B judge for citizen-facing legal summaries on a Spanish public legislation site (Ley Abierta).

Read the blind report at:
`<RUN_PATH>/report-blind.md`

For each of the 30 cases, you see the original article and two candidate summaries (Resumen X, Resumen Y). The X/Y assignment is randomized per case — you do NOT know which model produced which. DO NOT try to guess the model.

**Task:** Judge each case independently. For each, pick exactly one verdict and justify briefly.

**Verdict options:**
- `X` — X is clearly better
- `Y` — Y is clearly better
- `tie_good` — both summaries are valid; either would be acceptable on the live site
- `tie_bad` — both summaries fail (factually wrong, hallucinated content not in the article, breaks tone, contains AI slop, missing core meaning, etc.)

**Quality criteria** (apply consistently across all cases):
1. **Factual accuracy** — does the summary state things that are actually in the article? No hallucinated facts, no invented numbers/deadlines.
2. **Completeness** — captures the core meaning and the most actionable concrete details (deadlines, amounts, requirements).
3. **Tone** — institutional and serious, not blog-y or coloquial. "Tienes derecho a..." OK; "Puedes..." too informal. No marketing fluff.
4. **Plain language** — accessible to a non-lawyer; minimal legalese.
5. **Length** — under 280 chars (count manually if borderline).
6. **Spanish orthography** — correct accents (á, é, í, ó, ú, ñ, ü, ¿, ¡). Wrong accents = fail.
7. **Empty output handling** — the prompt allows the model to return empty for "purely procedural/technical" articles. An empty output IS valid for things like "this article enters into force on date X" or "X has rank of organic law" — but NOT for substantive articles. If one side is empty for a substantive article, it loses.
8. **Tags** — 3-5 tags, in plain Spanish a citizen would search for, not legal jargon.

**Output format:** One JSON object per case, one per line (JSONL), to stdout. Schema:

{"case_id": 1, "verdict": "X|Y|tie_good|tie_bad", "reason": "one short sentence", "x_issues": ["..."], "y_issues": ["..."]}

`x_issues` and `y_issues`: list specific problems you spotted (factual error, AI slop phrase, missing accent, wrong tone, hallucinated detail, empty when shouldn't be, etc.). Empty list `[]` if none.

**Be strict but fair.** A "tie_good" should mean both genuinely work, not "both have minor issues but I'll pass them." If a summary has even one factual error or hallucination, it loses regardless of tone.

Return all 30 JSONL lines, nothing else. No prose around them.
```
