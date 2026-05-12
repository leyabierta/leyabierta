# Qwen vs Gemini — Judging Rubric

For each question, score each variant on 4 dimensions × 0-2 points.

## Dimensions

### 1. Factual correctness (0-2)
- 0 = Wrong fact (incorrect number, wrong rule, hallucinated content).
- 1 = Mostly right but missing a key qualifier or has a minor inaccuracy.
- 2 = Correct, including all key qualifiers (numbers, conditions, exceptions).

Reference: `expectedAnswer` field plus my own knowledge of Spanish law as of 2026.
Special: for hard questions, accept legitimate alternatives that the gold set may
not enumerate (the eval-set v2 explicitly notes multiple valid norm options).

### 2. Citation accuracy (0-2)
- 0 = Cites norms not in evidence, or hallucinated article numbers.
- 1 = Cites real evidence but format wrong / verification fails / approximate match only.
- 2 = All citations verified against evidence with strict block_title match.

This is measured automatically by `verifyCitations()`. I'll cross-check the
`validCitations` field — `verified: true` count vs total citations claimed.

### 3. Citizen tone (0-2)
- 0 = Heavy legal jargon, reads like a lawyer's brief.
- 1 = Mostly accessible but slips into jargon at points (e.g. "arrendador" without explanation).
- 2 = Plain language, would pass the "explain to my mother" test from the system prompt.

The system prompt explicitly forbids: arrendatario→inquilino, arrendador→casero,
extinguir contrato→echar, prestación por desempleo→paro. I'll grep for these.

### 4. Completeness / directness (0-2)
- 0 = Rambles, irrelevant, or misses the actual question.
- 1 = Answers but buried after preamble, or skips an obvious follow-up.
- 2 = Direct first sentence answers the question; matices follow cleanly.

System prompt mandates: "Empieza SIEMPRE con la respuesta directa."

## Out-of-scope behavior (Q9-Q10)

For declines, I score binary:
- Correct decline (declined=true, sensible canned response) = pass.
- Wrong: produces a substantive answer to non-legal question = fail (-2 to total).
- Wrong: declines a legitimate legal question = fail (-2 to total).

## Aggregate score per variant

Per question: max 8 points (4 × 2). 8 questions × 8 = 64 max.
Plus 2 questions out-of-scope: pass/fail × ±2.

Final score = sum / 64 expressed as %.

Equal-or-greater (Qwen ≥ Gemini) → continue to full eval.
Significantly below (Qwen < Gemini - 15%) → diagnose, iterate prompt before scaling.
Catastrophic (Qwen < 30%) → reject Qwen-portado variant, jump straight to tuned.

## Latency / cost log

Document but don't gate on:
- Gemini latency, tokens, cost per query.
- Qwen latency (Q4 local CPU), tokens, no cost.

Scaled to FP8 server: rough Q4→FP8 latency ratio is ~3-5x faster.
