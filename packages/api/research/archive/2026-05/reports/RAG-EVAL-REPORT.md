# RAG Evaluation Report — 2026-04-20

## Overview

Full evaluation of the RAG pipeline for Ley Abierta's citizen Q&A feature (`/pregunta`).
65 questions tested against 504 embedded laws (158,390 articles).

**Two metrics measured:**
- **Norm hit rate** (retrieval): does the response cite the expected law? → **95% (54/57)**
- **Answer accuracy** (quality): is the response factually correct? → **72% (42/58)**

The gap between retrieval (95%) and answer quality (72%) is the main finding.
Finding the right law doesn't guarantee giving the right answer.

---

## Eval Setup

- **Eval file**: `data/eval-answers-504-omnibus.json`
- **Questions**: 65 total (22 in `spike-questions.ts`, 43 in `spike-questions-hard.ts`)
  - 57 with expected norms (used for norm hit rate)
  - 6 out-of-scope (must decline)
  - 2 adversarial with no expected norm
- **Embeddings**: 504 laws, 158,390 articles (Gemini Embedding 2, 3072 dims)
- **Pipeline**: Vector + BM25 (with norm_title) → RRF (4 systems: vector, BM25, collection-density, recency) → boost (rank × jurisdiction × omnibus penalty × diversity penalty) → Cohere Rerank 4 Pro (top 15) → Gemini 2.5 Flash Lite synthesis
- **Eval metrics**: Checks citations array + inline norm mentions in answer text + equivalent norm IDs (ET 1995 = ET 2015)

### How we judged answer quality

Claude Opus 4.6 (this model) read every non-declined answer and evaluated:
1. Factual correctness against known Spanish law
2. Whether the answer addresses the citizen's question directly
3. Citizen-friendly language (no jargon)
4. Temporal accuracy (current law vs outdated versions)

No external LLM judge was used — evaluation was done directly in the Claude Code session.

---

## Retrieval Results (Norm Hit Rate)

### Progression through the session

| Config | Hit Rate | Notes |
|--------|----------|-------|
| Baseline (500 laws, no improvements) | ~59% | Sectoral/autonomous laws displace state laws |
| + Metadata-enriched reranker | ~76% | Reranker sees "Ley estatal" vs "Ley de Navarra" |
| + BM25 norm_title + jurisdiction fix | ~76% | BM25 matches law names, ELI-based jurisdiction |
| + 4 missing core laws embedded | ~83% | LAU, LOPDGDD, LETA, Ley Vivienda were missing! |
| + Collection density RRF | ~83% | Norms with more articles in pool rank higher |
| + Diversity penalty | ~95% | Diminishing returns per repeated norm |
| + Omnibus law penalty | **95%** | PGE/medidas urgentes deprioritized 0.15x |
| + Fair eval metrics | **95%** | Equivalent norms + inline citations counted |

### Critical discovery: missing laws

The original top-500-by-reforms selection excluded 4 fundamental laws:
- **BOE-A-1994-26003** (LAU — Ley de Arrendamientos Urbanos) — all rental questions failed
- **BOE-A-2018-16673** (LOPDGDD — Protección de Datos)
- **BOE-A-2007-13409** (LETA — Ley del Trabajo Autónomo)
- **BOE-A-2023-12203** (Ley de Vivienda 2023)

Also discovered the API was loading the 56-law embedding file instead of the 500-law file (wrong default path in `index.ts`). Fixed to `spike-embeddings-gemini-embedding-2-top500`.

### Remaining retrieval failures (3)

| Question | Expected | Got | Verdict |
|----------|----------|-----|---------|
| Q401 (fake article "847 del Código Laboral") | ET art.35 | Declined | Acceptable — better to decline than invent |
| Q608 (despido estando de baja) | ET | LGSS | LGSS covers IT benefits, ET covers dismissal. Borderline. |
| Q12 (deducción alquiler) | IRPF + LAU | PGE + DL autonómico | The deduction was modified/eliminated via PGE |

---

## Answer Quality Results

### Summary

| Metric | Count | Percentage |
|--------|-------|-----------|
| Factually correct (current law) | 42/58 | 72% |
| Outdated/wrong information | 8/58 | 14% |
| Partially correct (mix) | 8/58 | 14% |
| Good citizen-friendly language | 52/58 | 90% |

### CRITICAL problems

#### P1: Temporal accuracy — outdated information presented as current

**Q2 — "¿Cuánto dura la baja por paternidad?"**
- Answers: **5 semanas** (citing PGE 2018, BOE-A-2018-9268)
- Correct (2026): **19 semanas** (ET art.48.4, since 2025 reform)
- The system retrieves a PGE article from 2018 that set the transitional 5-week period. The consolidated ET has the current 19-week text, but the PGE text is more keyword-rich ("paternidad", specific numbers).
- **Root cause**: Old modifying laws (PGE) compete with the consolidated base law. The omnibus penalty (0.15x) helped get the ET into the pool, but the LLM synthesis still picks the specific number from the PGE over the generic consolidated text.

**Q12 — "¿Puedo deducirme el alquiler?"**
- Presents the 10.05% state deduction as currently available without mentioning it was **eliminated for post-2015 contracts**.
- Only applies to grandfathered pre-2015 contracts.

**Q22 — "¿Ha cambiado la paternidad?"**
- Messy historical narrative mixing old and new ET versions. Gets to 19 weeks eventually but the progression is confusing.

#### P2: Wrong legal conclusion from correct statute

**Q202 — "¿Puedo grabar a mi jefe sin que lo sepa?"**
- Answers: **"No, en general no puedes"**
- Correct (consolidated jurisprudence): **SÍ puedes** record conversations you participate in.
- The system reads the statute literally (CE art.18 protects privacy) but doesn't know the jurisprudential interpretation (the Supreme Court has consistently held that recording your own conversations is legal).
- **Root cause**: The system only has statutory text, not case law. This is a known and documented limitation.

#### P3: Buries the simple answer under exceptions

**Q1 — "¿Cuántos días de vacaciones?"**
- Leads with **22 días hábiles** (civil servant regulation, BOE-A-2019-7414)
- Should lead with **30 días naturales** (ET art.38, applies to most citizens)
- The ET answer appears later but is buried.
- **Root cause**: The Convenio AGE article scores high because it explicitly says "vacaciones" with specific numbers. The ET article uses more generic language. The synthesis prompt says "PRIORIDAD DE FUENTES: Ley general > ley sectorial" but the LLM doesn't always follow this when the sectoral source gives more specific data.

**Q4, Q9** — Similar pattern: correct national answer buried under regional exceptions (Navarra, Baleares, Galicia).

#### P4: Incomplete answers missing key protections

**Q608 — "Si me echan estando de baja"**
- Only discusses IT benefits continuation and unemployment.
- Misses the key point: dismissal during sick leave can be declared **NULO** (void) as discrimination under Ley 15/2022.
- **Root cause**: Ley 15/2022 may not be in the embeddings, and the retrieval focuses on the specific topic (IT benefits) rather than the broader protection.

### Excellent answers (for reference)

These answers demonstrate the system working at its best:

- **Q3** (subida alquiler): Correct, concise, cites LAU art.18, explains IPC limit
- **Q7** (despido improcedente): 33 days/year, max 24 months, readmission option. Perfect.
- **Q10** (paro autónomo): Comprehensive, cites LGSS arts. 327-347
- **Q13** (policía registrar móvil): Correct on CE art.18, mentions urgency exceptions
- **Q102** (despido embarazada): Clear nulidad explanation, cites ET art.55.5
- **Q304** (casero entrar piso): Perfect — CE art.18 + CP art.202
- **Q402** (contratos 3 años): Excellent corrective answer on 5/7 year minimum
- **Q403** (despido viernes): Perfectly debunks the myth
- **Q605** (despido por WhatsApp): Correct form requirements
- **Q801** (horas extra): Correct 80 hours/year maximum
- **Q804** (garantía producto): Correct 3 years

---

## Root Causes & Architectural Insights

### 1. Temporal contamination (highest priority)

The embedding store contains articles from modifying laws (PGE, decretos-ley de medidas) alongside consolidated base laws. These modifying articles:
- Are more keyword-rich (they explicitly name what changed: "paternidad, 5 semanas")
- Contain outdated transitional provisions
- Compete with the consolidated text that has the current version

**Current mitigation**: Omnibus penalty (0.15x boost for PGE/medidas titles). Helps but insufficient — the LLM synthesis still picks specific outdated numbers from the PGE text.

**Potential solutions**:
1. Remove modifying-law articles from embeddings entirely (aggressive)
2. Add `last_updated` date to embedded articles and instruct synthesis to prefer newest
3. In the synthesis prompt, add a rule: "When articles from different dates give different numbers, ALWAYS use the most recent one"
4. Tag articles as "consolidated" vs "amendment" in the evidence text

### 2. Synthesis doesn't follow source priority (medium priority)

The prompt says "Ley general > ley sectorial" but the LLM doesn't reliably follow this when a sectoral source gives more specific data. The Convenio AGE says "22 días hábiles" (specific) while the ET says "al menos 30 días naturales" (with caveats). The LLM leads with the more specific/confident-sounding answer.

**Potential solutions**:
1. Reorder evidence text: put state-level law articles FIRST in the evidence block
2. Add explicit header markers: `=== LEY BASE (ESTATAL) ===` vs `=== LEY COMPLEMENTARIA ===`
3. Stronger prompt instruction with examples

### 3. Jurisprudence blind spot (known limitation)

The system only has statutory text. Many legal questions depend on how courts interpret the statutes. Q202 (recording your boss) is the clearest example — the statute suggests "no" but courts consistently say "yes."

**Not fixable with current architecture.** Would need case law embeddings or a different approach. Should be documented clearly in disclaimers.

### 4. Embedding coverage (actionable)

504/12,236 laws (4%) means many citizen questions will hit laws not in the embeddings. The selection criterion (top by reforms) misses stable but important laws.

**Recommendation**: Embed all ~9,700 vigente laws. Estimated cost ~$19. The `embed-missing-laws.ts` script already supports incremental merging.

---

## Improvements Implemented This Session

### Retrieval improvements (all in `pipeline.ts`)
1. **Metadata-enriched reranker**: `describeNormScope(rank, jurisdiction)` in reranker title
2. **BM25 norm_title indexing**: FTS5 now includes norm title with weight 8.0 (`blocks-fts.ts`)
3. **Jurisdiction module**: `jurisdiction.ts` with `resolveJurisdiction()` using ELI URLs
4. **Jurisdiction-aware analyzer**: detects autonomous community mentions, adjusts boost
5. **Named-law lookup**: `resolveNormsByName()` for explicit law mentions
6. **Collection density RRF**: aggregate article scores by norm as 4th RRF system
7. **Diversity penalty**: diminishing returns per norm (1st: 1.0, 2nd: 0.7, 3rd: 0.5, 4th+: 0.3)
8. **Omnibus law penalty**: PGE/medidas urgentes get 0.15x boost for non-temporal questions
9. **4 missing core laws embedded**: LAU, LOPDGDD, LETA, Ley Vivienda ($0.02)
10. **Fixed embedding path**: API was loading 56-law file instead of 500-law file

### Eval improvements
1. **Fair metrics**: counts inline citations + equivalent norm IDs (old ET = new ET)
2. **Corrected expected norms**: Q5 accepts SMI RDs, Q606 accepts LEC
3. **Expanded questions**: +17 new questions (Q701-Q708 autonomous, Q801-Q809 diverse)
4. **Auto norm-hit calculation**: eval script computes and prints hit rate

---

## Recommendations for Next Session

### Priority 1: Fix temporal accuracy in synthesis
The synthesis LLM needs to prefer consolidated/current text over historical modifications.
Options:
- Evidence ordering: put state base laws first, modifying laws last
- Evidence headers: tag each article with its norm type and date
- Prompt engineering: explicit rule about preferring newest version when dates conflict
- The `norms.updated_at` field has the last consolidation date — use it

### Priority 2: Embed all vigente laws
~9,300 remaining vigente laws, ~$19 cost. Use `embed-missing-laws.ts` in batches.
This eliminates the coverage gap entirely.

### Priority 3: Evidence ordering in synthesis
Reorder the evidence text so state-level base laws appear first, sectoral/autonomous laws second, and omnibus/modifying laws last. The LLM naturally weighs earlier context more.

### Priority 4: Add disclaimer about jurisprudence
The system cannot reason about case law. Add to synthesis prompt and UI:
"Esta información se basa solo en el texto de la ley. La interpretación de los tribunales puede variar."

### Priority 5: Norm-level embeddings (optional)
If all vigente laws are embedded at article level, norm-level embeddings are less critical.
But they'd still help with source selection for large corpora (12K laws × ~400K articles).

---

## Files Reference

| File | Role |
|------|------|
| `packages/api/src/services/rag/pipeline.ts` | Main pipeline (all retrieval + synthesis logic) |
| `packages/api/src/services/rag/jurisdiction.ts` | Jurisdiction resolution (ELI URLs + bulletin prefixes) |
| `packages/api/src/services/rag/blocks-fts.ts` | BM25 FTS5 index (now includes norm_title) |
| `packages/api/src/services/rag/embeddings.ts` | Embedding generation + vector search |
| `packages/api/src/services/rag/reranker.ts` | Cohere reranker integration |
| `packages/api/src/services/rag/rrf.ts` | RRF fusion |
| `packages/api/research/eval-collect-answers.ts` | Eval runner (collects answers + computes metrics) |
| `packages/api/research/spike-questions.ts` | 22 base eval questions |
| `packages/api/research/spike-questions-hard.ts` | 43 hard/adversarial/autonomous eval questions |
| `packages/api/research/embed-missing-laws.ts` | Script to embed specific laws and merge into store |
| `data/eval-answers-504-omnibus.json` | Latest eval results (65 questions) |
| `data/spike-embeddings-gemini-embedding-2-top500.*` | Embedding store (504 laws, 158K articles) |
| `data/backup-embeddings/` | Backup of original embeddings before modifications |
