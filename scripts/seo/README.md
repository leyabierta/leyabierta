# SEO loop

An autonomous, biweekly loop that grows organic traffic to leyabierta.es from
real Google Search Console + Umami data. It proposes changes, has `claude -p`
implement them, verifies the build, and **opens a PR** — it never deploys on its
own. Governance lives in [`.goals/seo/`](../../.goals/seo/).

```
pull-gsc.ts ─┐
             ├─► plan.ts ─► claude -p (implement) ─► verify ─► gh pr create
pull-umami.ts┘   (model)      apply plan            tsgo/biome/build
                    ▲
              benchmark.ts picks the model
```

## Files

| File | Role |
|------|------|
| `lib.ts` | Shared config, GSC auth (RS256 JWT), GSC query, Umami psql, chat client, PLAYBOOK path guard, types |
| `pull-gsc.ts` | Search Console → `data/seo/gsc-<date>.json` (deltas, striking-distance, low-CTR, rising, zero-click) |
| `pull-umami.ts` | Umami Postgres → `data/seo/umami-<date>.json` (pages, referrers, entries, countries) |
| `plan.ts` | `MODEL=provider:model` → structured JSON action plan (pure inference) |
| `benchmark.ts` | Run N models on one snapshot, gate + judge, write a leaderboard |
| `seo-loop.sh` | Orchestrator for the cron |

## Setup (KonarServer)

1. **GSC service account** with the Search Console API enabled, added as a user
   on the `leyabierta.es` property. Drop its key JSON on the server (mode 600).
2. **`/opt/leyabierta/.env.seo`** (mode 600):
   ```bash
   SEO_GSC_SA_JSON=/opt/leyabierta/leyabierta-seo.json
   OPENROUTER_API_KEY=sk-or-...
   NAN_API_KEY=sk-...            # optional, for nan:* models
   GH_TOKEN=github_pat_...       # Contents+PR write on leyabierta/leyabierta
   SEO_MODEL=openrouter:x-ai/grok-4.5
   ```
3. Umami needs no secret — it's read from the co-located `code-umami-db-1`
   container via `docker exec` (the loop runs on the same host).

## Run

```bash
# One snapshot + a plan (local)
SEO_GSC_SA_JSON=~/Downloads/…json bun run scripts/seo/pull-gsc.ts
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
