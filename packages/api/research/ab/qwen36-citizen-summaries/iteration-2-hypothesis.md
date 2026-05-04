# Iteration 2 Hypothesis

**Change:** Add retry-on-timeout wrapper + bump timeout from 120s to 180s.

**Problem:** Iteration 1 eliminated false-empties completely (0/30), but timeout rate increased to 3/30 (10%). Qwen is generating much longer reasoning chains now that it's more confident about generating summaries — outputs are 4000-5000 tokens of thinking. The 120s timeout is too short for these longer reasoning traces.

**Change details:**
- Bump `signal` timeout from 120,000ms to 180,000ms in `callChat()`.
- Add retry-on-timeout wrapper: if a Qwen call times out (`error` contains "timed out"), retry once with the same prompt. Cap at 1 retry.
- Gemini stays unchanged.

**Hypothesis:** The 3 timeouts in Iteration 1 were likely a mix of (a) server load and (b) longer reasoning chains. Bumping to 180s should resolve most of them; the retry wrapper catches any remaining edge cases. Combined, this should bring the error rate below 5% (≤ 1 case out of 30).

**What we're NOT changing:** Prompt (the tightened version from Iteration 1 works perfectly), temperature, model, schema. Just timeout + retry.
