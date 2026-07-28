# SEO loop

An autonomous, biweekly loop that grows organic traffic to leyabierta.es from
real Google Search Console + Umami data. It proposes changes, has `claude -p`
implement them, verifies the build, and **opens a PR** — it never deploys on its
own. Governance lives in [`.goals/seo/`](../../.goals/seo/).

```
inspect-urls.ts ─► index-coverage.json ─┐
                                        ▼
pull-gsc.ts ─┐
             ├─► plan.ts ─► claude -p (implement) ─► verify ─► gh pr create
pull-umami.ts┘   (model)      apply plan            tsgo/biome/build
                    ▲
              benchmark.ts picks the model
```

## Files

| File | Role |
|------|------|
| `lib.ts` | Shared config, GSC auth (RS256 JWT), Search Analytics (paginated), Sitemaps API, URL Inspection API, Umami psql, model chat client (`claude`/`nan`), PLAYBOOK path guard, types |
| `pull-gsc.ts` | Search Console → `data/seo/gsc-<date>.json` |
| `inspect-urls.ts` | URL Inspection sweep → `data/seo/inspections.json` + `index-coverage.json` |
| `pull-umami.ts` | Umami Postgres → `data/seo/umami-<date>.json` (pages, referrers, entries, countries) |
| `plan.ts` | `MODEL=provider:model` → structured JSON action plan (pure inference) |
| `benchmark.ts` | Run N models on one snapshot, gate + judge, write a leaderboard |
| `seo-loop.sh` | Orchestrator for the cron |

## What the GSC snapshot contains

`pull-gsc.ts` pulls the full Search Analytics surface, not a top-N slice —
query and page tables are paginated to exhaustion (25k rows/response).

| Block | What it answers |
|-------|-----------------|
| `totals` / `prevTotals` | 28-day window vs the previous one |
| `daily` | Day-by-day series — a trend, not just an average |
| `topQueries` / `risingQueries` / `fallingQueries` | What we rank for and which way it's moving |
| `strikingDistance` | Position 8–20 with real impressions — cheapest wins |
| `lowCtrQueries` | Ranking well, nobody clicks → title/meta problem |
| `topPages` / `zeroClickPages` / `lostPages` | Pages winning, pages seen but unclicked, pages that dropped out entirely |
| `pageQueries` | page × query pairs — what each page actually ranks for |
| `devices` / `countries` / `searchAppearance` | Audience splits and rich-result surfaces |
| `searchTypes` | Totals per surface (web/image/video/news/discover), zeros omitted |
| `sitemaps` | Submitted sitemaps with error and warning counts |
| `indexCoverage` | Rollup folded in from the last `inspect-urls.ts` run |

Every block past `zeroClickPages` is optional and degrades to `undefined` if the
API rejects it — a dimension Google stops supporting must not cost us the pull.

## Index coverage (`inspect-urls.ts`)

Search Analytics only sees pages that earn impressions. With ~12k law pages,
most earn none — and it cannot tell "not indexed" from "indexed but never
surfaced". The Inspection API can, so this script samples it.

Quota is **2000 inspections/day, 600/minute** per property, so a full sweep is
impossible in one run. It inspects three cohorts and rotates across runs via a
persistent cache (`inspections.json`):

1. **Key pages** — the hand-picked entry points, every run
2. **Ranking pages** — whatever `gsc-latest.json` currently gives impressions to
3. **Corpus sample** — law pages from `sitemap-leyes.xml`, oldest-inspected first

URLs checked within `SEO_INSPECT_REFRESH_DAYS` (default 14) are skipped so the
budget goes to unseen pages. On a 429 the run stops cleanly and saves what it
has rather than burning the day's allowance on retries.

| Env | Default | Purpose |
|-----|---------|---------|
| `SEO_INSPECT_BUDGET` | 500 | Max inspections per run |
| `SEO_INSPECT_CONCURRENCY` | 5 | In-flight requests |
| `SEO_INSPECT_PACE_MS` | 120 | Delay per worker between calls |
| `SEO_INSPECT_REFRESH_DAYS` | 14 | Re-inspect only after this many days |
| `SEO_INSPECT_REFORM_SAMPLE` | 600 | Cap on reform URLs per run (strided) |

`index-coverage.json` reports `indexedRate`, `medianCrawlAgeDays`,
`neverCrawled`, breakdowns by verdict / coverage state / fetch state,
canonical mismatches, and the worst offenders.

### Cohorts

`byCohort` splits every rate by page type, because the aggregate hides the
thing you need to act on. It reports **`crawlRate` alongside `rate`**: Google
must fetch a page before it can judge it, so a cohort stuck at zero crawls is a
different problem from one that's crawled and rejected.

| Cohort | What it is |
|--------|-----------|
| `ley` | `/leyes/<id>/` — the 12k law pages |
| `reforma-path` | 2026 reforms on `/cambios/reforma/<id>/<date>/` (treatment) |
| `reforma-query` | Everything else on `?id=&date=` (control) |
| `clave` | The hand-picked entry points |

The reform split is the **URL-shape experiment** (see
`packages/web/src/lib/reform-experiment.ts`). Baseline on 2026-07-28, before the
change: `ley` 13.2% indexed / 99% crawled, reforms 0% indexed and **0% crawled**
— not one of 600 had ever been fetched. If `reforma-path` starts getting crawled
while `reforma-query` stays at zero, the query-string URL shape was the blocker
and the remaining ~34k should follow.

> `sitemaps[].contents[].indexed` is always `0`. Google stopped populating it
> through the API years ago but still returns the field. Never read it as a
> coverage signal — that's what `indexCoverage` is for.

## Models (no OpenRouter — no metered spend)

`MODEL`/`MODELS`/`JUDGE_MODEL` use `provider:model`:

| Provider | How | Examples |
|----------|-----|----------|
| `claude` | local `claude -p` CLI (subscription) | `claude:sonnet`, `claude:opus` |
| `nan` | api.nan.builders, OpenAI-compatible (`NAN_API_KEY`) | `nan:deepseek-v4-flash`, `nan:qwen3.6`, `nan:mimo-v2.5` |

Production contest: **`claude:sonnet` vs `nan:deepseek-v4-flash`**, judged by `claude:opus`.

## Setup (KonarServer)

1. **GSC service account** with the Search Console API enabled, added as a user
   on the `leyabierta.es` property. Drop its key JSON on the server (mode 600).
2. **`/opt/leyabierta/.env.seo`** (mode 600):
   ```bash
   SEO_GSC_SA_JSON=/opt/leyabierta/leyabierta-seo.json
   NAN_API_KEY=sk-...            # valid NaN token (the one ending pcNg)
   GH_TOKEN=github_pat_...       # Contents+PR write on leyabierta/leyabierta
   SEO_MODEL=claude:sonnet       # or nan:deepseek-v4-flash
   ```
   `claude:*` models and the implement step need the Claude CLI authenticated on
   the host (`CLAUDE_CODE_OAUTH_TOKEN` or a prior `claude` login).
3. Umami needs no secret — it's read from the co-located `code-umami-db-1`
   container via `docker exec` (the loop runs on the same host).

## Run

```bash
# One snapshot + a plan (local)
SEO_GSC_SA_JSON=~/Downloads/…json bun run scripts/seo/pull-gsc.ts
SEO_INSPECT_BUDGET=400 bun run scripts/seo/inspect-urls.ts   # coverage sweep
bun run scripts/seo/pull-umami.ts                 # on the server, or SEO_UMAMI_ARGV to ssh
MODEL=openrouter:x-ai/grok-4.5 bun run scripts/seo/plan.ts

# Benchmark models on the same snapshot
MODELS="nan:qwen3.6,openrouter:x-ai/grok-4.5,openrouter:deepseek/deepseek-v4-flash" \
  bun run scripts/seo/benchmark.ts

# Full loop (dry run: no push/PR)
SEO_DRY_RUN=1 bash scripts/seo/seo-loop.sh
```

## Cron (biweekly, Europe/Madrid — see docs/infrastructure.md for the TZ note)

```
# /etc/cron.d/leyabierta-seo  — 04:00 on the 1st and 15th
0 4 1,15 * * adminuser /opt/leyabierta/code/scripts/seo/seo-loop.sh >> /opt/leyabierta/logs/seo-loop.log 2>&1
```

Model selection (`nan:*` vs `openrouter:*`) is decided by `benchmark.ts`; the
production planner is whatever `SEO_MODEL` is set to in `.env.seo`.
