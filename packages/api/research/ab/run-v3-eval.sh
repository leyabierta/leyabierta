#!/usr/bin/env bash
# Re-run the Phase 5 + Phase 6 A/B on the v3 synthetic eval set
# (packages/eval/datasets/v3/accepted-*.jsonl), to confirm the NaN stack
# verdict at scale.
#
# Sequence:
#   1. Build adapted dataset (citizen-queries-v3.json) from v3 JSONL,
#      filtered to queries fully covered by the qwen3-nan haystack.
#   2. Run eval-prod-replica with the Phase 5 winning config
#      (--no-instruct --nan-analyzer --nan-rerank) on FULL corpus.
#   3. Run eval-synthesis (NaN qwen3.6 vs OpenRouter gemini-2.5-flash-lite,
#      gemma4 NaN judge).
#
# Resume-safe: each pass persists its own JSON; rerunning skips done variants
# only at the eval-prod-replica gemini-baseline level (cached). For a clean
# re-run of a single pass, delete the matching file under data/ab-results/.
#
# Env required:
#   HERMES_API_KEY      — NaN (api.nan.builders) for embeddings/analyzer/rerank/synth/judge
#   OPENROUTER_API_KEY  — only for the Gemini baseline candidate in eval-synthesis
#
# Optional:
#   V3_LIMIT=N          — cap the v3 set at N queries (default: all covered)
#   V3_OUT=path.json    — override output of the adapter (default citizen-queries-v3.json)
#   SKIP_BUILD=1        — skip adapter (reuse existing citizen-queries-v3.json)
#   SKIP_RETRIEVAL=1    — skip eval-prod-replica
#   SKIP_SYNTHESIS=1    — skip eval-synthesis

set -uo pipefail

cd "$(dirname "$0")/../../../.."

LOG_DIR=data/ab-results
mkdir -p "$LOG_DIR"
RUN_LOG="$LOG_DIR/v3-eval-run.log"

DATASET_PATH="${V3_OUT:-packages/api/research/datasets/citizen-queries-v3.json}"

log() {
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$RUN_LOG"
}

# Load .env if present (HERMES_API_KEY, OPENROUTER_API_KEY).
if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

if [ -z "${HERMES_API_KEY:-}" ]; then
	log "❌ HERMES_API_KEY not set — abort"
	exit 1
fi

log "=== v3 eval start ==="
log "PID $$"
log "Dataset target: $DATASET_PATH"

# ── 1. Build adapter ──
if [ "${SKIP_BUILD:-0}" = "1" ]; then
	log "Skipping adapter build (SKIP_BUILD=1)"
else
	log "--- Building eval dataset from v3 JSONL ---"
	BUILD_ARGS=()
	if [ -n "${V3_LIMIT:-}" ]; then
		BUILD_ARGS+=(--limit "$V3_LIMIT")
	fi
	BUILD_ARGS+=(--out "$DATASET_PATH")
	if bun packages/api/research/ab/build-eval-from-v3.ts "${BUILD_ARGS[@]}" \
		>"$LOG_DIR/v3-build.log" 2>&1; then
		log "  ✅ Adapter ok"
		grep -E "Loaded|Deduped|Coverage|Wrote|voice:|difficulty:|jurisdiction:" \
			"$LOG_DIR/v3-build.log" | tee -a "$RUN_LOG"
	else
		log "  ❌ Adapter failed — tail:"
		tail -30 "$LOG_DIR/v3-build.log" | tee -a "$RUN_LOG"
		exit 1
	fi
fi

if [ ! -f "$DATASET_PATH" ]; then
	log "❌ Expected dataset not found at $DATASET_PATH — abort"
	exit 1
fi

# ── 2. eval-prod-replica (retrieval A/B) ──
if [ "${SKIP_RETRIEVAL:-0}" = "1" ]; then
	log "Skipping retrieval eval (SKIP_RETRIEVAL=1)"
else
	log "--- eval-prod-replica: Phase 5 winning config on v3 dataset ---"
	# Phase 5 winning config: NaN-only stack (no instruct + nan-analyzer + nan-rerank),
	# full corpus haystack.
	# Tag results with v3 so they don't collide with prior runs.
	RETRIEVAL_LOG="$LOG_DIR/v3-eval-prod-replica.log"
	if RAG_VECTOR_POOL_WORKERS=1 \
		bun packages/api/research/ab/eval-prod-replica.ts \
		--dataset "$DATASET_PATH" \
		--full --no-instruct --nan-analyzer --nan-rerank \
		--tag v3 \
		>"$RETRIEVAL_LOG" 2>&1; then
		log "  ✅ Retrieval eval done"
		grep -E "Gemini-2|Qwen-NAN |R@1 gap|R@5 gap|R@10 gap|DECISION GATE" \
			"$RETRIEVAL_LOG" | tee -a "$RUN_LOG"
	else
		log "  ❌ Retrieval eval failed — tail:"
		tail -40 "$RETRIEVAL_LOG" | tee -a "$RUN_LOG"
	fi
fi

# ── 3. eval-synthesis (synthesis A/B) ──
if [ "${SKIP_SYNTHESIS:-0}" = "1" ]; then
	log "Skipping synthesis eval (SKIP_SYNTHESIS=1)"
else
	if [ -z "${OPENROUTER_API_KEY:-}" ]; then
		log "⚠ OPENROUTER_API_KEY not set — skipping synthesis eval (Gemini baseline candidate requires it)"
	else
		log "--- eval-synthesis: qwen3.6 NaN vs gemini-2.5-flash-lite on v3 dataset ---"
		SYNTHESIS_LOG="$LOG_DIR/v3-eval-synthesis.log"
		if bun packages/api/research/ab/eval-synthesis.ts \
			--eval "$DATASET_PATH" \
			>"$SYNTHESIS_LOG" 2>&1; then
			log "  ✅ Synthesis eval done"
			tail -40 "$SYNTHESIS_LOG" | tee -a "$RUN_LOG"
		else
			log "  ❌ Synthesis eval failed — tail:"
			tail -40 "$SYNTHESIS_LOG" | tee -a "$RUN_LOG"
		fi
	fi
fi

log "=== v3 eval done ==="
log "Logs in $LOG_DIR/v3-*.log"
