#!/usr/bin/env bash
# Periodic status monitor for the Phase 4 overnight run. Writes a snapshot to
# data/ab-results/phase4-status.md every 5 min so the user can wake up and
# check progress at a glance.

set -u

cd "$(dirname "$0")/../../../.."
LOG_DIR=data/ab-results
STATUS_FILE="$LOG_DIR/phase4-status.md"

variants=(
	"no-instruct:Baseline (no HyDE, raw index)"
	"no-instruct-hyde:HyDE (qwen3.6 base prompt, rewrite-only)"
	"no-instruct-hyde-short:HyDE short (1 sentence)"
	"no-instruct-hyde-keywords:HyDE keywords (term list)"
	"no-instruct-hyde-gemma4:HyDE gemma4"
	"no-instruct-summary:Raw query × summary index"
	"no-instruct-hyde-summary:HyDE × summary"
	"no-instruct-hyde-short-summary:HyDE-short × summary"
	"no-instruct-hyde-keywords-summary:HyDE-keywords × summary"
	"no-instruct-hyde-gemma4-summary:HyDE-gemma4 × summary"
	"multi-no-instruct:Multi-vector (raw + summary, post-hoc)"
	"multi-hyde:Multi-vector + best HyDE"
	"multi-hyde-short:Multi-vector + HyDE-short"
	"multi-hyde-keywords:Multi-vector + HyDE-keywords"
	"multi-hyde-gemma4:Multi-vector + HyDE-gemma4"
)

snapshot() {
	{
		echo "# Phase 4 status — $(date '+%Y-%m-%d %H:%M:%S')"
		echo
		echo "Auto-refreshed every 5 min by phase4-monitor.sh"
		echo
		echo "## Running processes"
		echo
		echo '```'
		ps -eo pid,etime,rss,command | grep -E "(eval-prod-replica|run-phase4|embed-citizen|phase4-monitor)" | grep -v grep || echo "(none)"
		echo '```'
		echo
		echo "## Citizen-summary embed"
		echo
		local embed_progress
		embed_progress=$(tail -1 "$LOG_DIR/embed-citizen-summaries.log" 2>/dev/null | tr -d '\r' | head -c 200)
		echo "Last log line: \`${embed_progress:-no log}\`"
		echo
		local row_counts
		row_counts=$(sqlite3 data/leyabierta.db "SELECT COUNT(*), COUNT(DISTINCT norm_id) FROM embeddings WHERE model='qwen3-nan-summary';" 2>/dev/null)
		echo "DB rows: \`${row_counts}\` (chunks, distinct norms)"
		echo
		echo "## Variant matrix"
		echo
		echo "| Variant | Status | R@1 | R@5 | R@10 | MRR |"
		echo "|---|---|---|---|---|---|"
		# Gemini baseline
		local g_file="$LOG_DIR/eval-pass-gemini-baseline.json"
		if [ -f "$g_file" ]; then
			local stats
			stats=$(bun -e "
const f = await Bun.file('$g_file').json();
const r = f.results;
const t = r.length || 1;
const h1 = r.filter(x => x.hitsAt1).length;
const h5 = r.filter(x => x.hitsAt5).length;
const h10 = r.filter(x => x.hitsAt10).length;
console.log(((h1/t)*100).toFixed(1) + '|' + ((h5/t)*100).toFixed(1) + '|' + ((h10/t)*100).toFixed(1));
" 2>/dev/null)
			IFS='|' read -r r1 r5 r10 <<<"$stats"
			echo "| **Gemini-2 (baseline)** | ✅ | ${r1}% | ${r5}% | ${r10}% | — |"
		fi
		for entry in "${variants[@]}"; do
			IFS=':' read -r tag desc <<<"$entry"
			local f="$LOG_DIR/eval-pass-qwen-$tag.json"
			if [ -f "$f" ]; then
				local stats
				stats=$(bun -e "
const f = await Bun.file('$f').json();
const r = f.results;
const t = r.length || 1;
const h1 = r.filter(x => x.hitsAt1).length;
const h5 = r.filter(x => x.hitsAt5).length;
const h10 = r.filter(x => x.hitsAt10).length;
console.log(((h1/t)*100).toFixed(1) + '|' + ((h5/t)*100).toFixed(1) + '|' + ((h10/t)*100).toFixed(1));
" 2>/dev/null)
				IFS='|' read -r r1 r5 r10 <<<"$stats"
				echo "| ${desc} | ✅ | ${r1}% | ${r5}% | ${r10}% | — |"
			else
				# Check if a log exists (running)
				local log_file="$LOG_DIR/phase4-${tag}.log"
				if [ -f "$log_file" ]; then
					local progress
					progress=$(grep -oE "Qwen progress: [0-9]+/[0-9]+" "$log_file" | tail -1)
					echo "| ${desc} | 🟡 ${progress:-running} | — | — | — | — |"
				else
					echo "| ${desc} | ⏸ pending | — | — | — | — |"
				fi
			fi
		done
		echo
		echo "## Latest run-log entries"
		echo
		echo '```'
		tail -20 "$LOG_DIR/phase4-run.log" 2>/dev/null
		echo '```'
	} >"$STATUS_FILE.tmp"
	mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

# Run forever
while true; do
	snapshot
	# Stop if orchestrator is gone AND no eval-prod-replica running
	if ! pgrep -f "run-phase4-overnight.sh" >/dev/null 2>&1; then
		if ! pgrep -f "eval-prod-replica.ts" >/dev/null 2>&1; then
			snapshot  # Final snapshot
			echo "Monitor: orchestrator finished, exiting"
			break
		fi
	fi
	sleep 300  # 5 min
done
