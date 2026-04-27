#!/bin/bash
# Unified daily pipeline — all steps sequential, fail-fast.
# Replaces the old split cron jobs (update-db.sh, generate-ai.sh, send-notifications.sh).
#
# Usage: /opt/leyabierta/scripts/daily-pipeline.sh
# Cron:  30 8 * * * /opt/leyabierta/scripts/daily-pipeline.sh

# ── Single-instance lock ────────────────────────────────────────────────────
# Prevents concurrent runs from racing on the leyes git working tree
# (root cause of duplicate commits seen in production before 2026-04-27).
LOCKFILE=/var/lock/leyabierta-pipeline.lock
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] another pipeline run is in progress — skipping" >> /opt/leyabierta/logs/daily-pipeline.log
  exit 0
fi

set -euo pipefail

LOG=/opt/leyabierta/logs/daily-pipeline.log
CONTAINER=code-api-1
ENV_FILE=/opt/leyabierta/code/.env.prod
LEYES_DIR_CONTAINER=/data/leyes
DIVERGENCE_CEILING=200  # abort push if local is ahead by more than this; alert + investigate

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" | tee -a "$LOG"; }

# Load LEYES_PUSH_TOKEN from .env.prod for the push step. Sourcing the whole
# file is safe (it only contains KEY=value lines) and lets us forward the
# token to docker exec without baking it into the container image.
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
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

  sha_before=$(git_in_container rev-parse HEAD 2>&1)
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
    return 1
  fi

  if [ "$ahead" = "0" ] && [ "$behind" = "0" ]; then
    log "  nothing to push (already in sync)"
    return 0
  fi

  if [ "$behind" -gt "0" ]; then
    log "  remote has $behind unseen commits — rebasing"
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

  sha_after=$(git_in_container rev-parse HEAD 2>&1)
  log "  ✓ push OK ($ahead commits published, HEAD=$sha_after)"
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

# ── Step 9: Retry push if step 1.5 failed (AI may have generated new commits) ──
# Reform summaries / citizen tags don't write to leyes markdown — they write to
# DB only. So a retry only matters if step 1.5 push genuinely failed.
if [ "$push_status" -ne 0 ]; then
  log "→ Step 9: Retry push (step 1.5 failed earlier)"
  set +e
  push_leyes
  retry_status=$?
  set -e
  if [ "$retry_status" -ne 0 ]; then
    log "  ⚠ retry also failed. Will retry on next daily run. Investigate logs."
  fi
fi

log "=== Daily pipeline completed ==="
