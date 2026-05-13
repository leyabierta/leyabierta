# Iteration 1 Hypothesis

**Change:** Tighten the "return empty" guidance in Qwen's system prompt.

**Problem:** Qwen returned empty for 5/30 substantive articles (17% false-empty rate). The current trigger "puramente procedimental o técnico" is too broad — Qwen treats procedural-but-substantive articles (e.g. organizational rules, extinction procedures, voting rules) as "technical" and returns empty.

**Change details:**
- Replace the open-ended "puramente procedimental o técnico" with a **closed whitelist** of what actually qualifies: "solo si el artículo declara entrada en vigor, deroga o modifica otra norma, asigna rango de ley orgánica, o es un contenido puramente organizativo interno sin efecto sobre derechos u obligaciones ciudadanas."
- Add explicit fallback: "En caso de duda, genera siempre un resumen breve."
- Add emphasis: "Los artículos que describen procedimientos, reglas de funcionamiento, composición de órganos, o requisitos administrativos SÍ tienen contenido sustantivo para el ciudadano — resúmelos."

**Hypothesis:** This single change will drop Qwen's false-empty rate from 17% to ≤ 5% (≤ 1 case), because it directly addresses the root cause — Qwen's overly broad interpretation of "procedimental o técnico."

**What stays the same:** Gemini prompt unchanged, sample drawn fresh from DB, judge prompt verbatim, all other harness params identical.

**What we're NOT changing yet:** retry wrapper, few-shot examples, thinking budget, schema descriptions. One variable at a time.
