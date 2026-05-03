#!/usr/bin/env bash
# Purge raw Umami events older than 25 months (AEPD retention limit).
# Aggregates remain in derived tables (irreversibly anonymized).
# Run monthly via /etc/cron.d/leyabierta-umami-purge.
set -euo pipefail

CONTAINER="${UMAMI_DB_CONTAINER:-code-umami-db-1}"

docker exec "$CONTAINER" psql -U umami -d umami -c "
  DELETE FROM website_event WHERE created_at < NOW() - INTERVAL '25 months';
  DELETE FROM session WHERE created_at < NOW() - INTERVAL '25 months';
"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) umami-purge OK"
