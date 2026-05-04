# Iteration 3 Hypothesis

**Changes:** Three targeted additions to Qwen's system prompt:

1. **Explicit length enforcement:** "El resumen debe ser estrictamente menor de 280 caracteres. Cuenta los caracteres. Si excedes, acorta sin perder el dato central."

2. **Anti-AI-slop directive:** "NO añadas frases de relleno como 'Consulte la normativa vigente', 'Para más información', 'Recuerde que...', o cualquier advertencia no presente en el artículo original."

3. **Few-shot examples:** Add 2 examples showing good vs bad summaries to ground the model on the expected output style.

**Hypothesis:** The verbosity and AI-slop are caused by Qwen's thinking model tendency to be thorough and add helpful-sounding disclaimers. Explicit length enforcement + anti-slop + few-shot should bring Qwen's average summary length down to ~200-250 chars and eliminate the AI-slop issue. Combined with the prompt tightening from Iteration 1, this should make Qwen's quality competitive with Gemini on the judges.

**What stays the same:** Retry wrapper and 180s timeout from Iteration 2 remain. Gemini unchanged. Sample fresh from DB.
