#!/usr/bin/env bash
# Picks up after the recovery retry finishes. Waits for the 468-recovery pass
# file to be saved, merges it into the 1000-entry backup, regenerates report
# and wake-up summary.
#
# Assumes a separate `bun eval-prod-replica.ts --only-gemini ... > .../v3-1000-gemini-recovery-retry.log`
# process is running (or about to run) in the background.

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

RETRY_LOG="data/ab-results/v3-1000-gemini-recovery-retry.log"
GEMINI_PASS="data/ab-results/eval-pass-gemini-baseline.json"
GEMINI_BACKUP="data/ab-results/eval-pass-gemini-baseline.json.original-1000"
GEMINI_RECOVERY_RETRY="data/ab-results/eval-pass-gemini-baseline.json.recovery468-retry"
QWEN_PASS="data/ab-results/eval-pass-qwen-no-instruct-nan-analyzer-nan-rerank-v3-1000.json"
REPORT="data/ab-results/v3-1000-final-report.md"
WAKEUP="$HOME/Documents/Obsidian Vault/10-Projects/Ley-Abierta/research/2026-05-12-wake-up-summary.md"
ORCH_LOG="data/ab-results/overnight-finalize-retry.log"

log() { echo "[retry $(date +%H:%M:%S)] $*" | tee -a "$ORCH_LOG"; }

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
    echo "## Story de la noche (resumida)"
    echo ""
    echo "1. Qwen pass v3-1000 terminó limpio a las 00:51."
    echo "2. Primer intento de Gemini recovery sobre las 468 queries fallidas (con 4 vector-pool workers) crashed con segfault de Bun a la 2ª query. Bug conocido por concurrencia."
    echo "3. Retry con \`RAG_VECTOR_POOL_WORKERS=1\` (log: \`$RETRY_LOG\`)."
    echo ""
    if [ -f "$REPORT" ]; then
      echo "## v3-1000 Final Report — headline"
      echo ""
      awk '/^## Headline/,/^## Per-category/' "$REPORT" | sed '/^## Per-category/d'
      echo ""
    else
      echo "## Final report NOT generated (recovery did not finish cleanly)"
      echo ""
      echo "Tail of retry log:"
      echo ""
      echo '```'
      [ -f "$RETRY_LOG" ] && tail -30 "$RETRY_LOG" || echo "(no retry log)"
      echo '```'
      echo ""
    fi
    echo "## Files"
    echo ""
    echo "- Final report: \`$REPORT\`"
    echo "- Orchestrator retry log: \`$ORCH_LOG\`"
    echo "- Recovery retry log: \`$RETRY_LOG\`"
    echo "- Gemini pass (after merge): \`$GEMINI_PASS\`"
    echo "- Gemini backup (original 1000, 468 broken): \`$GEMINI_BACKUP\`"
    echo "- Gemini recovery retry pass (468 entries if all succeeded): \`$GEMINI_RECOVERY_RETRY\`"
    echo "- Qwen pass (1000): \`$QWEN_PASS\`"
    echo ""
    echo "## Verdict preliminar (sobre baseline deflactada, antes del recovery exitoso)"
    echo ""
    echo "- Gemini: R@1=20.0%, R@5=33.5%, R@10=37.9% (deflactado por 468 embeddings fallidos)"
    echo "- Qwen-NaN: R@1=31.5%, R@5=57.6%, R@10=65.5% (limpio)"
    echo ""
    echo "Ajuste mental para Gemini eliminando los 468 rotos: ~37% R@1, lo que coincide con v3-500 baseline. Implica que Qwen-NaN gana sólido en R@5 y R@10 incluso si pierde un poco en R@1."
    echo ""
    echo "## Decisiones pendientes para ti"
    echo ""
    echo "- Mergear PR #90: si recovery sale bien y Qwen ≥ Gemini en R@K, ship."
    echo "- Re-feed los 141 recovery candidates (v3 dataset)?"
    echo "- Activar \`EVAL_MATERIA_RELEVANCE=1\` para próxima generación?"
  } > "$WAKEUP"
  log "Wake-up summary → $WAKEUP"
}
trap 'EXIT_REASON="failed at stage $LAST_STAGE (line $LINENO)"; write_wakeup' ERR

# ── Stage 1: wait for retry to finish ─────────────────────────────────────
LAST_STAGE="1-wait-retry"
log "Stage 1: waiting for recovery retry to finish..."
DEADLINE=$(( $(date +%s) + 3 * 3600 ))
proc_dead_since=0
while ! grep -qE "Saved Gemini pass results" "$RETRY_LOG" 2>/dev/null; do
  if grep -qE "panic|Segmentation fault" "$RETRY_LOG" 2>/dev/null; then
    EXIT_REASON="Recovery retry crashed (panic). See log."
    log "CRASH detected in retry log:"
    tail -25 "$RETRY_LOG" | tee -a "$ORCH_LOG"
    write_wakeup
    exit 1
  fi
  if [ "$(date +%s)" -gt "$DEADLINE" ]; then
    EXIT_REASON="Retry deadline (3h) exceeded"
    write_wakeup
    exit 1
  fi
  if pgrep -f "eval-prod-replica.*v3-failed468" >/dev/null 2>&1; then
    proc_dead_since=0
  else
    if [ "$proc_dead_since" -eq 0 ]; then
      proc_dead_since=$(date +%s)
      log "WARN: retry process not running; will wait 5min for save."
    elif [ $(( $(date +%s) - proc_dead_since )) -gt 300 ]; then
      EXIT_REASON="Retry process died without saving pass file"
      tail -25 "$RETRY_LOG" | tee -a "$ORCH_LOG"
      write_wakeup
      exit 1
    fi
  fi
  sleep 60
done
log "Stage 1: recovery retry saved Gemini pass file."

# ── Stage 2: move the new pass aside ──────────────────────────────────────
LAST_STAGE="2-move-recovery"
mv "$GEMINI_PASS" "$GEMINI_RECOVERY_RETRY"
log "Stage 2: moved recovery pass → $GEMINI_RECOVERY_RETRY"

# ── Stage 3: merge ────────────────────────────────────────────────────────
LAST_STAGE="3-merge"
log "Stage 3: merging recovery into backup."
bun packages/api/research/ab/merge-gemini-recovery.ts \
  --original "$GEMINI_BACKUP" \
  --recovery "$GEMINI_RECOVERY_RETRY" \
  --out      "$GEMINI_PASS" 2>&1 | tee -a "$ORCH_LOG"

# ── Stage 4: report ───────────────────────────────────────────────────────
LAST_STAGE="4-report"
log "Stage 4: generating final report."
bun packages/api/research/ab/v3-1000-final-report.ts \
  --gemini "$GEMINI_PASS" \
  --qwen   "$QWEN_PASS" \
  --out    "$REPORT" 2>&1 | tee -a "$ORCH_LOG"

# ── Stage 5: wake-up summary ──────────────────────────────────────────────
LAST_STAGE="5-wakeup"
EXIT_REASON="ok"
write_wakeup
log "Done. Headline:"
grep -E "^\| R@|^\| MRR|^\| n " "$REPORT" | sed 's/^/[retry] /' | tee -a "$ORCH_LOG"
