#!/bin/bash
# Run full eval with multiple synthesis models.
# Changes the SYNTHESIS_MODEL constant, restarts API, runs eval, saves results.
#
# Usage: bash packages/api/research/eval-multi-model.sh

set -e

MODELS=(
  "mistralai/ministral-8b-2512"
  "mistralai/mistral-small-2603"
  "qwen/qwen3-next-80b-a3b-instruct"
  "google/gemini-2.0-flash-001"
  "google/gemini-2.5-flash-lite"
)

PIPELINE="packages/api/src/services/rag/pipeline.ts"
ORIGINAL_MODEL=$(grep 'const SYNTHESIS_MODEL' "$PIPELINE" | sed 's/.*= "//;s/".*//')
echo "Original model: $ORIGINAL_MODEL"

cleanup() {
  echo "Restoring original model: $ORIGINAL_MODEL"
  sed -i.bak "s|const SYNTHESIS_MODEL = \".*\"|const SYNTHESIS_MODEL = \"$ORIGINAL_MODEL\"|" "$PIPELINE"
  rm -f "${PIPELINE}.bak"
  pkill -9 -f "bun.*api" 2>/dev/null || true
}
trap cleanup EXIT

for MODEL in "${MODELS[@]}"; do
  SAFE_NAME=$(echo "$MODEL" | tr '/' '_')
  OUTPUT="data/eval-model-${SAFE_NAME}.json"

  echo ""
  echo "=========================================="
  echo "  Model: $MODEL"
  echo "  Output: $OUTPUT"
  echo "=========================================="

  # Swap model
  sed -i.bak "s|const SYNTHESIS_MODEL = \".*\"|const SYNTHESIS_MODEL = \"$MODEL\"|" "$PIPELINE"
  rm -f "${PIPELINE}.bak"

  # Restart API
  pkill -9 -f "bun.*api" 2>/dev/null || true
  lsof -ti:3000 | xargs kill -9 2>/dev/null || true
  sleep 2
  bun run api &>/tmp/leyabierta-api.log &
  sleep 5

  # Verify
  if ! curl -s http://localhost:3000/health | grep -q '"status":"ok"'; then
    echo "  ERROR: API failed to start"
    sleep 3
    if ! curl -s http://localhost:3000/health | grep -q '"status":"ok"'; then
      echo "  SKIPPING $MODEL"
      continue
    fi
  fi

  # Run eval
  echo "  Running eval..."
  bun run packages/api/research/eval-collect-answers.ts --output "$OUTPUT" 2>&1 | tail -5

  echo "  Done: $OUTPUT"
done

echo ""
echo "All evals complete. Results in data/eval-model-*.json"
