#!/usr/bin/env bash
# Smoke test for Umami analytics deployment.
# Verifies heartbeat endpoint and that /data/event accepts events.
# Run after deploying Umami or when verifying CF Tunnel ingress.
set -euo pipefail

UMAMI_URL="${UMAMI_URL:-https://analytics.leyabierta.es}"
WEBSITE_ID="${UMAMI_WEBSITE_ID:?UMAMI_WEBSITE_ID env var required}"

echo "Checking heartbeat at $UMAMI_URL/api/heartbeat ..."
curl -fsS "$UMAMI_URL/api/heartbeat" > /dev/null
echo "  OK"

echo "Sending smoke event to $UMAMI_URL/data/event ..."
curl -fsS -X POST "$UMAMI_URL/data/event" \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: leyabierta-smoke/1.0' \
  -d "$(cat <<EOF
{
  "type": "event",
  "payload": {
    "website": "$WEBSITE_ID",
    "hostname": "leyabierta.es",
    "language": "es-ES",
    "screen": "1920x1080",
    "url": "/__smoke__",
    "name": "smoke_test"
  }
}
EOF
)" > /dev/null
echo "  OK"

echo "Umami smoke test passed."
