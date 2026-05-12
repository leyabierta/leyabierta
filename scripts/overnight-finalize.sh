#!/usr/bin/env bash
# Overnight finalize: wait for Qwen pass to finish, run Gemini recovery on the
# 468 failed queries, merge, generate final report and vault summary.
#
# Each stage logs progress; on any failure the script exits and writes a
# wake-up summary documenting where it stopped.

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

EVAL_LOG="data/ab-results/v3-1000-qwen-resume.log"
QWEN_PASS="data/ab-results/eval-pass-qwen-no-instruct-nan-analyzer-nan-rerank-v3-1000.json"
GEMINI_PASS="data/ab-results/eval-pass-gemini-baseline.json"
GEMINI_BACKUP="data/ab-results/eval-pass-gemini-baseline.json.original-1000"
GEMINI_RECOVERY_RAW="data/ab-results/eval-pass-gemini-baseline.json.recovery468"
REPORT="data/ab-results/v3-1000-final-report.md"
WAKEUP="$HOME/Documents/Obsidian Vault/10-Projects/Ley-Abierta/research/2026-05-12-wake-up-summary.md"
ORCH_LOG="data/ab-results/overnight-finalize.log"
RECOVERY_LOG="data/ab-results/v3-1000-gemini-recovery.log"

log() { echo "[overnight $(date +%H:%M:%S)] $*" | tee -a "$ORCH_LOG"; }

# Write wake-up summary at exit no matter what (success or partial failure).
LAST_STAGE="(not started)"
EXIT_REASON="ok"
write_wakeup() {
  local now; now="$(date '+%Y-%m-%d %H:%M:%S %Z')"
  mkdir -p "$(dirname "$WAKEUP")"
  {
    echo "# 2026-05-12 — Wake-up summary"
    echo ""
    echo "Generated: $now"
    echo "Last stage reached: **$LAST_STAGE**"
    echo "Exit reason: **$EXIT_REASON**"
    echo ""
    echo "## What ran overnight"
    echo ""
    echo "Orchestrator: \`scripts/overnight-finalize.sh\` (log: \`$ORCH_LOG\`)"
    echo ""
    if [ -f "$REPORT" ]; then
      echo "## v3-1000 Final Report — headline"
      echo ""
      awk '/^## Headline/,/^## Per-category/' "$REPORT" | sed '/^## Per-category/d'
      echo ""
    else
      echo "## Final report NOT generated"
      echo ""
      echo "Recovery log tail:"
      echo ""
      echo '```'
      [ -f "$RECOVERY_LOG" ] && tail -30 "$RECOVERY_LOG" || echo "(no log)"
      echo '```'
      echo ""
    fi
    echo "## Files"
    echo ""
    echo "- Final report: \`$REPORT\`"
    echo "- Orchestrator log: \`$ORCH_LOG\`"
    echo "- Recovery log: \`$RECOVERY_LOG\`"
    echo "- Gemini pass: \`$GEMINI_PASS\`"
    echo "- Gemini backup (original 1000, 468 broken): \`$GEMINI_BACKUP\`"
    echo "- 468-entry recovery pass: \`$GEMINI_RECOVERY_RAW\`"
    echo "- Qwen pass: \`$QWEN_PASS\`"
    echo ""
    echo "## Decisions still pending for Alex"
    echo ""
    echo "- Mergear PR #90 si Qwen-NAN ≥ Gemini en R@K"
    echo "- Decidir si re-feed los 141 recovery candidates (v3 dataset)"
    echo "- Activar \`EVAL_MATERIA_RELEVANCE=1\` para próxima generación"
  } > "$WAKEUP"
  log "Wake-up summary → $WAKEUP"
}
trap 'EXIT_REASON="failed at stage $LAST_STAGE (line $LINENO)"; write_wakeup' ERR

# ── Stage 1: wait for current Qwen pass to finish ─────────────────────────
LAST_STAGE="1-wait-qwen"
log "Stage 1: waiting for Qwen pass to finish..."
DEADLINE=$(( $(date +%s) + 6 * 3600 ))  # 6h cap
GRACE_AFTER_PROC_DEATH=300
proc_dead_since=0
while ! [ -f "$QWEN_PASS" ]; do
  if [ "$(date +%s)" -gt "$DEADLINE" ]; then
    EXIT_REASON="Stage 1 deadline (6h) exceeded; Qwen pass file never appeared"
    write_wakeup
    exit 1
  fi
  if pgrep -f "eval-prod-replica.*v3-1000" >/dev/null 2>&1; then
    proc_dead_since=0
  else
    if [ "$proc_dead_since" -eq 0 ]; then
      proc_dead_since=$(date +%s)
      log "WARN: eval process not running; will wait ${GRACE_AFTER_PROC_DEATH}s for save."
    elif [ $(( $(date +%s) - proc_dead_since )) -gt "$GRACE_AFTER_PROC_DEATH" ]; then
      EXIT_REASON="Eval process died before Qwen pass file was written"
      log "Eval process gone and pass file still missing after grace period."
      tail -20 "$EVAL_LOG" | tee -a "$ORCH_LOG"
      write_wakeup
      exit 1
    fi
  fi
  sleep 60
done
log "Stage 1: Qwen pass file present ($(wc -c < "$QWEN_PASS") bytes)."

# ── Stage 2: backup Gemini baseline ───────────────────────────────────────
LAST_STAGE="2-backup-gemini"
log "Stage 2: backing up Gemini baseline."
if [ ! -f "$GEMINI_BACKUP" ]; then
  cp "$GEMINI_PASS" "$GEMINI_BACKUP"
  log "  → $GEMINI_BACKUP"
else
  log "  Backup already exists, leaving in place."
fi

# ── Stage 3: build subset of failed query IDs ─────────────────────────────
LAST_STAGE="3-build-failed-subset"
log "Stage 3: building failed-subset dataset."
bun packages/api/research/ab/build-failed-subset.ts 2>&1 | tee -a "$ORCH_LOG"

# ── Stage 4: run --only-gemini on the failed subset ───────────────────────
LAST_STAGE="4-rerun-gemini"
log "Stage 4: re-running Gemini pass on failed queries (~1-1.5h, ~\$0.30)."
log "  This will OVERWRITE $GEMINI_PASS with a smaller-entry file."
log "  (1000-entry version is at $GEMINI_BACKUP.)"
bun packages/api/research/ab/eval-prod-replica.ts \
  --dataset packages/api/research/datasets/citizen-queries-v3-failed468.json \
  --full --no-instruct --nan-analyzer --nan-rerank \
  --tag v3-failed468 \
  --only-gemini > "$RECOVERY_LOG" 2>&1
log "Stage 4: done. Recovery log → $RECOVERY_LOG"

# Move the recovery pass aside before merging.
mv "$GEMINI_PASS" "$GEMINI_RECOVERY_RAW"

# ── Stage 5: merge recovery into original ─────────────────────────────────
LAST_STAGE="5-merge"
log "Stage 5: merging recovery into original baseline."
bun packages/api/research/ab/merge-gemini-recovery.ts \
  --original "$GEMINI_BACKUP" \
  --recovery "$GEMINI_RECOVERY_RAW" \
  --out      "$GEMINI_PASS" 2>&1 | tee -a "$ORCH_LOG"

# ── Stage 6: generate final report ────────────────────────────────────────
LAST_STAGE="6-report"
log "Stage 6: generating final report."
bun packages/api/research/ab/v3-1000-final-report.ts \
  --gemini "$GEMINI_PASS" \
  --qwen   "$QWEN_PASS" \
  --out    "$REPORT" 2>&1 | tee -a "$ORCH_LOG"

# ── Stage 7: wake-up summary ──────────────────────────────────────────────
LAST_STAGE="7-wakeup"
EXIT_REASON="ok"
write_wakeup
log "Done. Headline:"
grep -E "^\| R@|^\| MRR|^\| n " "$REPORT" | sed 's/^/[overnight] /' | tee -a "$ORCH_LOG"
