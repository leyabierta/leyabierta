#!/usr/bin/env bash
# Auto-update API container from GHCR.
# Designed to run as a cron job every 5 minutes.
# Only restarts if a new image is available.
#
# Install on server:
#   crontab -e
#   */5 * * * * /opt/leyabierta/code/scripts/auto-update-api.sh >> /var/log/leyabierta-update.log 2>&1

set -euo pipefail

COMPOSE_DIR="/opt/leyabierta/code"
IMAGE="ghcr.io/leyabierta/api:latest"

cd "$COMPOSE_DIR"

# Pull latest image (exit early if pull fails)
if ! docker pull "$IMAGE" 2>&1 | grep -q "Status: Downloaded newer image"; then
    exit 0 # No new image or pull failed — do nothing
fi

echo "$(date -Iseconds) New image detected, restarting..."

# Restart with the new image
docker compose up -d api

# Wait for health check
sleep 5
if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "$(date -Iseconds) Health check passed"
else
    echo "$(date -Iseconds) WARNING: Health check failed after update"
fi
