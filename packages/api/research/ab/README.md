# Embeddings A/B: Gemini-2 vs Qwen3-8B (local Ollama)

Self-contained A/B to decide whether to replace `google/gemini-embedding-2-preview`
(OpenRouter, 3072 dim, $0.20/M tokens) with `qwen3-embedding:8b` (local Ollama,
4096 dim, free).

Zero production code is touched: this all lives in `research/ab/`. Both models
coexist in the `embeddings` SQLite table via the `model` column of the composite
PK.

## Files

| File | Role |
|---|---|
| `ollama-embeddings.ts` | Thin Ollama `/api/embed` client, Qwen3 instruction prefix helper, Matryoshka truncation |
| `corpus.ts` | Builds the A/B corpus (eval norms + top-100 distractors → ~60k sub-chunks) with production-identical formatting |
| `embed-corpus-qwen3.ts` | Generates Qwen3 embeddings over the corpus, writes to SQLite under `model="qwen3-ol-8b"` |
| `eval-ab.ts` | Runs 6 variants against `eval-answers-504-omnibus.json` gold set, reports norm-level Recall@K + MRR |

## Variants compared

| ID | Model | Query transform | Doc |
|---|---|---|---|
| A | Gemini-2 | `task: question answering \| query: ...` (prod) | prod format |
| B | Gemini-2 | raw (ablation) | prod format |
| C | Qwen3-8B | raw | prod format |
| D | Qwen3-8B | `Instruct: ... \nQuery: ...` (Qwen3 asymmetric) | prod format |
| E | Qwen3-8B | Instruct + Matryoshka @2048 | MRL truncated @2048 |
| F | Qwen3-8B | Instruct + Matryoshka @1024 | MRL truncated @1024 |

## Running

Prerequisites:
- Ollama 0.20+ running locally (`ollama serve` or Ollama.app with Metal)
- `qwen3-embedding:8b` pulled: `ollama pull qwen3-embedding:8b`
- `OPENROUTER_API_KEY` env var (only for Gemini variants A/B)

```bash
# 1. Inspect the corpus plan (no side effects)
bun packages/api/research/ab/embed-corpus-qwen3.ts --dry-run

# 2. Generate Qwen3 embeddings for the full corpus (~60k chunks, ~2–3h on M4 Max)
bun packages/api/research/ab/embed-corpus-qwen3.ts

#    If interrupted, resume from where it left off:
bun packages/api/research/ab/embed-corpus-qwen3.ts --resume

# 3. Smoke test with just 50 chunks first
bun packages/api/research/ab/embed-corpus-qwen3.ts --limit 50

# 4. Run the eval (writes ab-results/eval-<timestamp>.json)
OPENROUTER_API_KEY=... bun packages/api/research/ab/eval-ab.ts

#    Or skip Gemini (local-only):
bun packages/api/research/ab/eval-ab.ts --only-local

#    Or just a subset of variants:
bun packages/api/research/ab/eval-ab.ts --variants=A,D
```

## Gold set

`data/eval-answers-504-omnibus.json` — 65 citizen legal questions with
`expectedNorms` annotations. Metrics are norm-level (the eval set does not
tag specific article IDs as ground truth).

## Corpus

- 23 norms that appear in `expectedNorms` (guarantees all ground-truth
  norms are embedded)
- 100 top-cited vigente norms by `reforms * 2 + articles` (distractors, same
  ranking formula as `sync-embeddings.ts`)
- Total: **123 norms → ~46k articles → ~60k sub-chunks** (after `splitByApartados`)

## Known gotcha: Tailscale / VPN

If `ollama pull qwen3-embedding:8b` hangs at "pulling manifest" or times out
against `r2.cloudflarestorage.com` (`172.64.x.x`), a VPN like Tailscale is
likely blocking the Cloudflare R2 CDN. Disable the VPN or the exit node for
the pull, then re-enable it after.

## Expected runtime on M4 Max (48 GB)

- Embedding 60k chunks: **2–3 hours** (first-call cold; once the model is
  warm Ollama sustains ~6–10 embeddings/s per 500-token chunk)
- Eval (65 queries × 6 variants): **~5 minutes** (most of it is Gemini HTTP
  round-trips; Qwen3 query embeddings are ~50ms each locally)

## Decision criterion

> Qwen3 replaces Gemini if **Recall@5 ≥ Gemini - 2pp AND Recall@1 ≥ Gemini**.

Latency and cost almost always favor Qwen3; the debate is retrieval quality.
Report goes to `docs/embeddings-ab-report.md` (private) once all variants
have run.
