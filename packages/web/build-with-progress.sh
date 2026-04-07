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

echo "[build] Building $TOTAL law pages + static pages"
COUNT=0
START=$(date +%s)

bunx astro build 2>&1 | while IFS= read -r line; do
  if echo "$line" | grep -q '├─\|└─'; then
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
  else
    echo "$line"
  fi
done

ELAPSED=$(( $(date +%s) - START ))
echo "[build] Done: $TOTAL pages in ${ELAPSED}s"
