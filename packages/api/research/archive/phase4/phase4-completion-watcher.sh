#!/usr/bin/env bash
# Polls until the run-phase4-overnight.sh process exits, then runs the closing
# steps that the running orchestrator can't pick up (extra merges + report +
# Vault summary). Idempotent: safe to run before the orchestrator finishes;
# it will just wait.

set -uo pipefail
cd "$(dirname "$0")/../../../.."
LOG_DIR=data/ab-results

while pgrep -f "run-phase4-overnight.sh" >/dev/null 2>&1; do
	sleep 60
done

# Wait one more cycle for the last eval to flush its file.
sleep 30

echo "[$(date '+%H:%M:%S')] Orchestrator finished — running closing steps"

bash packages/api/research/ab/phase4-extra-merges.sh 2>&1 | tee -a "$LOG_DIR/phase4-run.log"
bun packages/api/research/ab/phase4-report.ts 2>&1 | tee -a "$LOG_DIR/phase4-run.log"
bun packages/api/research/ab/phase4-vault-summary.ts 2>&1 | tee -a "$LOG_DIR/phase4-run.log"

echo "[$(date '+%H:%M:%S')] Closing steps complete"
echo "  Report: $LOG_DIR/phase4-results.md"
echo "  Vault:  ~/Documents/Obsidian Vault/10-Projects/Ley-Abierta/research/2026-05-10-phase4-results.md"
