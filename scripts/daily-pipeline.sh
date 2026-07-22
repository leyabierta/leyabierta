#!/bin/bash
# Unified daily pipeline — all steps sequential, fail-fast.
# Replaces the old split cron jobs (update-db.sh, generate-ai.sh, send-notifications.sh).
#
# Usage: /opt/leyabierta/scripts/daily-pipeline.sh
# Cron:  30 8 * * * /opt/leyabierta/scripts/daily-pipeline.sh
#
# Logging — under cron this script takes ownership of $LOG with a single
# `exec >> "$LOG" 2>&1` and log() is a plain echo. Before, log() piped through
# `tee -a "$LOG"`: it wrote the line to the file AND to stdout, which
# /etc/cron.d/leyabierta independently appends to the same file
# (`... >> /opt/leyabierta/logs/daily-pipeline.log 2>&1`, see
# docs/infrastructure.md) — so every log() line landed twice. Both handles are
# O_APPEND, so leaving the cron redirect in place is harmless; removing it is
# optional cleanup, not required. The redirect is skipped when stdout is a TTY
# so an operator running this by hand over SSH still sees output instead of a
# silent terminal.

SCRIPT_PATH="$(readlink -f "$0")"
REPO_DIR=/opt/leyabierta/code
SCRIPT_IN_REPO="$REPO_DIR/scripts/daily-pipeline.sh"
LOG=/opt/leyabierta/logs/daily-pipeline.log
CONTAINER=code-api-1
ENV_FILE=/opt/leyabierta/code/.env.prod
LEYES_DIR_CONTAINER=/data/leyes
DIVERGENCE_CEILING=200  # abort push if local is ahead by more than this; alert + investigate
# How old the deployed commit (refs/tags/prod) may get before we alert.
# Measured in DAYS, deliberately not in "commits behind origin/main": main
# takes web/SEO/API commits every day that never touch this script, so a commit
# count would alert every week and train everyone to ignore it.
STALE_DEPLOY_MAX_AGE_DAYS=${STALE_DEPLOY_MAX_AGE_DAYS:-14}
# Hard wall-clock cap on the network git calls made before the lock is taken.
GIT_NET_TIMEOUT=${GIT_NET_TIMEOUT:-120}

# Ensure the log directory exists BEFORE any code that might log (the
# `exec` below and the lock guard being the first such cases on a fresh server).
mkdir -p "$(dirname "$LOG")"

# ── Rotate the log if it has grown past the cap ─────────────────────────────
# Done here rather than via /etc/logrotate.d because that needs root on the
# server and lives outside this repo — this is one moving part instead of two,
# and it ships with the script. Rotation happens BEFORE the exec below so the
# run always appends to a freshly rotated file. One generation is plenty: the
# interesting history is in this log's own output, not in months of archive.
LOG_MAX_BYTES=${LOG_MAX_BYTES:-52428800}  # 50 MB
if [ -f "$LOG" ]; then
  log_size=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  if [ "$log_size" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || true
  fi
fi

# Own the log file for the rest of the run — see the header comment above.
if [ ! -t 1 ]; then
  exec >> "$LOG" 2>&1
fi

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"; }

# scrub TEXT — mask embedded credentials and cap length before git output is
# shipped to a webhook. A git remote can legitimately carry a token in its URL
# (the same pattern this script uses for the leyes remote below) and git prints
# the remote URL on auth failures, so raw stderr must never be forwarded.
scrub() {
  local s
  s=$(printf '%s' "$1" | tr '\n' ' ' | sed -E 's#(https?://)[^/@[:space:]]+@#\1***@#g' 2>/dev/null) || s="$1"
  printf '%s' "${s:0:400}"
}

# git_net ARGS... — git with a hard timeout, for anything that touches network.
git_net() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$GIT_NET_TIMEOUT" git "$@"
  else
    git "$@"
  fi
}

# build_alert_json TITLE BODY — emits a valid JSON object on stdout.
# Prefers python3 (always present on Ubuntu/Debian VPS) for correct escaping
# of quotes, backslashes, control chars, and unicode. Falls back to jq, then
# to a manual best-effort escape if neither is installed.
build_alert_json() {
  local title="$1" body="$2"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.dumps({"title":sys.argv[1],"body":sys.argv[2],"host":"KonarServer"}))' \
      "$title" "$body"
  elif command -v jq >/dev/null 2>&1; then
    jq -nc --arg t "$title" --arg b "$body" '{title:$t, body:$b, host:"KonarServer"}'
  else
    local et=${title//\\/\\\\}; et=${et//\"/\\\"}
    local eb=${body//\\/\\\\}; eb=${eb//\"/\\\"}
    printf '{"title":"%s","body":"%s","host":"KonarServer"}' "$et" "$eb"
  fi
}

# send_alert TITLE BODY — POST a JSON alert to ALERT_WEBHOOK_URL (non-fatal).
# Defined before the self-update guard (and before ENV_FILE is parsed further
# down) so a failed self-update can alert just as loudly as a failed step.
# Uses ALERT_WEBHOOK_URL when already exported, otherwise reads it straight out
# of ENV_FILE. Falls back silently if neither yields a URL or curl fails.
send_alert() {
  local title="$1" body="$2"
  local webhook="${ALERT_WEBHOOK_URL:-}"
  if [ -z "$webhook" ] && [ -r "$ENV_FILE" ]; then
    webhook=$(grep -E '^ALERT_WEBHOOK_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  fi
  if [ -n "$webhook" ]; then
    local json
    json=$(build_alert_json "$title" "$body")
    curl -fsS --max-time 10 -X POST "$webhook" \
      -H "Content-Type: application/json" \
      -d "$json" \
      >/dev/null 2>&1 || true
  fi
}

# ── Self-update: pull latest version from the prod tag before doing anything ──
# Runs BEFORE set -euo pipefail and BEFORE the lockfile so that even a stale
# on-disk copy of this script can bootstrap itself to the current version.
# LEYABIERTA_SELF_UPDATED=1 breaks the re-exec loop (set by child after update).
#
# Both branches used to swallow stderr (`2>/dev/null`, `>/dev/null 2>&1`) with
# no else-branch, so a broken fetch or reset silently left whatever copy was on
# disk running forever. Every failure is now logged and alerted.
if [ -z "${LEYABIERTA_SELF_UPDATED:-}" ] && [ -d "$REPO_DIR/.git" ]; then
  self_update_ok=0
  # Fetch the prod tag with explicit refspec so a force-updated remote tag
  # always overrides the local one. `git fetch --tags` (without --force) is
  # NOT enough — it silently keeps an existing local tag pointing to an old
  # commit, so self-update would never advance.
  su_err=$(git_net -C "$REPO_DIR" fetch --quiet origin "+refs/tags/prod:refs/tags/prod" 2>&1) && su_status=0 || su_status=$?
  if [ "$su_status" -ne 0 ]; then
    log "  ✗ self-update: fetch refs/tags/prod failed (exit $su_status): $(scrub "$su_err")"
    send_alert "leyabierta self-update failed" "git fetch refs/tags/prod failed (exit $su_status): $(scrub "$su_err")"
  else
    su_err=$(git -C "$REPO_DIR" reset --hard refs/tags/prod 2>&1) && su_status=0 || su_status=$?
    if [ "$su_status" -ne 0 ]; then
      log "  ✗ self-update: reset --hard refs/tags/prod failed (exit $su_status): $(scrub "$su_err")"
      send_alert "leyabierta self-update failed" "git reset --hard refs/tags/prod failed (exit $su_status): $(scrub "$su_err")"
    else
      self_update_ok=1
      if [ -f "$SCRIPT_IN_REPO" ] && ! cmp -s "$SCRIPT_PATH" "$SCRIPT_IN_REPO"; then
        log "  → self-update: newer daily-pipeline.sh at refs/tags/prod — re-exec'ing"
        export LEYABIERTA_SELF_UPDATED=1
        exec "$SCRIPT_IN_REPO" "$@"
      fi
    fi
  fi
  if [ "$self_update_ok" -ne 1 ]; then
    log "  ⚠ self-update: continuing with the on-disk copy at $SCRIPT_PATH — version may be stale"
  fi
fi

# ── Single-instance lock ────────────────────────────────────────────────────
# Prevents concurrent runs from racing on the leyes git working tree
# (root cause of duplicate commits seen in production before 2026-04-27).
LOCKFILE=/var/lock/leyabierta-pipeline.lock
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  log "another pipeline run is in progress — skipping"
  exit 0
fi

# ── Record which commit is actually running, and how old it is ──────────────
# Runs AFTER the lock so a run that immediately bails out never fires a
# staleness alert. Needs no network: the deployed commit's own date is enough.
#
# The heartbeat at the bottom only ever meant "the script that happened to run
# finished". It said nothing about WHICH version ran, so it stayed green for
# weeks while refs/tags/prod sat on an old commit and Step 10 (PR #110) never
# executed. Logging the SHA every run makes that visible; an old deploy raises
# its own alert.
#
# Deliberately NOT wired into the heartbeat. The heartbeat is the liveness
# signal for steps 1-8 (including the daily emails). Suppressing it for a
# stale-but-working pipeline would page for the wrong thing, keep the monitor
# permanently red (nothing moves the prod tag automatically today, so it would
# stay red until a human acts), and make a genuinely dead pipeline
# indistinguishable from an un-moved tag. Staleness gets its own channel.
PIPELINE_SHA=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)
DEPLOY_AGE_DAYS=unknown
deploy_ts=$(git -C "$REPO_DIR" log -1 --format=%ct HEAD 2>/dev/null || true)
if [ -n "${deploy_ts:-}" ]; then
  DEPLOY_AGE_DAYS=$(( ( $(date -u +%s) - deploy_ts ) / 86400 ))
fi
log "running pipeline SHA=$PIPELINE_SHA deploy-age=${DEPLOY_AGE_DAYS}d (max=${STALE_DEPLOY_MAX_AGE_DAYS}d)"
if [ "$DEPLOY_AGE_DAYS" != "unknown" ] && [ "$DEPLOY_AGE_DAYS" -gt "$STALE_DEPLOY_MAX_AGE_DAYS" ]; then
  log "  ⚠ deployed commit is ${DEPLOY_AGE_DAYS} days old — refs/tags/prod has not moved; newer pipeline steps may not be running"
  send_alert "leyabierta prod tag is stale" "running SHA=$PIPELINE_SHA is ${DEPLOY_AGE_DAYS} days old (max ${STALE_DEPLOY_MAX_AGE_DAYS}d) — move refs/tags/prod forward"
fi

set -euo pipefail

# Extract ONLY the LEYES_PUSH_TOKEN from .env.prod for the push step. Avoid
# `set -a; source ...` because that exports every secret in the file
# (Resend, OpenRouter, ALERTS_SECRET, etc.) into the environment of every
# subsequent `docker exec` call — much wider blast radius than necessary.
if [ -r "$ENV_FILE" ]; then
  LEYES_PUSH_TOKEN=$(grep -E '^LEYES_PUSH_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  BETTERSTACK_HEARTBEAT_URL=$(grep -E '^BETTERSTACK_HEARTBEAT_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  ALERT_WEBHOOK_URL=$(grep -E '^ALERT_WEBHOOK_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  export LEYES_PUSH_TOKEN BETTERSTACK_HEARTBEAT_URL ALERT_WEBHOOK_URL
fi

log "=== Daily pipeline started ==="

# ── Step 1: Pipeline bootstrap (BOE → markdown + git commits) ──────────────
log "→ Step 1: Pipeline bootstrap"
docker exec "$CONTAINER" bun run pipeline bootstrap --country es --concurrency 2 >> "$LOG" 2>&1
log "  ✓ Pipeline done"

# ── Step 1.5: Push leyes repo to GitHub ─────────────────────────────────────
# Decoupled from AI/email steps: the law text is the product, AI enrichment is
# additive. Pushing here triggers the web rebuild ASAP. Push failure does NOT
# block the rest of the pipeline (DB ingest still runs, API stays current).
# Run a git command inside the container. Network-touching ops (fetch/push/pull)
# get LEYES_PUSH_TOKEN forwarded + an inline credential helper that supplies it
# to the HTTPS remote. The token never lands on disk and never appears in
# `ps`/`docker inspect` (it's piped via -e env var, not a CLI argument).
git_in_container() {
  docker exec -e LEYES_PUSH_TOKEN="${LEYES_PUSH_TOKEN:-}" "$CONTAINER" \
    git -c "credential.helper=!f() { echo username=x-access-token; echo password=\$LEYES_PUSH_TOKEN; }; f" \
        -C "$LEYES_DIR_CONTAINER" "$@"
}

push_leyes() {
  local ahead behind sha_before sha_after

  if [ -z "${LEYES_PUSH_TOKEN:-}" ]; then
    log "  ✗ LEYES_PUSH_TOKEN not set in $ENV_FILE — cannot push"
    return 1
  fi

  # Ensure git identity exists inside the container so any rebase that needs
  # to create commits (merge resolution, signoff, etc.) doesn't fail.
  # `pipeline bootstrap` sets author via GIT_AUTHOR_* env vars at commit time
  # so this only kicks in for our own git operations.
  git_in_container config user.name  "Ley Abierta Bot" >> "$LOG" 2>&1 || true
  git_in_container config user.email "bot@leyabierta.es" >> "$LOG" 2>&1 || true

  sha_before=$(git_in_container rev-parse HEAD 2>/dev/null || echo "<unknown>")
  log "  HEAD before push: $sha_before"

  # Fetch first to know how far we've drifted from origin
  if ! git_in_container fetch origin main >> "$LOG" 2>&1; then
    log "  ✗ git fetch failed — aborting push attempt"
    return 1
  fi

  ahead=$(git_in_container rev-list --count origin/main..HEAD)
  behind=$(git_in_container rev-list --count HEAD..origin/main)
  log "  divergence: ahead=$ahead behind=$behind (ceiling=$DIVERGENCE_CEILING)"

  if [ "$ahead" -gt "$DIVERGENCE_CEILING" ]; then
    log "  ✗ ABORT: local is ahead by $ahead (ceiling $DIVERGENCE_CEILING). Manual intervention required."
    log "    Investigate /opt/leyabierta/data/leyes before next run."
    send_alert "leyes divergence ceiling exceeded" "ahead=$ahead ceiling=$DIVERGENCE_CEILING — manual intervention required"
    return 1
  fi

  if [ "$ahead" = "0" ] && [ "$behind" = "0" ]; then
    log "  nothing to push (already in sync)"
    return 0
  fi

  # ahead=0/behind>0: nothing local to publish. Just fast-forward and return —
  # no need to round-trip a no-op push.
  if [ "$ahead" = "0" ] && [ "$behind" -gt "0" ]; then
    log "  remote has $behind unseen commits, nothing local to publish — fast-forwarding"
    if ! git_in_container pull --ff-only origin main >> "$LOG" 2>&1; then
      log "  ✗ fast-forward failed — manual intervention required"
      return 1
    fi
    log "  ✓ fast-forwarded"
    return 0
  fi

  if [ "$behind" -gt "0" ]; then
    log "  remote has $behind unseen commits — rebasing $ahead local commits on top"
    if ! git_in_container pull --rebase origin main >> "$LOG" 2>&1; then
      log "  ✗ rebase failed — manual intervention required"
      git_in_container rebase --abort >> "$LOG" 2>&1 || true
      return 1
    fi
  fi

  if ! git_in_container push origin main >> "$LOG" 2>&1; then
    log "  ✗ push failed — will retry on next pipeline run"
    return 1
  fi

  sha_after=$(git_in_container rev-parse HEAD 2>/dev/null || echo "<unknown>")
  log "  ✓ push OK ($ahead local commits published, HEAD=$sha_after)"
  return 0
}

log "→ Step 1.5: Push leyes to GitHub"
# Run without set -e so push failure doesn't kill the rest of the pipeline
set +e
push_leyes
push_status=$?
set -e
if [ "$push_status" -ne 0 ]; then
  log "  ⚠ push failed (status $push_status). DB ingest + AI steps will continue."
  send_alert "leyes push failed" "exit=$push_status — will retry in step 9"
fi

# ── Step 2: Ingest JSON → SQLite ────────────────────────────────────────────
log "→ Step 2: Ingest"
docker exec "$CONTAINER" bun run ingest >> "$LOG" 2>&1
log "  ✓ Ingest done"

# ── Step 2.5: Refresh BOE auxiliary reference tables (materias, ...) ────────
# ingest-analisis (Step 3) maps BOE materia codes to names via
# data/auxiliar/materias.json. NOTHING ever downloaded that file, so on this
# server it never existed and Step 3 wrote fabricated "[código NNNN]" strings
# for every materia of every norm (2026-07-22 incident).
#
# Non-fatal by design. Step 3 degrades safely without the lookup (it omits
# unresolved codes and never fabricates), and this script runs under
# `set -euo pipefail`, so aborting here would also skip Steps 4-8 — including
# the subscriber emails. Stale/missing reference data for one day is cheaper
# than a day with no product output. (`if` already suppresses `set -e` for the
# command it tests, so no branch below can abort the run.)
#
# Writes to ./data/auxiliar inside the container, which resolves through
# /app/data -> /data (Dockerfile) into the `./data:/data` bind mount
# (docker-compose.yml), so the file survives restarts and Watchtower rolls.
log "→ Step 2.5: Refresh BOE auxiliary tables (materias, departamentos, ...)"
if docker exec "$CONTAINER" bun run download-auxiliar >> "$LOG" 2>&1; then
  log "  ✓ Auxiliary tables refreshed"
elif docker exec "$CONTAINER" bun run download-auxiliar --check >> "$LOG" 2>&1; then
  log "  ⚠ download-auxiliar failed — falling back to the existing (possibly stale) materias.json"
  send_alert "download-auxiliar failed" "Falling back to the cached materias.json. Check BOE datosabiertos availability."
else
  log "  ⚠ download-auxiliar failed and no usable materias.json cache exists — Step 3 will run degraded (materias omitted, never placeholdered)"
  send_alert "download-auxiliar failed, no cache" "ingest-analisis will not resolve materia codes this run. Data is not corrupted, but new materias are missing until this is fixed."
fi

# ── Step 3: Ingest analisis (materias, notas, refs from BOE) ────────────────
log "→ Step 3: Ingest analisis"
docker exec "$CONTAINER" bun run ingest-analisis >> "$LOG" 2>&1
log "  ✓ Ingest-analisis done"

# ── Step 3b: RAG — embed any vigente articles missing qwen3-nan embeddings ──
# Incremental: no-op when nothing new. Keeps /v1/ask in sync with newly
# ingested norms. Requires HERMES_API_KEY (or NAN_API_KEY) in .env.prod.
log "→ Step 3b: Embed new corpus chunks (qwen3-nan via NaN)"
docker exec "$CONTAINER" bun run packages/api/src/scripts/embed-corpus.ts >> "$LOG" 2>&1
log "  ✓ Embed corpus done"

# ── Step 4: AI — reform summaries ───────────────────────────────────────────
log "→ Step 4: Reform summaries"
docker exec "$CONTAINER" bun run packages/api/src/scripts/generate-reform-summaries.ts >> "$LOG" 2>&1
log "  ✓ Reform summaries done"

# ── Step 5: AI — citizen tags & summaries ───────────────────────────────────
log "→ Step 5: Citizen tags"
docker exec "$CONTAINER" bun run packages/pipeline/src/scripts/generate-citizen-tags.ts >> "$LOG" 2>&1
log "  ✓ Citizen tags done"

# ── Step 6: AI — omnibus topic detection ────────────────────────────────────
log "→ Step 6: Omnibus topics"
docker exec "$CONTAINER" bun run packages/api/src/scripts/generate-omnibus-topics.ts >> "$LOG" 2>&1
log "  ✓ Omnibus topics done"

# ── Step 7: OG images (only generates missing ones) ─────────────────────────
log "→ Step 7: OG images"
docker exec "$CONTAINER" bun run packages/api/src/scripts/generate-og-images.ts >> "$LOG" 2>&1
log "  ✓ OG images done"

# ── Step 8: Email notifications ─────────────────────────────────────────────
log "→ Step 8: Send notifications"
docker exec "$CONTAINER" bun run packages/api/src/scripts/send-notifications.ts >> "$LOG" 2>&1
log "  ✓ Notifications sent"

# ── Step 9: Retry push if step 1.5 failed due to a transient error ──────────
# AI/email steps (2-8) write only to the DB, never to leyes markdown. The
# retry exists purely to recover from network/auth flakes in step 1.5; the
# AI work in between bought us ~minutes of wall-clock time for whatever was
# wrong upstream to clear.
if [ "$push_status" -ne 0 ]; then
  log "→ Step 9: Retry push (step 1.5 failed earlier)"
  set +e
  push_leyes
  retry_status=$?
  set -e
  if [ "$retry_status" -ne 0 ]; then
    log "  ⚠ retry also failed. Will retry on next daily run. Investigate logs."
    send_alert "leyes push retry also failed" "exit=$retry_status — investigate logs at /opt/leyabierta/logs/daily-pipeline.log"
  fi
fi

# ── Step 9.5: Checkpoint the WAL ────────────────────────────────────────────
# The day's ingest + AI steps push a lot through the write-ahead log, and
# `wal_autocheckpoint` (1000 pages ≈ 4 MB) only fires when no reader holds the
# database — the API always does, so in practice it never truncates. Observed
# 2026-07-22: 277 MB of WAL still on disk with every writer long finished.
# TRUNCATE reclaims the file; the data was already in the DB, so nothing is
# lost if this is a no-op. Non-fatal, and placed before the index rebuild so it
# runs while the API is still up (the rebuild restarts it).
log "→ Step 9.5: Checkpoint SQLite WAL"
set +e
docker exec "$CONTAINER" bun -e 'const {Database}=require("bun:sqlite");const db=new Database(process.env.DB_PATH??"/data/leyabierta.db");console.log(JSON.stringify(db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()));' >> "$LOG" 2>&1
checkpoint_status=$?
set -e
if [ "$checkpoint_status" -ne 0 ]; then
  log "  ⚠ WAL checkpoint returned $checkpoint_status (non-fatal)"
else
  log "  ✓ WAL checkpoint done"
fi

# ── Step 10: Rebuild the vector search index if new embeddings were added ────
# embed-corpus (Step 3b) only writes the DB; the flat int8 index is separate and
# used to drift stale. This rebuilds it (memory-safe: streamed export + chunked
# quantize) and hot-restarts the API. Runs LAST because it restarts the
# container, which would break the docker-exec steps above. Non-fatal.
log "→ Step 10: Rebuild vector index (if stale)"
set +e
bash "$REPO_DIR/scripts/rebuild-vector-index.sh" >> "$LOG" 2>&1
rebuild_status=$?
set -e
if [ "$rebuild_status" -ne 0 ]; then
  log "  ⚠ vector index rebuild returned $rebuild_status (non-fatal — see log)"
else
  log "  ✓ Vector index step done"
fi

log "=== Daily pipeline completed ==="

# ── Heartbeat: signal successful completion to uptime monitor ────────────────
# Unconditional on purpose: this is the liveness signal for steps 1-8 (the
# daily emails included), NOT a deploy-freshness signal. Deploy staleness is
# alerted separately near the top of this script — see the comment there.
if [ -n "${BETTERSTACK_HEARTBEAT_URL:-}" ]; then
  curl -fsS --max-time 10 "$BETTERSTACK_HEARTBEAT_URL" >/dev/null 2>&1 \
    && log "  ✓ heartbeat sent (SHA=$PIPELINE_SHA)" \
    || log "  ⚠ heartbeat failed (non-fatal)"
fi
