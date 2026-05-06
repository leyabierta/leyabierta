# Verdict — Qwen 3.6 vs Gemini 2.5 Flash Lite (citizen summaries)

**Run:** `run-2026-05-04T17-12-49` — 30 articles, stratified across 5 categories.
**Judges:** 3× Sonnet 4.6, blind, independent (no inter-judge communication).
**Inter-judge agreement:** very high — 2/30 cases had a 2-1 split, all others 3-0.

## Headline numbers

| Outcome | Count | % |
|---------|-------|---|
| **Qwen wins** | 8 | 27% |
| **Gemini wins** | 10 | 33% |
| **Tie (both valid)** | 12 | 40% |

If Qwen ≥ Gemini counts as "acceptable for backfill", that's **20/30 = 67%**.

## What's actually going on — Gemini's 10 wins decompose

| Reason Gemini won | Cases | Count |
|---|---|---|
| **Qwen returned empty for substantive article** | 17, 21, 26, 28, 29 | 5 |
| **Qwen timed out** (fetch_error after 120s) | 25 | 1 |
| Qwen genuinely produced an inferior summary | 7, 14, 15, 30 | 4 |

So **6 of Gemini's 10 wins are Qwen failures, not quality losses.** Only 4 are real head-to-head defeats.

## And Gemini's failures — Qwen's 8 wins decompose

| Reason Qwen won | Cases | Count |
|---|---|---|
| **Gemini returned empty for substantive article** | 2, 27 | 2 |
| **Gemini factual error** (Case 1: inverted who has rectification right; Case 13: "altos cargos cesados" instead of "en activo") | 1, 13 | 2 |
| Qwen produced a more complete or accurate summary | 8, 9, 11, 22 | 4 |

## Head-to-head when both produce output (excluding Qwen empty/timeout failures)

| Outcome | Count | % of 24 |
|---|---|---|
| Qwen wins | 8 | 33% |
| Gemini wins | 4 | 17% |
| Tie | 12 | 50% |

**When Qwen actually responds, it's slightly better than Gemini.** That's the surprising finding.

## The blocker: Qwen's "false empty" rate

Qwen returned empty (citizen_summary = "") for 5 out of 30 substantive articles — a **17% false-negative rate** that would translate, at backfill scale (436K articles), to ~74K articles where the citizen sees nothing.

The system prompt allows empty output for "puramente procedimental o técnico" articles. Qwen interprets this too broadly. Examples:

- **Case 17**: extinción y liquidación de un organismo autónomo — substantive procedural rules → Qwen empty
- **Case 21**: reglas de votación en una asamblea colegial — substantive → Qwen empty
- **Case 26**: actos de la asamblea constituyente de un colegio profesional — substantive → Qwen empty
- **Case 28**: contenido obligatorio de declaración BIC — substantive → Qwen empty
- **Case 29**: obligación de evaluación ambiental estratégica — substantive → Qwen empty

Gemini hits the same trap on 2/30 cases (cases 2 and 27), so it's not a Qwen-only problem — but Qwen's rate is 2.5× higher.

## Latency

| Provider | Avg | Max |
|----------|-----|-----|
| Gemini | 2,3s | ~6s |
| Qwen | **36s** | 120s (timeout) |

Qwen is ~15× slower because it's a thinking/reasoning model (~1445 tokens per call vs Gemini's 94).

**For online lazy-gen (`citizen-summary.ts` getOrGenerate path): unacceptable.** A user clicking on an article and waiting 36s for the summary breaks UX.
**For offline backfill: tolerable.** 100 q/min × 5 concurrent = ~10 q/s amortized → ~12h for 436K articles. Slow but free.

## Disagreement cases (for the record)

- **Case 14** (2-1 split): Gemini's summary mentions "personas jurídicas con objeto agrario exclusivo", which is a phrase from an article truncated mid-sentence. J1/J3 read it as "more complete"; J2 read it as "hallucinated from incomplete source". Genuinely ambiguous. Doesn't change the aggregate.

## Recommendation

**Qwen 3.6 is quality-competitive but has reliability gaps that block direct adoption for backfill.** Three concrete mitigations before going to scale:

1. **Prompt fix** — tighten the "return empty" guidance. The current trigger is "puramente procedimental o técnico". Qwen treats too many things as procedural. Replace with a positive-defined whitelist of what counts as procedural (e.g. "solo si el artículo declara entrada en vigor, deroga otra norma, asigna rango de ley orgánica, o es puramente organizativo interno"). Also add a fallback: "en caso de duda, genera un resumen".
2. **Validation + retry** — wrap the call: if `citizen_summary === ""` and `article_length > 300 chars`, retry once with a stronger system prompt forcing output. Cheap (free) given unlimited tokens.
3. **Timeout tuning** — bump signal timeout from 120s to 180s, but accept that ~3% of calls will fail and need retry.

**Suggested next step:** rerun the same 30-case A/B with the prompt fix applied (Qwen only — Gemini stays as control with the original prompt), and verify the empty-rate drops below 5%. If it does, green-light a 500-article pilot batch on konar to confirm at scale before doing the full backfill.

**Do NOT** swap the production `citizen-summary.ts` (online path) to Qwen — 36s latency is a non-starter. The integration target is a new offline `backfill-citizen-summaries.ts` script that is conceptually a sibling of `generate-reform-summaries.ts`, not a replacement of the online service.
