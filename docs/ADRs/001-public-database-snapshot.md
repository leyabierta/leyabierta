# ADR-001 — Public database snapshot

- Status: Accepted
- Date: 2026-04-26
- Sprint: 3 (Issue #14)

## Context

Ley Abierta has 13 GB of consolidated Spanish legislation in a single SQLite
database (`leyabierta.db`). The data has high research and journalistic
value: 12 251 norms, 567 005 blocks, 683 586 temporal versions, 43 813 reforms.
The repository policy is "open source forever, no monetization, no paywalls"
(see VISION.md), and Issue #14 asks to publish the database itself as a
downloadable artifact so anyone can build on top of it without scraping the
BOE or running the pipeline.

This ADR locks the format, hosting, cadence, retention, and privacy
guarantees. It also documents the alternatives we considered.

## Decision

### Format

- **SQLite + gzip** (`.db.gz`). Two files per snapshot:
  - `leyes-snapshot-YYYY-MM-DD.db.gz` — main product. All public tables
    except `embeddings`. Estimated ~2 GB compressed.
  - `leyes-embeddings-YYYY-MM-DD.db.gz` — only the `embeddings` table.
    Estimated ~3 GB compressed. Opt-in download for RAG / similarity work.
- The split lets users skip the 6.9 GB of vector blobs they don't need;
  rebuilding embeddings from scratch costs ~$200 in OpenRouter credits, so
  shipping them is high-value but they are not part of the canonical data.
- We do **not** ship a `.sql` text dump. Compressed binary is 5–10× smaller,
  every language has a SQLite driver, and downstream users that want SQL
  can produce one with `sqlite3 .dump`.

### Hosting

Primary: **Hugging Face Datasets** (`leyabierta/leyes-snapshot`).
Mirror: **archive.org** (item per snapshot, `leyabierta-snapshot-YYYY-MM-DD`,
collection `leyabierta`).

Why both:

| Concern | Hugging Face | archive.org |
|---|---|---|
| Discoverability (legaltech / data audience) | High (de facto registry for ML datasets) | Low |
| Egress cost | Free | Free |
| Permanent citable URL | Yes (commit-pinned) | Yes (canonical) |
| Versioning UX | Native (git-lfs backed) | Manual (item per snapshot) |
| Risk of vendor going dark | Medium (corporate, but currently committed to free hosting) | Very low (501(c)(3) non-profit since 1996) |
| Ideological alignment with "datos abiertos" | High | Very high |

The combination gives us discoverability + permanence at zero cost. Either
could go away without breaking the other.

### Alternatives considered (and rejected)

- **Cloudflare R2.** Was the original recommendation in the sprint plan.
  Rejected because (a) discoverability is zero — no one searches R2 for
  legal datasets — and (b) it ties open data to a single commercial
  provider with usage caps that we'd eventually have to manage.
- **Hetzner Storage Box.** ~3 €/month for 1 TB. Costs money, single
  provider, no discoverability, no public catalogue. Rejected.
- **IPFS.** Decentralized and verifiable but slow to retrieve and
  requires users to run a gateway or trust a public one. Operational
  complexity not justified for our scale.
- **GitHub Release attachments.** Hard 2 GB per-file limit; both our
  snapshots exceed that. Out.
- **Inside the `leyes` repo.** Git LFS would inflate clone times for
  the human-facing legislation repo; also caps on free LFS bandwidth.
  We keep `leyes` as a pure Markdown + git history repo, the way it is
  consumed today.

### Cadence

- **Weekly**, every Sunday, after the Sunday run of `daily-pipeline.sh`
  has finished. Spanish legislation moves slowly enough that a daily
  snapshot is overkill. Weekly produces 12 snapshots for the 3-month
  retention window, which is a comfortable balance of recency and
  storage cost.

### Retention

- The published manifest keeps the **last 12 snapshots** (≈ 3 months).
- Older snapshots remain accessible through the Hugging Face commit
  history and through their permanent archive.org item URLs. We don't
  delete the underlying files; we only stop listing them on `/datos`.

### Privacy / RGPD

The following tables are **always** stripped from the public snapshot
(both the main and the embeddings file). They contain personal data, free
text user input, or operational tracking with no third-party value:

- `subscribers` — emails + HMAC tokens for email alerts
- `ask_log` — text of `/v1/ask` queries (may contain user PII)
- `notified_reforms` — internal email-delivery tracking
- `norm_follows` — per-norm follow subscriptions (linked to subscriber id)
- `digests` — internal digest tracking
- `notification_runs` — cron-run bookkeeping

Removal is performed on the snapshot copy (never against production) by
`scripts/upload-db-snapshot.sh`, which then asserts the tables are
absent and `VACUUM`s the file. The list is duplicated in
`packages/api/src/__tests__/snapshot-private-tables.test.ts`, which fails
the build if the two lists drift.

If a future schema migration introduces a new table that contains
personal data, **adding it to the script's `PRIVATE_TABLES` array and
to the test fixture is part of the migration's definition of done.**

### Compatibility guarantees

- Schema drift between snapshots is tracked in `CHANGELOG.md` under the
  release that introduced the change. We commit to:
  - **Additive changes** (new tables, new columns) freely. They don't
    break readers of the previous schema.
  - **Renames or removals** of tables/columns get one release of warning
    in `/datos` and the README of the HF dataset before they ship.
- Embeddings (model, dimensionality, normalization) are versioned
  separately: see `embedding_model` and `embedding_dim` columns on
  the `embeddings` table.

### Licensing

- Legislative content: public domain (it is the Spanish state's official
  text, governed by Real Decreto Legislativo 1/1996 art. 13).
- SQLite structure, indexes, and AI-generated summaries: **CC0**.
- Required attribution for derivative work:
  > Fuente: Agencia Estatal Boletín Oficial del Estado — boe.es.
  > Estructura SQLite: Ley Abierta (CC0).

## Consequences

- A weekly cron job on KonarServer must run the upload script. Documented
  in the private `docs/infrastructure.md` (sibling repo). Not installed
  by this PR — the user installs it once HF + archive.org credentials are
  configured.
- Every release that touches the schema must update both the script's
  table list and the test fixture, or CI fails.
- Users that build on top of the snapshot get an explicit (additive)
  compatibility contract; we accept the tax of documenting schema changes.

## References

- Issue #14 — "Publicar leyabierta.db como descarga pública"
- VISION.md — open-source-forever, no-monetization principles
- `scripts/upload-db-snapshot.sh` — the implementation
- `packages/api/src/__tests__/snapshot-private-tables.test.ts` — test
  guarding the privacy invariants
- `packages/web/src/pages/datos.astro` — the public landing page
