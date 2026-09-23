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

Final code of the PR (after the adversarial review and the investigation of
the remaining errors below), same 40 reforms, same model, the old prompt's
outputs unchanged:

| Group | n | Total /10 new vs old | Fidelity new vs old | Change captured new vs old | Preferred new/old | Fidelity 0 new vs old |
|---|---|---|---|---|---|---|
| All | 40 | **9.25** vs 6.78 | **1.75** vs 0.68 | **1.75** vs 0.65 | **37** / 3 | **0** vs 20 |
| Old rule flagged as omnibus | 14 | 9.29 vs 6.21 | 1.79 vs 0.29 | 1.79 vs 0.86 | 14 / 0 | 0 vs 11 |
| First 500 chars identical | 14 | 9.21 vs 6.71 | 1.79 vs 0.64 | 1.71 vs 0.43 | 12 / 2 | 0 vs 7 |
| Random | 12 | 9.25 vs 7.50 | 1.67 vs 1.17 | 1.75 vs 0.67 | 11 / 1 | 0 vs 2 |

The new prompt has 10 minor issues left (fidelity 1): summaries that miss part
of the change or read it loosely. There are no invented facts.

### How the last errors were fixed

An intermediate version scored 9.13 and still had 3 serious errors. Each was
repeated 5 times to see whether it was stable:

- **"gasto financiero" instead of "no financiero".** Stable: 4 of 5 runs got it
  wrong. jsdiff aligned a rewritten sentence on short common words ("de", ","),
  so the change reached the model word by word ("[-con-] {+no+} [-las-]
  {+financiero+}") and the "no" was lost. Fix: changes separated by at most 2
  unchanged words are grouped into one `[-old phrase-] {+new phrase+}`. After
  the fix, 5 of 5 runs were correct.
- **A summary that restated principles already in the old text.** Stable: 5
  of 5. Same cause, plus a single long article cut at 1,200 characters when
  7,000 were available. Fix: grouping, and the budget is now shared among the
  articles shown, with at least 1,200 characters each. After the fix, 5 of 5
  runs were correct.
- **An organism that is not in the material.** Mostly a false positive of the
  judge: the change is in a 50,000-character annex, past the part of the text
  the judge was shown. The judge's material is now centred on the region that
  changes.

Image links from the BOE (`![imagen](/datos/…png)`) are normalized to
`[imagen]`, so that a new file path does not count as a text change.

## Limits

- 40 reforms, one judge, no human spot-check. Judging the same outputs twice
  changes the fidelity score in about 13 of 40 cases, so read small
  differences as noise. The size of the gap here (37/3, 0 vs 20 serious
  errors) is not.
- The first run's truncated material shows how sensitive the judge is to what
  it sees. The final run gives it more than the generator saw, so it can catch
  omissions.
