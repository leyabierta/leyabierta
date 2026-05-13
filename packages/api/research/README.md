# packages/api/research/

Research scripts and datasets for the RAG pipeline. This directory is **not production code** — nothing here runs in prod or is imported by `packages/api/src/`. Active eval infrastructure lives in `packages/eval/`.

## Live files (do not move without checking imports)

### datasets/

Shared data files used by `packages/eval/src/` importers and sources. All paths are hardcoded in the eval pipeline — moving any file here requires updating the corresponding source script.

| File | Used by | Notes |
|------|---------|-------|
| `datasets/citizen-queries.json` | `packages/eval/src/importers/citizen-importer.ts` | 50 human citizen queries, v1 dataset |
| `datasets/citizen-queries-v3.json` | `packages/eval/src/sources/build-eval-from-v3.ts` (output) | Active v3 dataset (2000+ questions) |
| `datasets/gold-eval-v1.json` | `packages/eval/src/run-eval.ts` (legacy format support) | Legacy 50-question gold set; harness auto-detects format |
| `datasets/gold-eval-combined.json` | `packages/eval/src/sources/analyze-combined-gold-eval.ts` | Combined DGT + Justicio gold set |
| `datasets/gold-eval-dgt.json` | `packages/eval/src/sources/map-dgt-to-gold.ts` (output) | DGT-sourced gold set |
| `datasets/gold-eval-dgt-enriched.json` | `packages/eval/src/sources/llm-enrich-dgt.ts` (output) | LLM-enriched DGT gold set |
| `datasets/gold-eval-justicio.json` | `packages/eval/src/sources/enrich-justicio-with-sas.ts` (input) | Justicio-sourced gold set |
| `datasets/gold-eval-justicio-enriched.json` | `packages/eval/src/sources/enrich-justicio-with-sas.ts` (output) | Enriched Justicio gold set |
| `datasets/gold-eval-justicio-filtered.json` | `packages/eval/src/sources/enrich-justicio-with-sas.ts` (output) | Filtered Justicio gold set |
| `datasets/gold-eval-asklog-candidates.json` | `packages/eval/src/sources/build-gold-eval-from-asklog.ts` (output) | Asklog-sourced candidates |

### Uncertain / leave in place

| File | Notes |
|------|-------|
| `datasets/citizen-queries-v3-1000.json` | Intermediate build artifact from v3 pipeline |
| `datasets/citizen-queries-v3-500.json` | 500-question subset of v3 |
| `datasets/citizen-queries-v3-failed468.json` | Failed-entry subset from v3 pipeline run |
| `datasets/gold-eval-justicio-sample110.json` | 110-question sample; no live references found |
| `training/triplets.jsonl` | Untracked (not in git). FT triplets from closed FT experiments |
| `training/triplets-v2.jsonl` | Untracked (not in git). Same provenance |

## ab/ — Reproducible A/B suite

The `ab/` directory holds the reproducible A/B experiment that moved RAG from Gemini to the full Qwen3 NaN stack. See `ab/README.md` for the full file inventory and how to re-run.

**Do not move files from `ab/` without checking** — the parallel `rag-gemini-legacy.ts` retriever work may reference them as a learning source.

## archive/ — Closed experiments

All dead code and superseded experiments. Organized by archive date:

| Subfolder | Contents |
|-----------|----------|
| `archive/contextual-enrichment/` | Contextual embedding enrichment experiments (Phase 3) |
| `archive/hyde/` | HyDE (hypothetical document embeddings) experiments |
| `archive/phase4/` | Phase 4 A/B monitoring and reporting scripts |
| `archive/spikes/` | Initial RAG spikes (pre-hybrid search era) |
| `archive/ab-misc/` | One-shot A/B helpers (recovery merges, subset extractors) |
| `archive/2026-05/reports/` | Closed analysis docs: RAG eval report, INT8 rollout plan, embeddings A/B interim |
| `archive/2026-05/evals/` | Pre-packages/eval era standalone eval scripts |
| `archive/2026-05/experiments/` | One-shot tools (quantize-vectors) and concluded sub-experiments (qwen36-citizen-summaries) |

## Rules for adding new research scripts

1. **Name with a date prefix** if it's a one-off: `2026-05-15-check-threshold.ts`. This makes archiving trivial.
2. **Add a JSDoc header** explaining purpose, prerequisites, and expected runtime.
3. **Use a subfolder** for multi-file experiments (like `ab/qwen36-citizen-summaries/`). Include a `GOAL.md` and a `VERDICT-FINAL.md` or `POST-MORTEM.md` when the experiment concludes.
4. **Move to archive/ when superseded.** Run `git mv` to preserve history.
5. **Never import research scripts from `packages/api/src/`**. References in JSDoc comments (like `see quantize-vectors.ts`) are fine; `import` statements are not.
6. **Datasets used by `packages/eval/`** stay in `datasets/` with their exact current paths — the eval pipeline hardcodes them.
