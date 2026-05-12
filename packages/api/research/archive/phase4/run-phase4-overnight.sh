#!/usr/bin/env bash
# Phase 4 overnight orchestrator (v2). Runs an extended variant matrix on the
# NaN-only stack to find the best Qwen-side intervention vs Gemini baseline.
#
# Variants (all on raw-text Qwen index unless noted):
#   v1  no-instruct                 baseline (already done; reused via cache)
#   v2  hyde         (qwen3.6 base, embed-rewrite-only)
#   v3  hyde-short   (qwen3.6 short 1-sentence)
#   v4  hyde-keywords (qwen3.6 comma-list of legal terms)
#   v5  hyde-gemma4  (gemma4 base prompt)
#   v6  summary      (citizen-summary index, no HyDE)
#   v7  hyde-summary (BEST_HYDE_MODE × summary index)
#   v8  multi        (post-hoc merge: v1 + v6)
#   v9  hyde-multi   (post-hoc merge: best-hyde-raw + v7)
#
# All eval runs use HYDE_MODE=embed-rewrite-only (rewrite replaces query for
# vector embedding only; original goes to BM25/analyzer). Each variant pass
# is named eval-pass-qwen-<tag>.json and is resume-safe.

set -uo pipefail

cd "$(dirname "$0")/../../../.."

LOG_DIR=data/ab-results
mkdir -p "$LOG_DIR"
RUN_LOG="$LOG_DIR/phase4-run.log"

log() {
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$RUN_LOG"
}

run_variant() {
	# args: <file_tag> <log_label> [extra_args...]
	# file_tag is the FULL tag (after "no-instruct-"); we let the harness add
	# "no-instruct-" prefix automatically by passing --tag <file_tag> with
	# parts that do NOT include "hyde", "summary", "multi" — those come from
	# their own flags. To avoid double-tagging, we strip those parts here.
	local file_tag_full="$1"  # e.g. "hyde-keywords" or "summary"
	local log_label="$2"
	shift 2
	local extra_args=("$@")

	local out_json="$LOG_DIR/eval-pass-qwen-no-instruct-$file_tag_full.json"
	local out_log="$LOG_DIR/phase4-no-instruct-$file_tag_full.log"

	log "=== Variant: no-instruct-$file_tag_full ($log_label) ==="
	log "  args: ${extra_args[*]:-(none)}"
	if [ -f "$out_json" ]; then
		log "  ✅ Already done, skipping"
		return 0
	fi

	# Compute the --tag component: strip "hyde", "summary", "multi" tokens
	# (those will be auto-added by the harness from --hyde/--summary-index/etc).
	local tag_token=""
	for t in $(echo "$file_tag_full" | tr '-' ' '); do
		if [ "$t" = "hyde" ] || [ "$t" = "summary" ] || [ "$t" = "multi" ]; then
			continue
		fi
		if [ -z "$tag_token" ]; then
			tag_token="$t"
		else
			tag_token="$tag_token-$t"
		fi
	done

	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
	local tag_args=()
	if [ -n "$tag_token" ]; then
		tag_args=(--tag "$tag_token")
	fi

	log "  Running... (tag_token=\"$tag_token\")"
	if HYDE_MODE=embed-rewrite-only RAG_VECTOR_POOL_WORKERS=1 \
		bun packages/api/research/ab/eval-prod-replica.ts \
		--full --only-qwen --no-instruct \
		"${tag_args[@]}" \
		"${extra_args[@]}" \
		>"$out_log" 2>&1; then
		if [ -f "$out_json" ]; then
			log "  ✅ Saved $(basename "$out_json")"
			grep -E "Gemini-2|Qwen-NAN |R@1 gap|R@5 gap" "$out_log" | tail -5 | tee -a "$RUN_LOG"
		else
			log "  ⚠ Eval ran but $out_json not produced"
			log "  ⚠ Tail of $out_log:"
			tail -20 "$out_log" | tee -a "$RUN_LOG"
		fi
	else
		log "  ❌ Failed — tail of $out_log:"
		tail -30 "$out_log" | tee -a "$RUN_LOG"
	fi
}

wait_for_summary_embed() {
	local max_wait=${MAX_EMBED_WAIT_SECONDS:-14400}  # 4h default
	local started
	started=$(date +%s)
	log "=== Waiting for citizen-summary embedding (max ${max_wait}s = $((max_wait / 60))min) ==="
	local poll=0
	local relaunches=0
	while true; do
		local now
		now=$(date +%s)
		local elapsed=$((now - started))
		if [ "$elapsed" -ge "$max_wait" ]; then
			log "  ⏰ Max wait reached (${elapsed}s) — proceeding with current coverage"
			return 0
		fi
		local running
		running=$(pgrep -f "embed-citizen-summaries.ts" || true)
		if [ -z "$running" ]; then
			if grep -q "^✅ Done:" "$LOG_DIR/embed-citizen-summaries.log" 2>/dev/null; then
				log "  ✅ Embed completed"
				return 0
			fi
			log "  ⚠ Embed process gone but no Done marker (relaunch #$((relaunches + 1)))"
			tail -5 "$LOG_DIR/embed-citizen-summaries.log" 2>/dev/null | tee -a "$RUN_LOG"
			if [ "$relaunches" -ge 5 ]; then
				log "  ⚠ Too many relaunches; proceeding with current coverage"
				return 0
			fi
			set -a
			# shellcheck disable=SC1091
			source .env
			set +a
			nohup bun packages/api/research/ab/embed-citizen-summaries.ts --priority-norms data/ab-results/eval-priority-norms.txt \
				>>"$LOG_DIR/embed-citizen-summaries.log" 2>&1 &
			disown
			relaunches=$((relaunches + 1))
			sleep 60
		else
			poll=$((poll + 1))
			if [ $((poll % 4)) -eq 0 ]; then
				local progress
				progress=$(tail -1 "$LOG_DIR/embed-citizen-summaries.log" 2>/dev/null | tr -d '\r' | head -c 200)
				log "  ⏳ Still embedding (PID $running, ${elapsed}s elapsed): $progress"
			fi
			sleep 60
		fi
	done
}

run_multi_vector() {
	local raw_tag="$1"
	local summary_tag="$2"
	local label="$3"
	log "=== Multi-vector merge: $label ==="
	local out_json="$LOG_DIR/eval-pass-qwen-$label.json"
	if [ -f "$out_json" ]; then
		log "  ✅ Already done"
		return 0
	fi
	if [ ! -f "$LOG_DIR/eval-pass-qwen-$raw_tag.json" ] || [ ! -f "$LOG_DIR/eval-pass-qwen-$summary_tag.json" ]; then
		log "  ⚠ Skipping — missing inputs"
		return 0
	fi
	bun packages/api/research/ab/multi-vector-merge.ts \
		--raw "eval-pass-qwen-$raw_tag.json" \
		--summary "eval-pass-qwen-$summary_tag.json" \
		--gemini "eval-pass-gemini-baseline.json" \
		--label "$label" \
		>"$LOG_DIR/phase4-$label.log" 2>&1
	log "  ✅ $(basename "$out_json")"
	tail -25 "$LOG_DIR/phase4-$label.log" | tee -a "$RUN_LOG"
}

best_hyde_raw_tag() {
	# Determine the best HyDE-raw variant from the 4 HyDE pass files (highest R@1).
	# Used for picking which HyDE prompt to combine with the summary index.
	local best_tag=""
	local best_r1=-1
	for t in hyde hyde-short hyde-keywords hyde-gemma4; do
		local f="$LOG_DIR/eval-pass-qwen-no-instruct-$t.json"
		[ -f "$f" ] || continue
		local r1
		r1=$(bun -e "const f = await Bun.file('$f').json(); const total = f.results.length; const hits = f.results.filter(r => r.hitsAt1).length; console.log(((hits/total)*100).toFixed(1));" 2>/dev/null || echo "0")
		if awk -v a="$r1" -v b="$best_r1" 'BEGIN { exit !(a > b) }'; then
			best_r1=$r1
			best_tag=$t
		fi
	done
	echo "no-instruct-$best_tag"
}

log "=== Phase 4 overnight start (v2) ==="
log "PID $$"

# --- Tier 1: HyDE prompt variants on raw-text index ---
# Note: tag_token is auto-computed by run_variant from file_tag_full minus
# {hyde,summary,multi} keywords. So "hyde-short" → tag_token="short" → harness
# auto-adds "hyde" via --hyde and "short" via our --tag. Pass --hyde-cache
# without an additional --tag (we don't double-tag here).
run_variant "hyde" "qwen3.6 base prompt" --hyde --hyde-cache "hyde-cache.json"
run_variant "hyde-short" "qwen3.6 short" --hyde --hyde-cache "hyde-cache-short.json"
run_variant "hyde-keywords" "qwen3.6 keywords" --hyde --hyde-cache "hyde-cache-keywords.json"
run_variant "hyde-gemma4" "gemma4 base" --hyde --hyde-cache "hyde-cache-gemma4.json"

# --- Wait for summary embed (4h max) ---
wait_for_summary_embed

# --- Tier 2: summary-index variants ---
run_variant "summary" "raw query × summary index" --summary-index

BEST_HYDE_TAG=$(best_hyde_raw_tag)
log "  Best HyDE variant: $BEST_HYDE_TAG"
case "$BEST_HYDE_TAG" in
	*-hyde) run_variant "hyde-summary" "qwen3.6 base × summary" --hyde --hyde-cache hyde-cache.json --summary-index ;;
	*-hyde-short) run_variant "hyde-short-summary" "short × summary" --hyde --hyde-cache hyde-cache-short.json --summary-index ;;
	*-hyde-keywords) run_variant "hyde-keywords-summary" "keywords × summary" --hyde --hyde-cache hyde-cache-keywords.json --summary-index ;;
	*-hyde-gemma4) run_variant "hyde-gemma4-summary" "gemma4 × summary" --hyde --hyde-cache hyde-cache-gemma4.json --summary-index ;;
	*) log "  ⚠ No HyDE winner; skipping v7" ;;
esac

# --- Tier 3: post-hoc multi-vector merges ---
run_multi_vector "no-instruct" "no-instruct-summary" "multi-no-instruct"

# Use the best-hyde for the multi-vector
case "$BEST_HYDE_TAG" in
	*-hyde) run_multi_vector "no-instruct-hyde" "no-instruct-hyde-summary" "multi-hyde" ;;
	*-hyde-short) run_multi_vector "no-instruct-hyde-short" "no-instruct-hyde-short-summary" "multi-hyde-short" ;;
	*-hyde-keywords) run_multi_vector "no-instruct-hyde-keywords" "no-instruct-hyde-keywords-summary" "multi-hyde-keywords" ;;
	*-hyde-gemma4) run_multi_vector "no-instruct-hyde-gemma4" "no-instruct-hyde-gemma4-summary" "multi-hyde-gemma4" ;;
esac

log "=== Phase 4 done — extra merges + final report ==="
bash packages/api/research/ab/phase4-extra-merges.sh >>"$RUN_LOG" 2>&1 || true
bun packages/api/research/ab/phase4-report.ts >>"$RUN_LOG" 2>&1 || true
bun packages/api/research/ab/phase4-vault-summary.ts >>"$RUN_LOG" 2>&1 || true
log "Final report: $LOG_DIR/phase4-results.md"
log "Vault summary: ~/Documents/Obsidian Vault/10-Projects/Ley-Abierta/research/2026-05-10-phase4-results.md"
