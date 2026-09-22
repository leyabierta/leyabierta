# SEO loop

An autonomous, biweekly loop that grows organic traffic to leyabierta.es from
real Google Search Console + Umami data. It proposes changes, has `claude -p`
implement them, verifies the build, and **opens a PR** — it never deploys on its
own. Governance lives in [`.goals/seo/`](../../.goals/seo/); current numbers and
running experiments in [`.goals/seo/STATUS.md`](../../.goals/seo/STATUS.md).

```
inspect-urls.ts ─► index-coverage.json ─┐
                                        ▼
pull-gsc.ts ─┐
             ├─► plan.ts ─► claude -p (implement) ─► verify ─► gh pr create
pull-umami.ts┘   (model)      apply plan            tsgo/biome/build
                    ▲
              benchmark.ts picks the model
```

Cloudflare (request volume, cache-hit ratio, AI Crawl Control's per-bot
breakdown, Worker invocations) has no pull script and doesn't need one: this
loop always runs from an interactive Claude Code session, never from an
unattended cron, so reading the dashboard through `claude-in-chrome` costs
nothing and needs no API token — see "Cloudflare" below.

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

## Cloudflare — read via `claude-in-chrome`, not a pull script

GSC says what Google sees, Umami says what humans do; Cloudflare says what
actually happened at the edge — request volume, cache-hit ratio, per-bot
traffic, and whether a Worker is trending toward its daily invocation cap.
There is deliberately **no `pull-*.ts` for it**: unlike GSC/Umami this loop
never runs unattended (no cron — see "The loop is manual on purpose" in the
skill), so every run already has a live `claude-in-chrome` session available,
and that reads the dashboard directly with no API token to create or rotate.
It also sees everything the dashboard sees, including AI Crawl Control. A
per-bot breakdown is also available from GraphQL, by grouping
`httpRequestsAdaptiveGroups` by `userAgent` (see below).

Check it as part of step 1 ("Where do we stand") whenever a Workers-limit
notice has landed, or periodically to catch one before it does:

| Dashboard page | What to read |
|----------------|---------------|
| Workers & Pages → `leyabierta-web` → Metrics | Requests today vs the Free plan's 100k/day cap, error rate |
| `leyabierta.es` zone → Analytics & Logs → Traffic | Total requests, cache-hit ratio |
| `leyabierta.es` zone → Security → AI Crawl Control | Per-bot breakdown — the only way to tell "AI crawlers backfilling the sitemap" from "something to actually rate-limit" |

**Exact numbers without a token: the dashboard's own GraphQL.** Screenshots of
charts are coarse. From any `dash.cloudflare.com` tab, run a `fetch` through
`javascript_tool` to `/api/v4/graphql` (with `credentials: 'include'`): it uses
the logged-in session, so no API token is needed. The account ID is in the
dashboard URL; the zone ID comes from `/api/v4/zones?name=leyabierta.es`.
Datasets that worked on the Free plan on 2026-09-22:

| Dataset | Scope | Useful for |
|---------|-------|------------|
| `workersInvocationsAdaptive` (`dimensions{date}`, `sum{requests subrequests}`) | account | Daily invocations vs the 100k cap |
| `workersSubrequestsAdaptiveGroups` (`dimensions{date hostname}`) | account | API load by day |
| `httpRequestsAdaptiveGroups` (≤1 day per query) | zone | Status codes, user agents, Googlebot per path, `cacheStatus` |

Two gotchas. `clientRequestQuery` is not available on Free, so the query-form
reform URLs all collapse into `/cambios/reforma/`. And since #164, Cache API
operations show up as their own rows (`requestSource: edgeWorkerCacheAPI`: a
504 on every `match` miss, a 204 `PUT` on every `put`). Filter
`requestSource: "eyeball"` or you'll read cache misses as outages.

The 2026-09-19/20 incident in `STATUS.md` is the worked example: GPTBot +
ClaudeBot made 126k of the week's requests against Googlebot's 741, which is
what turned "block the bots" into "fix the edge cache instead" (#164).

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
bun run scripts/seo/pull-umami.ts                 # on the server
SEO_UMAMI_SSH_HOST=KonarServer bun run scripts/seo/pull-umami.ts   # from a laptop
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
