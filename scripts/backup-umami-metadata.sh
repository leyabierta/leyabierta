#!/usr/bin/env bash
# Weekly backup of Umami metadata tables (NOT events).
# Captures website UUID, users, team config, retention settings —
# everything needed to recover the panel without forcing a full re-deploy
# of the web with a new website ID.
#
# Events are NOT backed up: data is reproducible via continuous capture
# and backing up event payloads (even hashed) complicates privacy posture.
#
# Run weekly via /etc/cron.d/leyabierta-umami-meta-backup.
set -euo pipefail

CONTAINER="${UMAMI_DB_CONTAINER:-code-umami-db-1}"
BACKUP_DIR="${UMAMI_BACKUP_DIR:-/opt/leyabierta/backups}"
RETAIN_COUNT="${UMAMI_BACKUP_RETAIN:-12}"

mkdir -p "$BACKUP_DIR"
TS=$(date -u +%Y%m%d)
OUT="$BACKUP_DIR/umami-meta-$TS.sql"

docker exec "$CONTAINER" pg_dump -U umami -d umami \
  --table=website \
  --table=account \
  --table=team \
  --table=team_user \
  --table=team_website \
  --table=role \
  --table=user_role \
  > "$OUT"

gzip -f "$OUT"

# Retain the last N dumps; remove older.
ls -1t "$BACKUP_DIR"/umami-meta-*.sql.gz 2>/dev/null \
  | tail -n +"$((RETAIN_COUNT + 1))" \
  | xargs -r rm

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) umami-metadata-backup OK ($OUT.gz)"
