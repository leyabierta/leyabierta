# Reform summary prompt: word diff and omnibus by source law (2026-09-23)

Follow-up to `2026-09-23-qwen-local-summaries.md`, which found that the reform
summary errors came from the input, not the model:

- The prompt only carried the first 500 characters of each article, before and
  after the reform. In half of the modified articles both fragments were
  identical, so the model had to guess what changed.
- The "ley ómnibus" note was decided by the materias of the law being
  modified (≥ 15). That flagged every reform of the Código Penal, the LGT and
  the LOREG, whatever law made it: 7,342 reforms in production.

## Change

- **Word diff.** `formatBlockChange` (in `reform-summary-prompt.ts`) sends only
  what changes, with about 12 words of context. Deletions are written
  `[-texto-]` and insertions `{+texto+}`. A near-total rewrite shows the start
  of both versions. The prompt covers up to 15 articles and about 7,000
  characters of changes per reform; any further articles are listed by title.
  If the text is identical before and after, the model is told not to guess
  what changed.
- **Omnibus decided by the law that makes the change.** A reform counts as
  omnibus when that law modifies at least 10 laws in the corpus or has at least
  15 materias. The prompt names that law. The omnibus note is now context the
  model may mention; it is no longer an instruction to call the law a mix of
  unrelated topics.

## Method

- **Sample: 40 reforms of in-force laws without a summary**, from a read-only
  production copy. Three groups:
  - 14 that the old rule flagged as omnibus;
  - 14 with a modified article whose first 500 characters were identical;
  - 12 random.
- **Generator:** Qwen3.8-27B (AWQ INT4, vLLM, thinking off), the same model for
  both prompts. Only the prompt differs.
- **Judge:** Claude Sonnet via the CLI, blind to the prompt version, with A/B
  order randomized.
  - It sees the full article text before and after, up to 12,000 characters
    per version, and the facts about the source law (title, number of laws it
    modifies, materias).
  - The rubric is the one from the earlier eval: fidelity, change captured,
    language, orthography and format, each scored 0–2.
  - A first run truncated the judge's material to 3,500 characters. The judge
    then marked correct summaries of late changes as invented, so the numbers
    below come from the second run with full text.

## Results

| Group | n | Total /10 new vs old | Fidelity new vs old | Change captured new vs old | Preferred new/old | Fidelity 0 new vs old |
|---|---|---|---|---|---|---|
| All | 40 | **9.13** vs 6.85 | **1.68** vs 0.63 | **1.70** vs 0.78 | **35** / 5 | **3** vs 22 |
| Old rule flagged as omnibus | 14 | 9.29 vs 6.50 | 1.71 vs 0.14 | 1.71 vs 1.07 | 13 / 1 | 1 vs 12 |
| First 500 chars identical | 14 | 9.21 vs 6.29 | 1.86 vs 0.50 | 1.71 vs 0.29 | 14 / 0 | 0 vs 8 |
| Random | 12 | 8.83 vs 7.92 | 1.42 vs 1.33 | 1.67 vs 1.00 | 8 / 4 | 2 vs 2 |

The new prompt still has 3 serious fidelity errors:

- "gasto financiero" where the text says "no financiero";
- one summary that restates principles already in the old text and misses the
  real change;
- one organism named that is not in the material.

Several minor issues come from articles whose text is identical before and
after (the change is outside the text we store). The model now says so instead
of inventing a "formal" change.

## Limits

- 40 reforms, one judge, no human spot-check.
- The first run's truncated material shows how sensitive the judge is to what
  it sees. The final run gives it more than the generator saw, so it can catch
  omissions.
