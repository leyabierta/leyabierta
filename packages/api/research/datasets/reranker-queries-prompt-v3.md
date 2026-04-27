# Reranker query generation prompt — v3 (scale-up)

Iteration over `reranker-queries-prompt-v2.md`. v2 hit 35/35/29 (formal/informal/procedural) on the 50-article pilot. Good for v2's 30/30/30 target, but **production query mix skews informal** (Google-style, lowercase, no accents), and we don't want the reranker under-trained on the most common citizen behavior.

What changed vs v2:
- **Target shifted from 30/30/30 to 30 formal / 40 informal / 30 procedural** — informal is plurality again (matches what we expect citizens to actually type), procedural stays covered, formal stays solid.
- **Informal register expanded**: it now explicitly covers two sub-flavours, "Google-style" (lowercase, no accents, abbreviations) and "natural Spanish" (lowercase but with accents, full words). Both are informal; both should appear.
- **Procedural target unchanged** at 30%, but the framing reminds the agent: 1 procedural per article is the *upper* end, not a quota — skip it cleanly when the article is purely declarative.
- **New rule**: aim for 3 queries per article when the article supports it. The skip-to-2 escape hatch stays for genuinely declarative articles, but the default expectation rises.

Everything else (schema, traps, anti-patterns) is unchanged.

---

## Task

You will receive a batch of legal articles from Spanish official legislation (BOE / autonomous community bulletins). For **each article**, generate **2 to 3 plausible citizen queries** in Spanish that this article answers. Default to 3 queries; drop to 2 only when the article doesn't naturally support a third register.

The queries become positives for training a cross-encoder reranker. Quality matters more than quantity.

## Register targets and definitions

Across the batch, aim for roughly **30% formal / 40% informal / 30% procedural**. Don't enforce per-article — enforce across the batch, the same way a citizen population produces a mix.

- **formal** (~30% of batch): full grammar, accents, citizen-but-careful tone. *"¿Cuál es el plazo de prescripción de los delitos contra la Hacienda Pública?"*

- **informal** (~40% of batch): how citizens actually type. Two flavours, both informal — mix them:
  - **Google-style**: lowercase, missing accents, abbreviations, fragmentary. *"cuanto tarda hacienda en reclamar"*, *"baja maternidad cuantos meses"*, *"despido improcedente indemnizacion"*
  - **Natural Spanish**: lowercase but with accents, full words, conversational. *"qué pasa si no pago una multa de tráfico"*, *"cuánto cobro de paro si me despiden"*

- **procedural** (~30% of batch): where / when / how / which-form / who-decides. Anchor on the action.
  - *"¿dónde presento el modelo 100?"*
  - *"plazo para recurrir una multa de tráfico"*
  - *"cómo solicito el certificado de antecedentes penales"*
  - *"qué documentos hacen falta para inscribir un nacimiento"*

**Procedural vs informal — sharp line:**
- Informal: *"cuánto cobro de paro"* (asks about a state/right).
- Procedural: *"dónde solicito el paro"* / *"cuándo se solicita el paro"* (asks about an action).

If the article is purely declarative (defines a right with no action verb), procedural may not fit — skip to 2 queries (1 formal + 1 informal) for that article.

## What "plausible citizen query" means

Imagine someone searching `cuanto me pagan en el paro` on Google, not a lawyer drafting a brief.

Avoid:
- Direct article paraphrases (`"¿Qué dice el artículo 369 de la LOPJ?"`).
- Queries that copy 4+ words from the article verbatim.
- Queries answerable by *any* article (`"¿qué es la ley?"`).
- Multi-question queries joined with "y" (split into two rows instead).
- Yes/no questions unless the article literally answers yes/no.
- Mentioning the BOE, the article number, or the law name — citizens don't know those.
- Stuffing every query with the formal `¿…?` punctuation. Real informal queries don't have it.

## Trap queries (~10% of articles)

For roughly 1 in 10 articles, mark `is_trap: true` with a query that *looks* answerable by this article but actually requires a different one. If you can't think of a clean trap, skip it.

## Output schema (JSONL, one row per article)

```jsonc
{
  "article": "BOE-A-1985-12666/atrescientossesentaynueve",
  "queries": [
    {"text": "cuando puede un juez cambiar de situacion administrativa", "register": "informal"},
    {"text": "¿Qué requisitos hay que cumplir para cambiar de situación administrativa en la carrera judicial?", "register": "formal"},
    {"text": "trámite cambio situación administrativa magistrado", "register": "procedural"}
  ],
  "is_trap": false
}
```

For pure fragments / cross-references / modifier-stubs:

```jsonc
{"article": "...", "queries": [], "is_trap": false, "skip_reason": "fragment-only"}
```

## Few-shot examples

### Example 1 — three-register article (default case)

```
norm_id: BOE-A-2015-11430
block_id: a48
title: Artículo 48. Permisos retribuidos.
text: 1. El trabajador, previo aviso y justificación, podrá ausentarse del trabajo,
con derecho a remuneración, por alguno de los motivos y por el tiempo siguiente:
a) Quince días naturales en caso de matrimonio.
b) Dos días por el fallecimiento, accidente o enfermedad graves...
```

Good output (informal Google-style + formal + procedural):

```jsonl
{"article": "BOE-A-2015-11430/a48", "queries": [{"text": "cuantos dias libres me dan si me caso", "register": "informal"}, {"text": "¿Cuál es la duración del permiso retribuido por matrimonio?", "register": "formal"}, {"text": "cómo aviso a mi empresa para solicitar permiso por matrimonio", "register": "procedural"}], "is_trap": false}
```

### Example 2 — declarative article (skip procedural)

```
norm_id: BOE-A-1978-31229
block_id: a14
title: Artículo 14
text: Los españoles son iguales ante la ley, sin que pueda prevalecer
discriminación alguna por razón de nacimiento, raza, sexo, religión, opinión
o cualquier otra condición o circunstancia personal o social.
```

Good output (informal natural-Spanish + formal — declarative right, no action):

```jsonl
{"article": "BOE-A-1978-31229/a14", "queries": [{"text": "tengo derecho a ser tratado igual aunque sea de otra religión", "register": "informal"}, {"text": "¿Qué derechos protege el principio de igualdad ante la ley en la Constitución española?", "register": "formal"}], "is_trap": false}
```

### Example 3 — bad output (don't do this)

```jsonl
{"article": "BOE-A-2015-11430/a48", "queries": [{"text": "¿Qué dice el artículo 48 del Estatuto de los Trabajadores?", "register": "formal"}, {"text": "¿permisos retribuidos artículo 48?", "register": "informal"}, {"text": "consultar artículo 48 ET", "register": "procedural"}], "is_trap": false}
```

(Article-number leakage in all three; "consultar" isn't a real procedural action; the second one labels itself informal but uses formal punctuation — that's not what informal means.)

## Working notes for the agent

- Read your shard file (one JSON per line). For each row, emit one output row.
- Append-only: write each output JSONL row as you finish that article.
- If `text` is empty/malformed, emit a `skip_reason` row.
- Match the `article` field byte-for-byte to the input.
- **At the end of your shard, eyeball the register distribution.** If your batch came out very off-target (e.g. 50% formal), your last few articles can rebalance — choose informal/procedural framings where the article supports them. Don't force fits, but don't ignore the target either.
- 50-article shards target ~6 minutes wall-clock. Quality > speed.
