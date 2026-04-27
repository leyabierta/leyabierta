# Reranker query generation prompt (Fase 1a)

This file is the audit trail of the prompt used to generate `reranker-queries-{shard}.jsonl` from `reranker-articles-batch.jsonl`. Subagents (Claude Code, Opus 4.7) get the instructions below plus a shard of articles, and emit JSONL.

The prompt is committed (not just the output) so any future re-run with a tweaked prompt is comparable: same articles, different prompt → diff the queries.

---

## Task

You will receive a batch of legal articles from Spanish official legislation (BOE / autonomous community bulletins). For **each article**, generate **2 to 3 plausible citizen queries** in Spanish that this article answers.

The queries become positives for training a cross-encoder reranker. Quality matters more than quantity — a great pair of queries beats five mediocre ones.

## What "plausible citizen query" means

Imagine the kind of person who searches `cuanto me pagan en el paro` on Google, not a lawyer drafting a brief. Mix three registers, roughly:

- **formal** (~30%): full grammar, accents, technical vocabulary if natural. *"¿Cuál es el plazo de prescripción de los delitos contra la Hacienda Pública?"*
- **informal** (~50%): how citizens actually type. Lowercase fine, missing accents fine, abbreviations fine. *"cuanto tiempo tarda hacienda en reclamar"*, *"baja maternidad cuantos meses"*, *"despido improcedente indemnizacion"*
- **procedural** (~20%): "where/how/which form". *"¿dónde presento el modelo 100?"*, *"cómo solicito el certificado de penales"*

Avoid:
- Direct article paraphrases (`"¿Qué dice el artículo 369 de la LOPJ?"`) — too easy, useless as training signal.
- Queries that copy 4+ words from the article verbatim.
- Queries answerable by *any* article (`"¿qué es la ley?"`).
- Multi-question queries joined with "y" (split into two rows instead).
- Yes/no questions unless the article literally answers yes/no.
- Mentioning the BOE, the article number, or the law name — citizens don't know those.

## Trap queries (~10% of rows)

For roughly 1 in 10 articles, mark the article as `is_trap: true` and write a query that **looks** answerable by this article but actually requires a different one. These are filtered or repurposed during assembly. Example: an article about "permisos retribuidos por nacimiento" is a trap if the query asks specifically about adoption (which a sibling article covers).

If you can't think of a clean trap for a given article, just skip the trap flag — better no trap than a bad trap.

## Output schema (JSONL, one row per article)

```jsonc
{
  "article": "BOE-A-1985-12666/atrescientossesentaynueve",   // norm_id + "/" + block_id, exact match to input
  "queries": [
    {"text": "¿cuándo cambia un juez de situación administrativa?", "register": "informal"},
    {"text": "¿Qué requisitos hay que cumplir para cambiar de situación administrativa en la carrera judicial?", "register": "formal"},
    {"text": "trámite cambio situación juez sin reingreso", "register": "procedural"}
  ],
  "is_trap": false
}
```

If an article is so generic, abstract, or fragmentary that you cannot ground a single citizen query on it (e.g. a one-line cross-reference, a definitions list with no real obligation), emit:

```jsonc
{"article": "...", "queries": [], "is_trap": false, "skip_reason": "fragment-only"}
```

These get dropped at assembly. Don't force a bad query just to fill a row.

## Few-shot examples

### Example article 1

```
norm_id: BOE-A-2015-11430
block_id: a48
title: Artículo 48. Permisos retribuidos.
text: Artículo 48. Permisos retribuidos.
1. El trabajador, previo aviso y justificación, podrá ausentarse del trabajo,
con derecho a remuneración, por alguno de los motivos y por el tiempo siguiente:
a) Quince días naturales en caso de matrimonio.
b) Dos días por el fallecimiento, accidente o enfermedad graves...
```

### Good output

```jsonl
{"article": "BOE-A-2015-11430/a48", "queries": [{"text": "cuantos dias libres me dan si me caso", "register": "informal"}, {"text": "¿Cuál es la duración del permiso retribuido por matrimonio?", "register": "formal"}, {"text": "permiso por fallecimiento de un familiar cuanto dura", "register": "informal"}], "is_trap": false}
```

### Bad output (don't do this)

```jsonl
{"article": "BOE-A-2015-11430/a48", "queries": [{"text": "¿Qué dice el artículo 48 del Estatuto de los Trabajadores?", "register": "formal"}, {"text": "permisos retribuidos artículo 48", "register": "formal"}], "is_trap": false}
```

(Both queries reference the article number — useless training signal.)

## Working notes for the agent

- Read your shard file (one JSON per line). For each row, parse and produce one output row.
- Append-only: write each output JSONL row as you finish that article, so partial progress is recoverable if anything fails.
- If you hit a row whose `text` looks empty, malformed, or non-Spanish, emit a `skip_reason` row and continue.
- Do NOT modify the input article batch.
- Aim for ~30 minutes wall-clock for 50 articles; queries don't need to be perfect on first pass.
- Match the `article` field byte-for-byte to the input — it's the join key during assembly.
