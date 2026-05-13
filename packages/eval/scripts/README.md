# `packages/eval/scripts/`

One-shot, runnable utilities for the eval pipeline. All TypeScript / Bun
(project convention — keep this directory monolingual).

| Script | Purpose |
|--------|---------|
| `generate-ft-pairs-v1.ts` | Generate synthetic Q→article training pairs from `../leyes/` using `qwen3.6` via NaN. Output: `../data/ft-pairs-v1.jsonl`. Resumable; appends. Skips heldout norms and disposition articles (`dt*`/`da*`/`df*`/`dd*`). |
| `spot-check-ft-pairs.ts` | Judge a random 50-pair sample with `gemma4` (NaN, different model family from generator). Emits `../data/ft-pairs-v1.spot-check.md`. Used as the acceptance gate for ft-pairs-v1. |

## Conventions

- All scripts read `NAN_API_KEY` from `.env` (legacy `HERMES_API_KEY` fallback).
- Output paths absolute via `import.meta.dir` resolution.
- Concurrency cap respects NaN limits: 5 concurrent / 100 RPM. Default `CONCURRENCY=4`.
- Append-only writes; never load full output into memory.
- Stop conditions baked in: rate floor, consecutive-error count, runtime cap.
