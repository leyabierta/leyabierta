# Local model for citizen summaries: `qwen3.8:27b-mlx` on Ollama vs `gemini-2.5-flash-lite` — 2026-09-23

**Question.** Can a local model on a single Mac (Apple M4 Max, 48 GB) write the
missing generated content, with production quality and at no API cost? The
missing content is:

- "qué cambió" reform summaries: 34,468 reforms of in-force laws have no summary;
- per-article citizen summaries: 36,478 in-force articles (`precepto`) have none.

The model tested is `qwen3.8:27b-mlx` (27.8B dense, NVFP4, Ollama 0.34.2 MLX
engine). It was compared with `google/gemini-2.5-flash-lite` via OpenRouter, the
production `CONTENT_LLM_MODEL`.

**Short answer.**

1. **Quality: qwen is at least as good as flash-lite**, with the same prompts.
   - Reforms: judge 8.76 vs 8.43 out of 10; qwen preferred 25 times vs 16
     (p = 0.21); fidelity tied (1.45 vs 1.40 out of 2).
   - Articles: 9.10 vs 8.40; qwen preferred 19 times vs 10 (p = 0.14).
   - Format: 100% valid JSON on the first attempt, with no reasoning text, no
     English and no missing accents.
   - None of the differences is statistically significant at this sample size.
2. **Neither model is safe enough on reforms, because of the input.** In both,
   about 12% of summaries have a serious fidelity error, and half of all
   summaries have some unsupported detail. The main cause is not the model:
   - The prompt shows each modified article as its first 500 characters
     "antes" and "ahora". In this sample, **51% of the modified fragments shown
     are identical after truncation**, and in 9 of 39 reforms *every* fragment
     shown is identical.
   - With no visible change, both models guess.
   - Separately, any norm with ≥ 15 materias is labelled an "omnibus law" in
     the prompt, so the Código Penal, the LOREG or the LAU get "forma parte de
     una ley ómnibus" in their summaries.
   - Both issues are in production today.
3. **Throughput: one stream only, about 5–7 days of continuous Mac time for
   both backlogs.**
   - A reform summary takes ~7.5–13 s; an article, ~4–8 s in batches of 5.
   - Parallel requests do not help on the MLX engine (`OLLAMA_NUM_PARALLEL` 1
     or 4 give the same aggregate throughput).
   - For reference, the same backlog on OpenRouter flash-lite would take about
     an hour.

Scripts and raw outputs were kept locally (scratch, not committed). The code
change that makes a local backend possible is the opt-in
`CONTENT_LLM_BASE_URL` (see [Code](#code)).

## Method

- **Inputs from production, read-only.** One `bun` script inside the API
  container opened the production SQLite read-only. It extracted, for the
  sampled reforms, the `norms`, `materias`, `reforms`, `reform_blocks`,
  `blocks` and `versions` rows the generator reads, plus the existing summaries.
  They were loaded into a local sample DB.
- **Exact production prompts.**
  - Reforms: `buildPrompt`, `queryBlockDiffs`, `SUMMARY_SCHEMA` and
    `validateReformSummary`, called through `callOpenRouter`, as in
    `generate-reform-summaries.ts`.
  - Articles: the backfill prompt v10, `BATCH_SCHEMA`, batches of 5 (articles
    over 5,000 characters go alone) and the production parser, as in
    `backfill-citizen-summaries.ts`.
  - These were moved into importable modules for this study (see [Code](#code)).
  - Temperature 0.2, as in production.
- **Qwen reasoning off.** Requests were sent to Ollama's OpenAI-compatible
  endpoint with `reasoning_effort: "none"`.
  - Without it, qwen3.8 reasons first: 54 s instead of 0.6 s on a smoke test.
  - Its JSON-schema output also came back malformed
    (`resumen":{"summary":…`).
  - `think: false` is ignored on `/v1`; it only works on the native `/api/chat`.
  - Constrained decoding is done by xgrammar in the MLX runner.
- **Sample.**
  - **42 reforms**:
    - 20 already have a production flash-lite summary. They cover IRPF,
      Impuesto sobre Sociedades, autónomos, LGSS, Código Penal, Constitución,
      TRLHL, Valencian and Murcian housing, the Catalan Civil Code, a
      Valencian omnibus law (82 materias), LOREG, Extremadura, a Valencian fees
      law (42 blocks), the Basque civil service, one new resolution and one
      correction;
    - 22 have no summary, from popular laws: Estatuto de los Trabajadores
      (×3), LAU (×2), LIRPF (×2), LGT (×2), Código Civil (×3, including the
      2021 disability reform with 206 blocks), LGSS, LIVA, Ley de Vivienda (the
      2024 reform and the original 2023 publication), Propiedad Horizontal,
      Código Penal, consumer protection (TRLGDCU), the art. 49 reform of the
      Constitución, LEC (143 blocks) and one random autonomic reform. Fresh
      flash-lite summaries were generated for these as the baseline.
  - **30 articles**:
    - 15 with an existing production summary: 10 from the same popular laws
      and 5 random autonomic ones;
    - 12 random in-force articles with no summary and ≥ 200 characters;
    - 3 with no summary and 50–199 characters.

    Both models generated all 30.
- **Judge.** The local Claude CLI (`claude -p --model sonnet`), a different
  model family from both candidates, as in `2026-09-23-model-zdr.md`.
  - It sees exactly the input the generator saw, and the candidates under
    shuffled labels, never model names.
  - Each candidate gets 0–2 on fidelity (most important; the judge is told to
    check figures, dates and deadlines), change captured (articles: coverage),
    plain language, orthography and format.
  - The judge then gives a preferred candidate and lists concrete fidelity
    errors. The prompts are at the end.
- **Automated checks** on every output:
  - JSON parsed on the first attempt, and whether a retry was needed;
  - `<think>` or reasoning text;
  - English words;
  - words that should carry an accent (`-cion`, `articulo`, `codigo`, …);
  - headline ≤ 15 words, summary ≤ 4 sentences;
  - article length 80–300 characters, 3–5 tags, second person.

## Results: reform summaries ("qué cambió")

n = 42 reforms, qwen vs flash-lite. The flash-lite side is the production
summary for 20 reforms and a fresh summary for 22. Scores are out of 2, total
out of 10.

| Model | Judge /10 | Fidelity | Change captured | Language | Orthography | Format | Fidelity 0 (serious) | With any error |
|---|---|---|---|---|---|---|---|---|
| `qwen3.8:27b-mlx` (local) | **8.76** | 1.45 | **1.52** | 2.00 | 2.00 | 1.79 | 5 | 20 |
| `gemini-2.5-flash-lite` | 8.43 | 1.40 | 1.19 | 2.00 | 2.00 | 1.83 | 6 | 19 |

**Pairwise results (sign test):**

| Comparison | Wins / losses / ties | p |
|---|---|---|
| Judge preference, qwen vs flash-lite | 25 / 16 / 1 | 0.21 |
| Fidelity | 15 / 13 | 0.85 |
| Total score | 20 / 15 | 0.50 |

**By subset:**

| Subset | Judge (qwen vs flash-lite) | Preferred (qwen / flash-lite) |
|---|---|---|
| vs production summary (n = 20) | 8.60 vs 8.40 | 11 / 9 |
| no summary yet (n = 22) | 8.91 vs 8.45 | 14 / 7 |

**Automated checks:**

| Check | qwen (42) | flash-lite fresh (22) | flash-lite production (20) |
|---|---|---|---|
| Valid JSON, first attempt | 42/42 | 22/22 | 20/20 |
| Retries needed | 0 | 0 | — |
| Reasoning / `<think>` text | 0 | 0 | 0 |
| English, missing accents | 0 / 0 | 0 / 0 | 0 / 0 |
| Headline > 15 words | 2 | 0 | 0 |
| Prompt / output tokens (mean) | 1,495 / 114 | 1,760 / 110 | — |

**Serious fidelity errors (score 0).** The judge compares against the input
the model saw.

qwen:

- **R27** (IRPF, 2025-01-23) inverts a change. It says the energy-efficiency
  deduction "se elimina para 2024". In fact the deadline moves from 2025 to 2024,
  so 2024 works still qualify and 2025 ones do not. This is the most serious
  error in the sample.
- **R26** (IRPF, 2026-02-28) says the electric-vehicle deduction ends. That
  article only changed its quotation marks.
- **R17** (RTVE law) turns "(Sin efecto)" into "se elimina la compensación",
  with `reform_type: derogation`.
- **R20** (Extremadura) calls the change a mere correction and misses the
  modified article.
- **R11** (Valencian omnibus) invents a "turismo y empleo público" theme.

flash-lite (R01, R05 and R12 are production baselines; R24, R28 and R35 are fresh):

- **R05** says the omnibus law covers "108 temas"; the input says 54.
- **R12** says "66 temas"; the input says 33. Both baselines were generated
  months ago, possibly from a different materias count, so these two may be
  unfair to flash-lite.
- **R28** (LGT) invents "se amplían los plazos de inspección de 18 a 27
  meses" when the fragments shown are identical.
- **R24** (LAU) and **R35** (Ley de Vivienda) invent "clarifications" of
  articles whose visible text did not change.
- **R01** (IRPF) adds a motive (the La Palma eruption) that is not in the
  input.

Most "fidelity 1" notes for both models share one pattern: the "antes" and
"ahora" fragments shown are identical, and the model fills the gap. qwen
tends to be more concrete, which helps "change captured" (1.52 vs 1.19) and
also makes its occasional error more specific. flash-lite tends to write
generic "se actualizan/clarifican" sentences. Other traits:

- qwen marks more reforms `importance: high`;
- qwen sometimes adds world knowledge that happens to be true but is not in the
  input (R16: "afecta a jueces y fiscales", wrong; R25: "7 años si el
  arrendador es empresa", right but only partly visible).

## Results: article citizen summaries

n = 30 articles. "Existing" is the summary in production today (15 articles).
That column has no model tag; it was produced by the earlier Qwen 3.6/NaN
backfill with prompt v10.

| Model | n | Judge /10 | Fidelity | Coverage | Language | Orthography | Format | With any error | Mean length (chars) |
|---|---|---|---|---|---|---|---|---|---|
| `qwen3.8:27b-mlx` | 30 | **9.10** | **1.83** | **1.83** | 1.97 | 2.00 | 1.47 | 5 | 272 |
| `gemini-2.5-flash-lite` | 30 | 8.40 | 1.73 | 1.43 | 2.00 | 2.00 | 1.23 | 7 (1 serious) | 250 |
| existing production | 15 | 6.33 | 1.60 | 1.07 | 1.80 | 1.67 | 0.20 | 6 | 226 |

| Pairwise | Preferred (W/L) | p | Total score (W/L) | p |
|---|---|---|---|---|
| qwen vs flash-lite | 19 / 10 | 0.14 | 19 / 9 | 0.09 |
| qwen vs existing | 8 / 1 | 0.04 | 13 / 0 | < 0.001 |
| flash-lite vs existing | 6 / 1 | 0.13 | 11 / 2 | 0.02 |

**Automated checks:**

| Check | qwen | flash-lite |
|---|---|---|
| Valid JSON (strict) | 10/10 batches | 10/10 batches |
| Articles dropped from a batch | 0 | 0 |
| Reasoning text | 0 | 0 |
| Second person | 0 | 0 |
| English / missing accents | 0 / 0 | 0 / 0 |
| Tags outside 3–5 | 0 | 1 |
| Length outside 80–300 | 9/30 (max 508) | 7/30 (max 662) |

- **The main format issue is length.** Both models run long on long
  articles, against prompt v10's "hard maximum 300". A backfill should reject
  or retry summaries over ~320 characters rather than store them.
- **The one serious flash-lite error:** A21 attributes an annex to "la
  Ley 4/2026, de 2 de julio", a norm identifier that is not in the article.
  This is exactly what prompt v10 forbids.
- **qwen had no serious article errors.** Its notes are omissions or nuance,
  such as leaving out one of the constitutional titles cited.

**Side findings on the existing production article summaries** (not the
subject of this study, but they matter for any rewrite):

- **Corrupted text:** one of the 15 ends in a stray CJK character (`…suspensión,挪`).
- **Truncation:** another is cut mid-word at exactly 300 characters
  ("…inclusión interinist"). Production has 18,443 summaries of ≥ 300
  characters, so truncation may be widespread.
- **Missing tags:** none of the 15 has article tags. Production has tags for
  only 4,339 articles, against 337,089 article summaries.

The low "format" score of the existing summaries comes mostly from the missing
tags.

## Throughput on the Mac (M4 Max, 48 GB)

Measured on Ollama's native `/api/chat` with think off and JSON-schema
`format`. Each concurrency level used different prompts, so prefix caching
could not inflate the parallel runs. Only the system prompt is shared, as it
would be in a real backfill.

| Server | Job | Concurrency | s / item | Prompt tok | Output tok | Prefill tok/s | Decode tok/s (per stream) | Aggregate output tok/s |
|---|---|---|---|---|---|---|---|---|
| App (`NUM_PARALLEL=1`, 32k ctx) | reform | 1 | 10.6 | 1,211 | 116 | 217 | 23 | 11.0 |
| | reform | 2 | 11.2 | 1,400 | 113 | 203 | 27 | 10.1 |
| | reform | 4 | 15.1 | 1,897 | 118 | 186 | 24 | 7.8 |
| | 5-article batch | 1 | 40.2 | 3,674 | 717 | 206 | 32 | 17.8 |
| | 5-article batch | 4 | 33.9 | 3,674 | 757 | 285 | 36 | 22.3 |
| Test (`NUM_PARALLEL=4`, 8k ctx) | reform | 1 | **7.5** | 1,211 | 113 | 249 | 44 | 15.1 |
| | reform | 4 | 15.7 | 1,897 | 115 | 192 | 20 | 7.3 |
| | 5-article batch | 1 | 37.0 | 3,674 | 703 | 226 | 34 | 19.0 |
| | 5-article batch | 2 | 30.5 | 3,674 | 702 | 321 | 37 | 23.0 |

Reading the table:

- **Prefill dominates.** At ~200–250 tok/s, prefill takes ~5–6 s of a reform
  and ~15 s of a 5-article batch.
- **Parallelism does not scale.** Aggregate throughput is flat within ±20%
  between concurrency 1, 2 and 4, whatever `OLLAMA_NUM_PARALLEL` is.
- **A smaller context helps.** 8k instead of 32k made single-stream decode
  noticeably faster (7.5 vs 10.6 s per reform). Most prompts fit in 8k; long
  articles, up to ~110k tokens, would need a separate pass with a large
  context.
- **Memory.** The weights take 18 GB; with the model loaded Ollama reported
  31 GB resident, and system free memory fell to 18% during the 4-slot test.
  The Mac is unusable for other heavy work while this runs.
- **The generation run** (sequential, 32k ctx, sample weighted toward big
  codes) took 17.8 s per reform on average (p50 13.3 s, p95 38.9 s). Batches of
  5 articles took 13–57 s, plus one outlier of 113 s.

**Extrapolation (single stream, the Mac doing nothing else).**

| Backlog | Items | Assumption | Hours |
|---|---|---|---|
| Reform summaries | 34,468 (9,686 are original publications, "nueva ley" path) | 8–13 s each | **77–125 h** |
| Article summaries, 50–199 chars | 27,413 | ~4 s/article (batch of 5 ≈ 20 s: short input, system prompt cached) | ~30 h |
| Article summaries, ≥ 200 chars | 3,953 | ~8 s/article | ~9 h |
| Article summaries, < 50 chars | 5,112 | not worth summarising (production skips < 50) | 0 |
| **Total** | | | **≈ 115–165 h (5–7 days)** |

- **Missing articles are mostly short.** 32,525 of the 36,478 are under 200
  characters, so only 3,953 are in the scope of the existing backfill script
  (≥ 200 characters).
- **Electricity is negligible.** Assuming ~100–150 W for ~150 h, that is
  15–25 kWh.

**Rented GPU (rough estimate, not measured).**

- **Total workload:** ≈ 70M prompt tokens (reforms ≈ 52M; articles ≈ 18M,
  mostly the shared system prompt) and ≈ 8M output tokens.
- **DGX Spark / GB10**, with vLLM or SGLang continuous batching of 8–16
  requests:
  - prefill ~1.5–3k tok/s and aggregate decode ~150–300 tok/s;
  - ≈ 20–30 h;
  - its memory bandwidth is about half the M4 Max's, so single-stream decode
    is slower. The gain comes only from batching, which Ollama's MLX engine
    does not give on the Mac.
- **One H100 with vLLM:** ≈ 3–6 h.
- **OpenRouter flash-lite for comparison:** about an hour.

## OpenRouter use

Only a few flash-lite calls: 22 reform summaries and 10 article batches, under
a small fixed budget. The judge ran on the Claude CLI, not OpenRouter. Qwen ran
locally.

## Recommendation

**Go for a local qwen backfill of the article summaries. Put reform summaries
on hold until the input is fixed, whatever model writes them.**

1. **Model.** `qwen3.8:27b-mlx` is a valid replacement for flash-lite for this
   content: it is equal or better on every criterion and has perfect format
   compliance with reasoning off. Local is not cheaper in practice (the Mac
   needs about a week at full load for the whole backlog); choose it for
   independence from the API, not to save money.
2. **Fix the reform-summary input first.** It limits both models:
   - Show the **changed span** of each block (a word-level diff with some
     context) instead of the first 500 characters of "antes" and "ahora". When
     no visible change remains, say so explicitly ("cambio no visible en el
     fragmento") so the model writes "se modifica" rather than inventing.
   - **Base the omnibus note on the *reforming* norm** (`source_id`: how many
     laws or materias it touches), not on the materias of the modified law.
     Today 7,342 reforms get "forma parte de una ley ómnibus" because the law
     they modify has ≥ 15 materias: every Código Penal, LGT or LOREG reform.
   - Re-run this eval (the scripts are reusable) after the fix. Go ahead only
     if serious errors fall well below the current ~12%.
3. **Articles.** Run `backfill-citizen-summaries.ts` with the local endpoint:
   - scope: articles of ≥ 50 characters (about 31k, ~40 h on the Mac);
   - enforce ≤ ~320 characters and 3–5 tags at write time;
   - also store the tags (see the side findings).
   Before a full run, spot-check 50 outputs by hand, and consider regenerating
   the corrupted or truncated existing summaries.

**What must be built before writing into production safely:**

- **No writes from the Mac to the production DB.** Generate from a read-only
  snapshot into a JSONL file. Each row carries the key
  (`norm_id`, `block_id` or `source_id` + `reform_date`), the output, the model
  id and a hash of the input text or diff.
- **An import script run on the server**:
  - It re-validates each row with `validateReformSummary`, or the length, tag
    and second-person checks for articles.
  - It checks that the input hash still matches the current `versions` or
    `blocks` text, and skips rows whose source changed since the snapshot.
  - It inserts only where no row exists (`INSERT … WHERE NOT EXISTS`), in
    small transactions, so the daily pipeline's writes win. It stores
    `model = 'qwen3.8:27b-mlx'` for traceability.
  - It supports `--dry-run` and prints counts.
- **Resume support in the generator** (skip keys already in the JSONL) and a
  per-row time limit. Articles over ~8k tokens go to a separate pass with a
  larger `num_ctx`.
- **A post-import sample audit**, for example 50 random rows through the same
  Claude judge, recorded here.

## Code

Opt-in, and the default is unchanged (branch `feat/llm-local-ollama`):

- **`services/openrouter.ts`**
  - New `contentLlmEndpoint()` reads `CONTENT_LLM_BASE_URL` (any
    OpenAI-compatible `/v1` root), `CONTENT_LLM_MODEL` (required when a base URL
    is set), `CONTENT_LLM_API_KEY` (optional), `CONTENT_LLM_REASONING_EFFORT`
    (default `none`) and `CONTENT_LLM_TIMEOUT_MS` (default 300 s). With
    effort `none` or empty it also sends `chat_template_kwargs:
    { enable_thinking: false }`, which vLLM passes to the Qwen template and
    Ollama ignores. On older vLLM (e.g. 0.11), which rejects
    `reasoning_effort: "none"`, set `CONTENT_LLM_REASONING_EFFORT=` (empty).
  - `callOpenRouter` accepts `baseUrl`, `extraBody` and `timeoutMs`. With a base
    URL it sends no auth header when there is no key, and no OpenRouter
    `plugins`.
  - `<think>…</think>` blocks are stripped before JSON parsing.
- **`generate-reform-summaries.ts`** and **`backfill-citizen-summaries.ts`**
  use the endpoint. They need `OPENROUTER_API_KEY` only when no local endpoint
  is set.
- **Prompt modules.** The prompt, schema and diff queries moved to
  `scripts/reform-summary-prompt.ts`. The v10 prompt, batch schema and parser
  moved to `scripts/citizen-summary-backfill-prompt.ts`. Nothing in them
  changed; they are now importable by evals and tests.

Example:

```bash
CONTENT_LLM_BASE_URL=http://localhost:11434/v1 CONTENT_LLM_MODEL=qwen3.8:27b-mlx \
  DB_PATH=/path/to/snapshot.db \
  bun run packages/api/src/scripts/generate-reform-summaries.ts --no-write --limit 5
```

## Limitations

- **Small samples:** n = 42 reforms and 30 articles. No pairwise difference is
  significant except "qwen or flash-lite vs the existing article summaries".
- **One judge**, with no human spot-check. The judge only sees what the
  generator saw (truncated fragments), so it cannot catch errors that the
  truncation hides.
- **Baseline drift.** The 20 production flash-lite baselines were generated
  weeks or months ago, from DB state that may have differed (for example, the
  materias count behind "108 temas"). Qwen was run on today's state.
- **Throughput depends on the setup.** It was measured with other work on the
  Mac, and single-stream decode varied between 23 and 44 tok/s depending on
  context size. The rented-GPU figures are estimates, not measurements.

## Judge prompts

Reforms (appended to the Claude CLI system prompt):

```
Eres un evaluador experto en derecho español y en comunicación institucional con la ciudadanía. Evalúas resúmenes automáticos de reformas legales ("qué cambió") que se publican en una web pública para ciudadanos sin formación jurídica. Cada resumen se generó SOLO a partir del material de entrada que se te muestra (título de la ley, materias y fragmentos "antes/ahora" de los artículos modificados, truncados a 500 caracteres). El generador tenía estas reglas: titular de máximo 15 palabras; resumen de 1-4 frases sobre qué cambió y por qué importa; no inventar datos (si no ve el cambio, decir "se actualizan/se modifican"); lenguaje ciudadano; español con tildes; importance (high/normal/low/skip) y reform_type (new_law/modification/correction/derogation).

Puntúa CADA candidato de 0 a 2 en:
1. fidelidad: 2 = todo lo que afirma (titular y resumen) está respaldado por el material de entrada; 1 = alguna exageración, generalización o detalle no respaldado sin ser grave; 0 = inventa cifras, fechas, plazos, sujetos o efectos, o contradice el texto. La fidelidad legal es lo más importante: sé estricto y compara cifras, fechas y plazos con el texto.
2. cambio: 2 = explica lo que realmente cambió entre "antes" y "ahora" (o el contenido clave si es ley nueva); 1 = vago o se queda en "se modifica X" cuando el material permitía concretar; 0 = no refleja el cambio o describe otra cosa.
3. lenguaje: 2 = claro y llano para un ciudadano; 1 = jerga sin explicar o redacción torpe; 0 = incomprensible.
4. ortografia: 2 = español correcto con tildes, ñ y signos; 1 = algún error menor; 0 = errores frecuentes, falta sistemática de tildes, o texto en otro idioma.
5. formato: 2 = titular ≤15 palabras, resumen 1-4 frases, importance y reform_type razonables; 1 = un incumplimiento leve; 0 = varios o graves.

Después indica cuál prefieres publicar ("A", "B" o "empate") y lista los errores de fidelidad concretos de cada candidato (vacío si no hay).
```

Articles: the same structure, with the backfill v10 rules (third person, only
what the article says, no added norm identifiers, concrete data, 80–300
characters, 3–5 tags). "Cambio" becomes "cobertura" (the essentials and the
key concrete data are included).
