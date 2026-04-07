#!/usr/bin/env bash
# Wrapper around `astro build` that shows progress percentage.
# Usage: bash build-with-progress.sh
set -euo pipefail

# Resolve laws directory: LAWS_PATH is relative to repo root (2 levels up from packages/web)
REPO_ROOT="$(cd ../.. && pwd)"
LAWS_DIR="${REPO_ROOT}/${LAWS_PATH:-../leyes}"
TOTAL=$(find "$LAWS_DIR" -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')

# Fallback if we can't count laws
if [ "$TOTAL" -eq 0 ]; then
  echo "[build] Could not count laws in $LAWS_DIR — running without progress"
  exec bunx astro build
fi

# ── Fetch build manifest (1 API call instead of ~12K per-page calls) ──
echo "[build] Fetching build manifest..."
if curl -sf -H "x-api-key: ${API_BYPASS_KEY:-}" \
  "${API_URL:-https://api.leyabierta.es}/v1/build-manifest" \
  -o .build-manifest.json; then
  MANIFEST_SIZE=$(wc -c < .build-manifest.json | tr -d ' ')
  echo "[build] Manifest downloaded (${MANIFEST_SIZE} bytes)"
  export BUILD_MANIFEST_PATH="$(pwd)/.build-manifest.json"
else
  echo "[build] WARNING: Manifest fetch failed, falling back to per-page API calls"
fi

echo "[build] Building $TOTAL law pages + static pages"
START=$(date +%s)

# Use process substitution instead of pipe to avoid subshell variable scoping.
# In a pipe (cmd | while read), the while loop runs in a subshell so COUNT
# never increments in the parent shell. Process substitution keeps everything
# in the same shell.
COUNT=0
while IFS= read -r line; do
  if echo "$line" | grep -qE '├─|└─|\(\+[0-9]'; then
    COUNT=$((COUNT + 1))
    # Print progress every 500 pages
    if [ $((COUNT % 500)) -eq 0 ]; then
      PCT=$((COUNT * 100 / TOTAL))
      ELAPSED=$(( $(date +%s) - START ))
      if [ "$COUNT" -gt 0 ] && [ "$ELAPSED" -gt 0 ]; then
        RATE=$((COUNT / ELAPSED))
        ETA=$(( (TOTAL - COUNT) / (RATE > 0 ? RATE : 1) ))
        echo "[build] $COUNT/$TOTAL ($PCT%) — ${RATE} pages/sec — ~${ETA}s remaining"
      else
        echo "[build] $COUNT/$TOTAL ($PCT%)"
      fi
    fi
  elif echo "$line" | grep -q '^\[api\]'; then
    # Show API errors but don't count as pages
    echo "$line"
  else
    echo "$line"
  fi
done < <(bunx astro build 2>&1)

ELAPSED=$(( $(date +%s) - START ))
echo "[build] Done: $COUNT pages in ${ELAPSED}s"
