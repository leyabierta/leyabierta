# Q2 Evidence Noise Diagnosis — "Cuanto dura la baja por paternidad?"

**Date:** 2026-04-21
**Model:** google/gemini-2.5-flash-lite
**Result:** Hallucinated "16 semanas" — correct answer is "19 semanas" (ET art.48.4 consolidated)

## Summary

The pipeline retrieves 15 articles. The correct article (ET art.48.4 with "diecinueve semanas") IS present at position 3 in the evidence (Tier 0), but it is drowned out by **7 articles mentioning "16 semanas"** from older/derogated versions, transitional provisions, and sectoral norms. The LLM sees a 7:1 ratio of "16" vs "19" and majority-votes for the wrong answer.

## Evidence Breakdown (15 articles)

| # | Tier | Norm ID | Norm | Article | Mentions 16 | Mentions 19 | Key content |
|---|------|---------|------|---------|-------------|-------------|-------------|
| 1 | 0 | BOE-A-1995-7730 | ET 1995 (DEROGADO) | Art 48 bis | - | - | Paternidad general, no cifra |
| 2 | 0 | BOE-A-2015-11430 | ET 2015 (vigente) | DT septima | - | - | Transicional, no cifra |
| 3 | 0 | **BOE-A-2015-11430** | **ET 2015 (vigente)** | **Art 48.4** | - | **YES ("diecinueve")** | **CORRECT: "diecinueve semanas"** |
| 4 | 0 | BOE-A-2015-11430 | ET 2015 (vigente) | Art 48 bis | - | - | Permiso parental 8 semanas (hijo <8 anos) |
| 5 | 0 | **BOE-A-1995-7730** | **ET 1995 (DEROGADO)** | **Art 48.4** | **YES** | - | **"dieciseis semanas ininterrumpidas"** |
| 6 | 0 | BOE-A-2015-11430 | ET 2015 (vigente) | Art 37.4 | - | - | Hora de ausencia por lactancia |
| 7 | 0 | BOE-A-2015-11719 | EBEP | DT novena | YES | YES | Transitional: progressive application |
| 8 | 0 | **BOE-A-2015-11430** | **ET 2015 (vigente)** | **DT decimotercera.2** | **YES ("16 semanas" x2)** | - | **Transitional rollout mentioning 16 weeks as interim** |
| 9 | 0 | BOE-A-1985-12666 | LOPJ | Art 373.6 | - | - | Jueces: "cuatro semanas" |
| 10 | 0 | BOE-A-2015-11719 | EBEP | Art 49 | YES | YES | Empleados publicos, mixed numbers |
| 11 | 1 | **BOE-A-2022-7184** | **RD 305/2022 (Fuerzas Armadas)** | **Art 102.1** | **YES** | - | **"dieciseis semanas" — military personnel** |
| 12 | 2 | **BOE-A-2005-11757** | **Funcion Publica Castilla y Leon** | **Art 60** | **YES** | - | **"dieciseis semanas" — regional civil servants** |
| 13 | 2 | BOE-A-2011-7752 | Empleo Publico Castilla-La Mancha | Art 104 | - | - | Reference to equivalent duration |
| 14 | 3 | BOE-A-2008-20744 | PGE 2008 | Sexta | - | - | Modifier norm, families numerosas |
| 15 | 3 | BOE-A-2018-9268 | PGE 2018 | DF trigesima octava | YES | - | Modifier mentioning 16 |

## Key Findings

### 1. Noise ratio: 7:1 against correct answer

- **Articles explicitly saying "16 semanas":** 7 (positions 5, 7, 8, 10, 11, 12, 15)
- **Articles explicitly saying "19 semanas" (or "diecinueve"):** 3 (positions 3, 7, 10)
- Of those 3, only **position 3 (ET art.48.4)** unambiguously states 19 weeks as the current rule
- Positions 7 and 10 are EBEP transitional/mixed provisions that mention BOTH 16 and 19

### 2. The derogated ET 1995 is a poison pill

BOE-A-1995-7730 art.48.4 is the **old, derogated** Estatuto de los Trabajadores from 1995. It explicitly says "dieciseis semanas ininterrumpidas". This norm was superseded by BOE-A-2015-11430 (the current ET), yet both appear as Tier 0 general state law. The LLM cannot distinguish which is current.

### 3. Transitional provisions reinforce the wrong number

ET 2015 DT decimotercera.2 mentions "16 semanas" TWICE in the context of the progressive rollout from 2019-2021. While this is a transitional provision (no longer in effect), it reinforces the "16" signal. The `numbersToDigits()` function even converts these to digits, making "16 semanas" even more prominent as a literal string match.

### 4. Sectoral norms with outdated numbers

The Fuerzas Armadas regulation (RD 305/2022 art.102.1) says "16 semanas" because military personnel have their own regime. The Castilla y Leon function publics law also says "16 semanas". These are technically correct for their narrow scope but misleading for the general citizen question.

### 5. Correct article is at position 3 — should be enough, but isn't

The correct ET art.48.4 with "diecinueve semanas" is at position 3 (early in evidence), yet the model still hallucinates. This suggests the model does majority-voting across all evidence rather than trusting the most authoritative source.

## Root Causes

1. **Derogated law in evidence** — BOE-A-1995-7730 should never appear for current-law questions. It's been fully superseded.
2. **Transitional provisions** — DT decimotercera.2 is about the 2019-2021 rollout period (now expired). It shouldn't be in evidence for "how long is paternity leave NOW?"
3. **Sectoral norms dilute signal** — Military, judicial, and regional civil service norms have different rules. For a general citizen question, only the ET should answer.
4. **No temporal filtering** — Despite `useTemporal` being `false` for this query, the question is inherently temporal ("how long is it NOW?"). The pipeline's temporal detection didn't trigger.

## Recommendations

1. **Filter derogated norms** — BOE-A-1995-7730 should be excluded (or heavily penalized). It's estado=derogado.
2. **Reduce TOP_K for simple factual questions** — 15 articles is far too many for "what's the duration?" A TOP_K of 5 would give {ET 48 bis old, ET DT septima, ET 48.4 (correct), ET 48 bis new, ET 1995 48.4}. Even with the derogated law, 5 articles would have a 1:1 ratio instead of 7:1.
3. **Boost the correct art.48.4 to position 1** — The reranker should give higher weight to the consolidated current version over the derogated one.
4. **Mark transitional provisions** — DTs that reference historical rollout periods should be deprioritized or annotated as "no longer applicable".
5. **Enable temporal detection** for questions about current durations/amounts — "cuanto dura" is inherently temporal even without a date reference.
