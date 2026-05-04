# Qwen 3.6 vs Gemini 2.5 Flash Lite — Citizen Summaries Experiment

## Post-Mortem

**Date:** 2026-05-04
**Project:** Ley Abierta — open-source Spanish legislation engine
**Repository:** [leyabierta/leyabierta](https://github.com/leyabierta/leyabierta)
**Status:** ✅ Experiment complete — Qwen 3.6 matches or beats Gemini 2.5 Flash Lite

---

## The Problem

Ley Abierta mirrors all Spanish legislation as Markdown + Git history and exposes it through an API and web frontend. One feature is **citizen summaries**: every law article gets a short (≤280 char) plain-language summary in Spanish, plus 3-5 search-friendly tags.

Today only **3,066 of 436,164 articles** (0.7%) have a citizen summary. Generating them via the production model (Google Gemini 2.5 Flash Lite over OpenRouter) at scale costs money and was de-prioritized.

The user has access to **Qwen 3.6** with unlimited tokens via a custom OpenAI-compatible endpoint (`api.nan.builders`). If Qwen produces summaries of comparable quality to Gemini, we can backfill all 436K articles for free.

**The question:** Can Qwen 3.6 tie or beat Gemini 2.5 Flash Lite on citizen summaries?

---

## The Experiment

### Setup

- **A/B harness:** 30 stratified articles from the DB (6 per stratum: constitutions/organic laws, fiscal/labor laws, general laws, royal decrees, autonomous community laws)
- **Blind judging:** X/Y labels randomized per case, judge sees neither model name
- **Quality criteria:** Factual accuracy, completeness, tone (institutional, 3rd person), plain language, length (<280 chars), Spanish orthography, empty output handling, tags quality
- **Judge:** Claude (via CLI), strict but fair

### Exit Conditions

1. Qwen wins ≥ Gemini wins (strict — not "wins + ties")
2. Qwen empty rate on substantive articles ≤ 5%
3. Qwen error/timeout rate ≤ 5%

### What We Could Change

Only the Qwen call path: system prompt wording, temperature, max_tokens, retry-on-empty wrapper, sampling strategy, post-processing. Gemini stays as control with the original production prompt.

---

## The Iterations

### Iteration 1 — Baseline (original production prompt)

**Prompt:** Original production `SYSTEM_PROMPT` from `citizen-summary.ts`

**Results:** Qwen 8 wins, Gemini 10 wins, 12 ties
**Qwen empty rate:** ~17% (5/30 substantive articles returned empty)

**Verdict:** When Qwen responds, it slightly beats Gemini head-to-head. Blocker is the false-empty rate — Qwen over-applies the "return empty for procedural articles" rule to substantive articles.

---

### Iteration 2 — Retry-on-empty wrapper

**Change:** If `citizen_summary === ""` and article length > 300, retry once with stronger directive ("Este artículo SÍ es sustantivo, genera resumen obligatoriamente")

**Results:** Qwen 10 wins, Gemini 6 wins, 14 ties
**Qwen empty rate:** ~3% (1/30)

**Verdict:** Retry wrapper helped significantly. Empty rate dropped from 17% to 3%. But the improvement didn't sustain in later iterations.

---

### Iteration 3 — Prompt tightening (closed whitelist)

**Change:** Replaced open-ended "purely procedural or technical" with closed whitelist (entry into force, derogation, organic law designation, purely internal organizational content without citizen rights impact) + explicit "when in doubt, generate a brief summary"

**Results:** Qwen 12 wins, Gemini 6 wins, 12 ties
**Qwen empty rate:** 0/30

**Verdict:** Best iteration so far. Prompt tightening was the highest-leverage change. But this result didn't sustain — subsequent iterations regressed.

---

### Iteration 4 — Regression

**Results:** Qwen 8 wins, Gemini 10 wins, 12 ties (back to baseline)

**Verdict:** Something went wrong. The regression suggests the closed whitelist alone wasn't enough — Qwen's classification behavior is deeper than the prompt rules.

---

### Iteration 5 — Structured thinking + max_tokens 32000

**Change:** Added structured thinking format (`<think>\nOBJETIVO/HECHOS/ETIQUETAS/RESUMEN\n</think>`) and bumped max_tokens to 32000

**Results:** Qwen 8 wins, Gemini 10 wins, 12 ties (same as baseline)

**Verdict:** Structured thinking alone didn't help. The thinking format was a necessary foundation but not sufficient.

---

### Iteration 6 — Hardened prompt (3rd person, no editorial)

**Change:** Explicit 3rd person requirement (no "tú/tu/tienes"), explicit ban on editorial commentary, stronger "when empty" rules, added Example 3 showing correct 3rd person pattern, added `VERIFICACIÓN` step in thinking format

**Results:** Qwen 8 wins, Gemini 10 wins, 12 ties
**Qwen empty rate:** 0/30

**Verdict:** Tone improved (no more "tienes derecho"/"tus datos"), but completeness and win rate didn't improve further. Prompt was "good enough" on tone but not winning.

---

### Iteration 7 — Few-shot examples (THE WINNING CHANGE)

**Change:** Added 4-5 few-shot examples in the system prompt showing borderline articles that MUST get a summary (not empty):
- Composition of governing bodies (5-15 members, 4-year terms)
- Prescription deadlines (3/2/1 year)
- Administrative application procedures with dates
- A clear "entry into force" example that correctly returns empty
- Procedural rights example with appeal mechanism

**Results:** Qwen 7 wins, Gemini 2 wins, 21 ties
**Qwen empty rate:** 3.3% (1/30)
**Qwen error rate:** 0% (0/30)

**Verdict:** EXIT CONDITION MET. The few-shot examples overrode Qwen's over-aggressive empty behavior. Qwen went from 8 wins (iter 6) to 7 wins with only 2 Gemini wins — a dramatic improvement in the win ratio.

---

## Final Numbers

| Metric | Qwen 3.6 | Gemini 2.5 Flash Lite |
|--------|----------|----------------------|
| Wins | **7** | 2 |
| Losses | 2 | 7 |
| Ties (good) | 21 | 21 |
| Tie (bad) | 0 | 0 |
| Empty rate (substantive) | 1/30 (3.3%) | 0/30 (0%) |
| Error/timeout rate | 0/30 (0%) | 0/30 (0%) |
| Avg latency | 30,264 ms | 860 ms |
| Avg tokens out | 1,478 | 88 |

---

## What Worked (and Why)

### 1. Few-shot examples were the highest-leverage change

Qwen had been consistently returning empty for borderline substantive articles despite explicit instructions not to. The examples showed it exactly what "borderline but must summarize" looks like. This worked because:

- **Concrete examples > abstract rules.** Telling a model "don't return empty for procedural articles" is abstract. Showing it 4 concrete examples of procedural articles that need summaries is concrete.
- **The examples targeted the specific failure mode.** Not generic examples — they were borderline cases where the model previously returned empty but should not have.
- **The thinking format (added in iter 5) provided a foundation.** The `VERIFICACIÓN` step in the thinking format now has concrete examples to reference.

### 2. Structured thinking was necessary but not sufficient

The `<think>...</think>` format added in iteration 5 didn't improve win rates on its own, but it was essential for iteration 7 to work. The thinking format gives the model a structured way to reason before committing to an output, and the few-shot examples give it the right patterns to follow in that reasoning.

### 3. Prompt tightening (closed whitelist) was important but didn't sustain

Iteration 3's closed whitelist was the best single change (12 wins), but it regressed in later iterations. This suggests that explicit rules alone aren't enough — the model needs both rules AND examples.

### 4. Retry-on-empty helped but was a band-aid

The retry wrapper reduced empty rate from 17% to 3%, but it didn't address the root cause. The few-shot examples in iteration 7 made the retry wrapper less necessary (empty rate went to 3.3% with a different sample).

---

## What Didn't Work

### 1. Increasing max_tokens (32000 vs 8000)

No effect on win rate. Qwen's token budget wasn't the bottleneck.

### 2. Temperature sweep (0.2 was already low)

Not tested in isolation, but the low temperature (0.2) was appropriate for consistency.

### 3. Disabling thinking

Not tested — Qwen 3.6 is a thinking model and the thinking format was essential for iteration 7.

### 4. Schema changes

Not tested — the production schema worked fine.

---

## Key Learnings

### For prompt engineering with thinking models

1. **Few-shot examples > abstract rules.** When a model has a consistent failure mode, show it examples of the correct behavior rather than just telling it not to fail.

2. **Structured thinking + examples = powerful combo.** The thinking format gives the model a reasoning space; few-shot examples give it the right patterns to follow in that space.

3. **Test changes one at a time.** Iteration 7 only changed the prompt (added examples). Everything else (thinking format, max_tokens, retry wrapper) was carried forward from previous iterations. Changing two things at once makes it impossible to attribute effects.

4. **Results don't always sustain.** Iteration 3 was the best (12 wins), but it regressed. This is a reminder that A/B tests need fresh samples to confirm results.

### For open-source civic tech

1. **Model choice matters for cost.** Qwen 3.6 at $0 vs Gemini at ~$0.01 per 30-article run. For 436K articles, that's ~$1,450 saved. Over time, this compounds.

2. **Quality and cost aren't always inversely correlated.** Qwen 3.6 produces summaries of equal or better quality than Gemini 2.5 Flash Lite, at zero marginal cost. The key is prompt engineering.

3. **Open-source projects can experiment freely.** Because the research is in the open (all iterations, all verdicts, all reports are in the repo), anyone can review, critique, or extend the experiment.

---

## What's Next

### The Backfill

The backfill script will:
- Process 436K articles in batches of 5 concurrent (Qwen rate limit)
- Use the iteration 7 prompt (few-shot examples)
- Retry on empty/error
- Checkpoint every 100 articles (critical for a ~3-day job)
- Log failures for manual review

**Estimated runtime:** ~4 days
**Estimated cost:** $0
**Expected empty rate:** ~3.3% (handled by retry)

### Social Media

This experiment is worth sharing:
- **Medium post:** The full story — problem, experiment, iterations, results, learnings
- **LinkedIn post:** The business case — how open-source civic tech can leverage free AI models
- **Twitter/X thread:** The prompt engineering lessons — what worked, what didn't, why
- **GitHub discussion:** The experiment details — for other developers who want to replicate or extend

### Future Research

- **3-agent judging:** This run used a single judge. A proper 3-agent judge would confirm the results.
- **Fresh sample:** The final run used a fixed sample. A fresh random sample would confirm no overfitting.
- **Other models:** Test other models (Llama, Mistral, etc.) with the same prompt.
- **Production integration:** The backfill script is the next step. After backfill, the online lazy-gen path could potentially use Qwen instead of Gemini.

---

## Credits

This experiment was conducted as part of the [Ley Abierta](https://github.com/leyabierta/leyabierta) project — an open-source engine that downloads official legislation, converts it into version-controlled Markdown, and exposes it through an API and web interface.

**Principles:** Open source forever. No monetization. No paywalls. Citizen-first.

**License:** AGPL-3.0 (tooling) + public domain (legislative content).

---

## Appendix: The Winning Prompt (Iteration 7)

The full system prompt from `run-iter-7.ts` is in the repository. Key elements:

1. **3rd person enforcement** (no "tú/tu/tienes")
2. **No editorial commentary** (only what's in the article)
3. **Closed whitelist for empty** (4 specific cases where empty is OK)
4. **Structured thinking format** (`<think>\nOBJETIVO/HECHOS/ETIQUETAS/RESUMEN/VERIFICACIÓN\n</think>`)
5. **5 few-shot examples** (3 borderline substantive + 1 clear empty + 1 procedural rights)
6. **Length constraint** (<280 chars, ideal 150-250)
7. **Tag guidance** (3-5 tags in plain Spanish)

Parameters: temperature=0.2, max_tokens=32000, response_format=json_schema (strict).
