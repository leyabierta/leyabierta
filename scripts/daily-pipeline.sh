#!/bin/bash
# Unified daily pipeline — all steps sequential, fail-fast.
# Replaces the old split cron jobs (update-db.sh, generate-ai.sh, send-notifications.sh).
#
# Usage: /opt/leyabierta/scripts/daily-pipeline.sh
# Cron:  30 8 * * * /opt/leyabierta/scripts/daily-pipeline.sh

# ── Self-update: pull latest version from the prod tag before doing anything ──
# Runs BEFORE set -euo pipefail and BEFORE the lockfile so that even a stale
# on-disk copy of this script can bootstrap itself to the current version.
# LEYABIERTA_SELF_UPDATED=1 breaks the re-exec loop (set by child after update).
SCRIPT_PATH="$(readlink -f "$0")"
REPO_DIR=/opt/leyabierta/code
SCRIPT_IN_REPO="$REPO_DIR/scripts/daily-pipeline.sh"

if [ -z "${LEYABIERTA_SELF_UPDATED:-}" ] && [ -d "$REPO_DIR/.git" ]; then
  # Fetch the prod tag with explicit refspec so a force-updated remote tag
  # always overrides the local one. `git fetch --tags` (without --force) is
  # NOT enough — it silently keeps an existing local tag pointing to an old
  # commit, so self-update would never advance.
  if git -C "$REPO_DIR" fetch --quiet origin "+refs/tags/prod:refs/tags/prod" 2>/dev/null \
     && git -C "$REPO_DIR" reset --hard refs/tags/prod >/dev/null 2>&1; then
    if [ -f "$SCRIPT_IN_REPO" ] && ! cmp -s "$SCRIPT_PATH" "$SCRIPT_IN_REPO"; then
      export LEYABIERTA_SELF_UPDATED=1
      exec "$SCRIPT_IN_REPO" "$@"
    fi
  fi
fi

LOG=/opt/leyabierta/logs/daily-pipeline.log
CONTAINER=code-api-1
ENV_FILE=/opt/leyabierta/code/.env.prod
LEYES_DIR_CONTAINER=/data/leyes
DIVERGENCE_CEILING=200  # abort push if local is ahead by more than this; alert + investigate

# Ensure the log directory exists BEFORE any code that might log (the lock
# guard below being the first such case on a fresh server).
mkdir -p "$(dirname "$LOG")"

# ── Single-instance lock ────────────────────────────────────────────────────
# Prevents concurrent runs from racing on the leyes git working tree
# (root cause of duplicate commits seen in production before 2026-04-27).
LOCKFILE=/var/lock/leyabierta-pipeline.lock
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] another pipeline run is in progress — skipping" >> "$LOG"
  exit 0
fi

set -euo pipefail

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" | tee -a "$LOG"; }

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
# Falls back silently if ALERT_WEBHOOK_URL is unset or curl fails.
send_alert() {
  local title="$1" body="$2"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    local json
    json=$(build_alert_json "$title" "$body")
    curl -fsS --max-time 10 -X POST "$ALERT_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "$json" \
      >/dev/null 2>&1 || true
  fi
}

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

# ── Step 3: Ingest analisis (materias, notas, refs from BOE) ────────────────
log "→ Step 3: Ingest analisis"
docker exec "$CONTAINER" bun run ingest-analisis >> "$LOG" 2>&1
log "  ✓ Ingest-analisis done"

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

log "=== Daily pipeline completed ==="

# ── Heartbeat: signal successful completion to uptime monitor ────────────────
if [ -n "${BETTERSTACK_HEARTBEAT_URL:-}" ]; then
  curl -fsS --max-time 10 "$BETTERSTACK_HEARTBEAT_URL" >/dev/null 2>&1 \
    && log "  ✓ heartbeat sent" \
    || log "  ⚠ heartbeat failed (non-fatal)"
fi
