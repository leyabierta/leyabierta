# eval/src/sources

External sources that feed seeds into the v3 dataset generation pipeline. Each script is independent and emits a JSONL of candidate `(question, expectedNorms[], expectedArticles[])` rows compatible with the v3 schema.

| Script | Source | Output |
|---|---|---|
| `scrape-dgt-consultas.ts` | DGT (Dirección General de Tributos) public consultations | Raw consultations + extracted Q&A |
| `llm-enrich-dgt.ts` | DGT scrapes | LLM-enriched with `expectedNorms[]` (uses qwen3.6 NaN) |
| `map-dgt-to-gold.ts` | DGT enriched | Maps to v3 gold-eval schema |
| `enrich-justicio-with-sas.ts` | Justicio HuggingFace datasets | Adds Spanish anonymized strings for dedup |
| `build-gold-eval-from-justicio.ts` | Justicio (Constitución, Código Civil, Vivienda) | v3-compatible gold subset |
| `build-gold-eval-from-asklog.ts` | Prod `ask_log` table (popular real user questions) | v3-compatible gold subset, citations parsed |
| `build-combined-gold-eval.ts` | All of the above | Single combined dataset for the A/B |
| `analyze-combined-gold-eval.ts` | Combined gold results | Markdown report (R@1/R@5/R@10 per origin) |
| `build-eval-from-v3.ts` | `packages/eval/datasets/v3/accepted-*.jsonl` | Format compatible with `research/ab/eval-prod-replica.ts` |

## Why these live in `packages/eval/` and not `research/ab/`

They scrape and enrich external sources to feed the dataset generation pipeline. The retrieval/synthesis A/B scripts in `packages/api/research/ab/` consume the resulting datasets — but they don't depend on these scrapers at runtime. Splitting the two makes the dependency direction explicit: `sources/` → datasets → `research/ab/`.

## Running

These scripts have not been wired into the `packages/eval/src/cli.ts` orchestrator yet. Run each directly:

```bash
bun run packages/eval/src/sources/scrape-dgt-consultas.ts --help
```

Most write to `packages/eval/datasets/` or `data/`. Read the header of each script for its specific I/O.
