#!/usr/bin/env bash
# Run AFTER the main orchestrator. Computes additional post-hoc multi-vector
# merges that were not pre-baked into the main run:
#
#   query-multi-X: merge baseline (raw, no HyDE) + each HyDE-X variant.
#                  This is "multi-vector at the query level" — same index
#                  searched with original AND HyDE query, top-K merged.
#
#   raw-multi-best: merge of the two best-performing raw-text variants.
#
# All merges via multi-vector-merge.ts (which takes any two pass files).

set -uo pipefail
cd "$(dirname "$0")/../../../.."

LOG_DIR=data/ab-results

run_merge() {
	local raw="$1"
	local hyde="$2"
	local label="$3"
	if [ ! -f "$LOG_DIR/eval-pass-qwen-$raw.json" ] || [ ! -f "$LOG_DIR/eval-pass-qwen-$hyde.json" ]; then
		echo "Skip $label: missing inputs"
		return 0
	fi
	bun packages/api/research/ab/multi-vector-merge.ts \
		--raw "eval-pass-qwen-$raw.json" \
		--summary "eval-pass-qwen-$hyde.json" \
		--gemini "eval-pass-gemini-baseline.json" \
		--label "$label" \
		>"$LOG_DIR/phase4-$label.log" 2>&1
	echo "✅ $label"
	tail -25 "$LOG_DIR/phase4-$label.log"
}

# Query-level multi-vector: baseline + each HyDE variant
for v in hyde hyde-short hyde-keywords hyde-gemma4; do
	run_merge "no-instruct" "no-instruct-$v" "query-multi-$v"
done

# All-pairs HyDE merges (best HyDE × another HyDE)
run_merge "no-instruct-hyde-keywords" "no-instruct-hyde-short" "hyde-keywords-x-short"
run_merge "no-instruct-hyde" "no-instruct-hyde-keywords" "hyde-base-x-keywords"
run_merge "no-instruct-hyde" "no-instruct-hyde-short" "hyde-base-x-short"
run_merge "no-instruct-hyde-gemma4" "no-instruct-hyde-keywords" "hyde-gemma4-x-keywords"

echo
echo "=== All extra merges done ==="
