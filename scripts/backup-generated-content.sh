#!/usr/bin/env bash
# Daily backup of what leyabierta.db cannot rebuild: AI-generated content and
# subscriptions (see packages/api/src/scripts/backup-generated-content.ts).
# The rest of the DB is derived from the JSON cache (`bun run ingest`).
#
# Kept on the server only (decision 2026-09-24): protects against bad imports
# and logical errors, not against losing the disk.
#
# Run daily via /etc/cron.d/leyabierta (04:00, before the 08:30 pipeline).
set -euo pipefail

CONTAINER="${API_CONTAINER:-code-api-1}"
DATA_DIR="${DATA_DIR:-/opt/leyabierta/code/data}" # host side of the container's /data
BACKUP_DIR="${GENERATED_BACKUP_DIR:-/opt/leyabierta/backups}"
RETAIN_COUNT="${GENERATED_BACKUP_RETAIN:-14}"
MIN_BYTES="${GENERATED_BACKUP_MIN_BYTES:-20000000}" # ~44 MB gzipped on 2026-09-24

mkdir -p "$BACKUP_DIR"
TS=$(date -u +%Y%m%d)
TMP_NAME="tmp-backup-generated-$TS.db"
OUT="$BACKUP_DIR/generated-content-$TS.db"

cleanup() { rm -f "$DATA_DIR/$TMP_NAME"; }
trap cleanup EXIT

docker exec "$CONTAINER" bun run packages/api/src/scripts/backup-generated-content.ts "/data/$TMP_NAME"
mv "$DATA_DIR/$TMP_NAME" "$OUT"
gzip -f "$OUT"

SIZE=$(stat -c %s "$OUT.gz")
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) generated-content-backup TOO SMALL ($SIZE bytes < $MIN_BYTES): $OUT.gz" >&2
  exit 1
fi

# Retain the last N backups; remove older.
ls -1t "$BACKUP_DIR"/generated-content-*.db.gz 2>/dev/null \
  | tail -n +"$((RETAIN_COUNT + 1))" \
  | xargs -r rm

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) generated-content-backup OK ($OUT.gz, $SIZE bytes)"
