#!/bin/bash
# Unified daily pipeline — all steps sequential, fail-fast.
# Replaces the old split cron jobs (update-db.sh, generate-ai.sh, send-notifications.sh).
#
# Usage: /opt/leyabierta/scripts/daily-pipeline.sh
# Cron:  30 8 * * * /opt/leyabierta/scripts/daily-pipeline.sh
set -euo pipefail

LOG=/opt/leyabierta/logs/daily-pipeline.log
CONTAINER=code-api-1

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" | tee -a "$LOG"; }

log "=== Daily pipeline started ==="

# Step 1: Run pipeline (fetch new + reformed norms from BOE → JSON + git commits)
log "→ Step 1: Pipeline bootstrap"
docker exec $CONTAINER bun run pipeline bootstrap --country es --concurrency 2 >> "$LOG" 2>&1
log "  ✓ Pipeline done"

# Step 2: Ingest JSON → SQLite
log "→ Step 2: Ingest"
docker exec $CONTAINER bun run ingest >> "$LOG" 2>&1
log "  ✓ Ingest done"

# Step 3: Ingest analisis (materias, notas, refs from BOE)
log "→ Step 3: Ingest analisis"
docker exec $CONTAINER bun run ingest-analisis >> "$LOG" 2>&1
log "  ✓ Ingest-analisis done"

# Step 4: AI — reform summaries
log "→ Step 4: Reform summaries"
docker exec $CONTAINER bun run packages/api/src/scripts/generate-reform-summaries.ts >> "$LOG" 2>&1
log "  ✓ Reform summaries done"

# Step 5: AI — citizen tags & summaries
log "→ Step 5: Citizen tags"
docker exec $CONTAINER bun run packages/pipeline/src/scripts/generate-citizen-tags.ts >> "$LOG" 2>&1
log "  ✓ Citizen tags done"

# Step 6: AI — omnibus topic detection
log "→ Step 6: Omnibus topics"
docker exec $CONTAINER bun run packages/api/src/scripts/generate-omnibus-topics.ts >> "$LOG" 2>&1
log "  ✓ Omnibus topics done"

# Step 7: OG images (only generates missing ones)
log "→ Step 7: OG images"
docker exec $CONTAINER bun run packages/api/src/scripts/generate-og-images.ts >> "$LOG" 2>&1
log "  ✓ OG images done"

# Step 8: Email notifications
log "→ Step 8: Send notifications"
docker exec $CONTAINER bun run packages/api/src/scripts/send-notifications.ts >> "$LOG" 2>&1
log "  ✓ Notifications sent"

log "=== Daily pipeline completed ==="
