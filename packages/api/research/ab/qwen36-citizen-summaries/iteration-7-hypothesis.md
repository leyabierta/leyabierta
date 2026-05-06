# Iteration 7 Hypothesis

**Change:** Add 4 few-shot examples in the Qwen system prompt targeting the empty-article failure mode.

**Rationale:** Qwen consistently over-applies the "return empty" rule to borderline substantive articles. Iteration 3 (closed whitelist) was the best result so far (12 wins, 6 Gemini, 0% empty) but didn't sustain. The pattern suggests Qwen doesn't just misclassify — it lacks concrete examples of what "borderline but must summarize" looks like.

**Examples added:**
1. **Composición de órgano** — procedural/organizational but has real citizen impact (5-15 members, 4-year terms) → MUST summarize
2. **Plazos de prescripción** — procedural but concrete deadlines → MUST summarize
3. **Procedimiento administrativo** — application process with dates → MUST summarize
4. **Entrada en vigor** — clear empty case → correctly empty
5. **Derechos procesales** — procedural rights → MUST summarize

The key insight: Qwen needs to see concrete examples where the article has procedural/organizational language but still has substantive citizen-facing content. Showing it the pattern "procedural ≠ empty" should override the over-aggressive empty behavior.

**What we're NOT changing:** Gemini prompt, temperature, max_tokens, retry wrapper, schema, or sampling strategy. Only the Qwen system prompt gets new examples.

**Expected outcome:** If few-shot works, Qwen empty rate should drop to near 0% and win rate should improve toward or above Gemini's. If Qwen still returns empty for substantive articles despite examples, the failure mode may be intrinsic to the model's classification behavior.
