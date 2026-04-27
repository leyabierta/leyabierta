# Reranker query generation prompt — v2 (procedural-focused)

Iteration over `reranker-queries-prompt.md` (v1) to address the v1 pilot's procedural register being under target (9% v1 actual vs 20% target). Same articles, same schema; only the prompt copy differs so the diff is interpretable.

What changed vs v1:
- Procedural register target raised from 20% to 30% (one query per article should be procedural when realistic).
- More procedural few-shot examples: forms, deadlines, where-to-file, who-decides.
- Negative few-shot: explicit "this is NOT procedural" example to anchor the distinction.
- Slightly tighter informal-procedural border (informal = "what is X", procedural = "where/when/how do I do X").

---

## Task

You will receive a batch of legal articles from Spanish official legislation (BOE / autonomous community bulletins). For **each article**, generate **2 to 3 plausible citizen queries** in Spanish that this article answers.

The queries become positives for training a cross-encoder reranker. Quality matters more than quantity.

## What "plausible citizen query" means

Imagine someone searching `cuanto me pagan en el paro` on Google, not a lawyer. Mix three registers; **at least one query per article should be procedural when the article supports it**.

- **formal** (~30%): full grammar, accents. *"¿Cuál es el plazo de prescripción de los delitos contra la Hacienda Pública?"*
- **informal** (~40%): how citizens actually type. Lowercase fine, missing accents fine. *"cuanto tarda hacienda en reclamar"*, *"baja maternidad cuantos meses"*, *"despido improcedente indemnizacion"*
- **procedural** (~30%, target): where / when / how / which-form / who-decides. Anchor on the action, not the concept.
  - *"¿dónde presento el modelo 100?"*
  - *"plazo para recurrir una multa de tráfico"*
  - *"cómo solicito el certificado de antecedentes penales"*
  - *"qué documentos hacen falta para inscribir un nacimiento"*
  - *"quién resuelve un recurso de alzada en hacienda"*
  - *"a qué órgano se dirige una queja por sanción tributaria"*

**Procedural vs informal — sharper line:**
- Informal: *"cuánto cobro de paro"* (asks about a state/right).
- Procedural: *"dónde solicito el paro"* / *"cuándo se solicita el paro"* (asks about an action).

If the article is purely declarative (defines a right with no action verb), procedural may not fit — that's fine, skip it for that article and stay 2 queries.

Avoid:
- Direct article paraphrases (`"¿Qué dice el artículo 369 de la LOPJ?"`).
- Queries that copy 4+ words from the article verbatim.
- Queries answerable by *any* article.
- Multi-question queries joined with "y".
- Yes/no questions unless the article literally answers yes/no.
- Mentioning the BOE, the article number, or the law name.

## Trap queries (~10% of rows)

For roughly 1 in 10 articles, mark `is_trap: true` with a query that *looks* answerable by this article but actually requires a different one. If you can't think of a clean trap, skip it for that article.

## Output schema (JSONL, one row per article)

```jsonc
{
  "article": "BOE-A-1985-12666/atrescientossesentaynueve",
  "queries": [
    {"text": "¿cuándo cambia un juez de situación administrativa?", "register": "informal"},
    {"text": "¿Qué requisitos hay que cumplir para cambiar de situación administrativa en la carrera judicial?", "register": "formal"},
    {"text": "trámite cambio situación administrativa magistrado", "register": "procedural"}
  ],
  "is_trap": false
}
```

Skip a row that's purely a fragment / cross-reference:

```jsonc
{"article": "...", "queries": [], "is_trap": false, "skip_reason": "fragment-only"}
```

## Few-shot examples

### Example 1 — article with procedural support

```
norm_id: BOE-A-2015-11430
block_id: a48
title: Artículo 48. Permisos retribuidos.
text: 1. El trabajador, previo aviso y justificación, podrá ausentarse del trabajo,
con derecho a remuneración, por alguno de los motivos y por el tiempo siguiente:
a) Quince días naturales en caso de matrimonio.
b) Dos días por el fallecimiento, accidente o enfermedad graves...
```

Good output (1 informal + 1 formal + 1 procedural):

```jsonl
{"article": "BOE-A-2015-11430/a48", "queries": [{"text": "cuantos dias libres me dan si me caso", "register": "informal"}, {"text": "¿Cuál es la duración del permiso retribuido por matrimonio?", "register": "formal"}, {"text": "cómo aviso a mi empresa para solicitar permiso por matrimonio", "register": "procedural"}], "is_trap": false}
```

The procedural query asks about the *action* (avisar a la empresa) the article mentions ("previo aviso y justificación").

### Example 2 — article that doesn't naturally support procedural

```
norm_id: BOE-A-1978-31229
block_id: a14
title: Artículo 14
text: Los españoles son iguales ante la ley, sin que pueda prevalecer
discriminación alguna por razón de nacimiento, raza, sexo, religión, opinión
o cualquier otra condición o circunstancia personal o social.
```

Good output (only informal + formal — declarative right, no action to procedure on):

```jsonl
{"article": "BOE-A-1978-31229/a14", "queries": [{"text": "tengo derecho a ser tratado igual aunque sea de otra religion", "register": "informal"}, {"text": "¿Qué derechos protege el principio de igualdad ante la ley en la Constitución española?", "register": "formal"}], "is_trap": false}
```

### Example 3 — bad output (don't do this)

```jsonl
{"article": "BOE-A-2015-11430/a48", "queries": [{"text": "¿Qué dice el artículo 48 del Estatuto de los Trabajadores?", "register": "formal"}, {"text": "permisos retribuidos artículo 48", "register": "informal"}, {"text": "consultar artículo 48 ET", "register": "procedural"}], "is_trap": false}
```

(Article-number leakage in all three; "consultar" isn't a real procedural action.)

## Working notes for the agent

- Read your shard file (one JSON per line). For each row, emit one output row.
- Append-only: write each output JSONL row as you finish that article.
- If `text` is empty/malformed, emit a `skip_reason` row.
- Match the `article` field byte-for-byte to the input.
- Aim for ~30 minutes wall-clock for 50 articles.
- **Internal mental check before emitting**: if your three queries are all "what is X" framings, replace one with a "where/when/how do I" reframe — unless the article truly has no action the citizen could take or trace.
