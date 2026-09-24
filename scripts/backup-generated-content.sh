#!/usr/bin/env bash
# Daily backup of what leyabierta.db cannot rebuild: AI-generated content and
# subscriptions (see packages/api/src/scripts/backup-generated-content.ts).
# The rest of the DB is derived from the JSON cache (`bun run ingest`).
#
# Kept on the server only (decision 2026-09-24): protects against bad imports
# and logical errors, not against losing the disk.
#
# Run daily via /etc/cron.d/leyabierta (04:00, before the 08:30 pipeline).
# The file holds subscriber emails and confirm/unsubscribe tokens: 0600 only.
set -euo pipefail
umask 077

CONTAINER="${API_CONTAINER:-code-api-1}"
DATA_DIR="${DATA_DIR:-/opt/leyabierta/code/data}" # host side of the container's /data
BACKUP_DIR="${GENERATED_BACKUP_DIR:-/opt/leyabierta/backups}"
RETAIN_COUNT="${GENERATED_BACKUP_RETAIN:-14}"
MIN_BYTES="${GENERATED_BACKUP_MIN_BYTES:-20000000}" # ~44 MB gzipped on 2026-09-24

mkdir -p "$BACKUP_DIR"
TS=$(date -u +%Y%m%d)
TMP_NAME="tmp-backup-generated-$TS.db"
OUT="$BACKUP_DIR/generated-content-$TS.db"

ENV_FILE="${ENV_FILE:-/opt/leyabierta/code/.env.prod}"

# Cron has MAILTO="": a failure must reach the same webhook as daily-pipeline.sh.
send_alert() {
  local webhook="${ALERT_WEBHOOK_URL:-}"
  if [ -z "$webhook" ] && [ -r "$ENV_FILE" ]; then
    webhook=$(grep -E '^ALERT_WEBHOOK_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  fi
  [ -n "$webhook" ] || return 0
  python3 -c 'import json,sys; print(json.dumps({"title":sys.argv[1],"body":sys.argv[2],"host":"KonarServer"}))' \
    "leyabierta generated-content backup failed" "$1" \
    | curl -fsS --max-time 10 -X POST "$webhook" -H "Content-Type: application/json" -d @- >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  rm -f "$DATA_DIR/$TMP_NAME"
  if [ "$status" -ne 0 ]; then
    send_alert "exit $status — see /opt/leyabierta/logs/backup-generated.log"
  fi
}
trap cleanup EXIT

docker exec "$CONTAINER" bun run packages/api/src/scripts/backup-generated-content.ts "/data/$TMP_NAME"
mv "$DATA_DIR/$TMP_NAME" "$OUT"
gzip -f "$OUT"

SIZE=$(stat -c %s "$OUT.gz")
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  # Rename so the rotation below never counts it as a good copy.
  mv "$OUT.gz" "$OUT.gz.bad"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) generated-content-backup TOO SMALL ($SIZE bytes < $MIN_BYTES): $OUT.gz.bad" >&2
  exit 1
fi

# Retain the last N backups; remove older.
ls -1t "$BACKUP_DIR"/generated-content-*.db.gz 2>/dev/null \
  | tail -n +"$((RETAIN_COUNT + 1))" \
  | xargs -r rm

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) generated-content-backup OK ($OUT.gz, $SIZE bytes)"
