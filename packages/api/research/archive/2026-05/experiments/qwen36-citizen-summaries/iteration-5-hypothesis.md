# Iteration 5 Hypothesis

**Root cause of remaining quality gap:** Qwen 3.6 is a thinking model that generates verbose free-form `<think>...</think>` blocks. This verbose reasoning:
1. Wastes tokens (avg 1800 tokens_out vs Gemini's 107)
2. Bleeds into output — over-extended reasoning causes Qwen to invent procedural details not in the article
3. Can truncate mid-thought if max_tokens is tight

**Change: Prompt-level thinking compression inspired by structured-cot.**

Instead of free-form verbose reasoning, the system prompt instructs Qwen to think in a compact structured format:

```
Pensamiento interno (breve):
- OBJETIVO: ¿Qué derecho u obligación describe este artículo?
- HECHOS: ¿Qué datos concretos hay (plazos, cantidades, requisitos)?
- ETIQUETAS: 3-5 palabras clave en llano
- RESUMEN: [draft]
```

This is the prompt-level equivalent of structured-cot's GOAL/APPROACH/EDGE format. The model still "thinks" before outputting, but the structured format prevents verbose digressions and hallucinated details.

**Also bump max_tokens to 32000** — no reason to cap it since we have no token limit.

**Hypothesis:** Compact structured thinking will reduce hallucinated procedural details and over-extension while preserving accuracy. Expected: Qwen wins ≥ Gemini wins, similar or lower tokens_out.

**What stays the same:** Retry wrapper unchanged. Gemini unchanged. Sample fresh from DB.
