#!/usr/bin/env bash
# Wrapper around `astro build` that shows progress percentage.
# Usage: bash build-with-progress.sh
set -euo pipefail

# ── Fetch the published lastmod state (src/lib/page-lastmod.ts) ──
# The previous build's per-page content hashes + change dates, so this build
# carries dates forward and only moves <lastmod> where content changed.
# Only a 404 (never published) bootstraps every page to 2026-09-23; any other
# failure makes fetch-lastmod.ts exit 1 and this script stops, because a reset
# state published over the existing one would wipe every date
# (LASTMOD_ALLOW_BOOTSTRAP=1 to reset on purpose). The file stays outside dist/
# for scripts/seo/indexnow.ts after the deploy.
rm -f .lastmod-prev.json
unset LASTMOD_PREV_PATH LASTMOD_BOOTSTRAP
echo "[build] Fetching published lastmod.json..."
LASTMOD_MODE=$(bun scripts/fetch-lastmod.ts .lastmod-prev.json "${SITE_URL:-https://leyabierta.es}")
if [ "$LASTMOD_MODE" = "prev" ]; then
  export LASTMOD_PREV_PATH="$(pwd)/.lastmod-prev.json"
elif [ "$LASTMOD_MODE" = "bootstrap" ]; then
  export LASTMOD_BOOTSTRAP=1
else
  echo "[build] ERROR: unexpected fetch-lastmod result '${LASTMOD_MODE}'" >&2
  exit 1
fi

# Resolve laws directory: LAWS_PATH is relative to repo root (2 levels up from packages/web)
REPO_ROOT="$(cd ../.. && pwd)"
LAWS_DIR="${REPO_ROOT}/${LAWS_PATH:-../leyes}"
if [ ! -d "$LAWS_DIR" ]; then
  echo "[build] ERROR: laws directory $LAWS_DIR does not exist (set LAWS_PATH, relative to the repo root)" >&2
  exit 1
fi
TOTAL=$(find "$LAWS_DIR" -name "*.md" -type f | wc -l | tr -d ' ')

# No laws = a site without its law pages: fatal, except for local/smoke builds.
if [ "$TOTAL" -eq 0 ]; then
  if [ "${ALLOW_MISSING_MANIFESTS:-}" != "1" ]; then
    echo "[build] ERROR: no .md laws in $LAWS_DIR. Refusing to build a site without law pages (ALLOW_MISSING_MANIFESTS=1 for local/smoke builds)." >&2
    exit 1
  fi
  echo "[build] WARNING: no laws in $LAWS_DIR — building without them (ALLOW_MISSING_MANIFESTS=1)"
  bunx astro build
  exec bash scripts/check-asset-count.sh dist
fi

# ── Build manifests: REQUIRED ──
# The law pages' own content (citizen summaries, reform headlines, article
# summaries) comes only from these two files. On 2026-09-24 a transport error
# on the ~100 MB article manifest was only a warning and the deploy published
# 12k fichas without article summaries. So each manifest is retried with
# backoff, validated (JSON, expected shape, minimum size) and, if it still
# fails, the build stops: better no deploy than a deploy without content.
# ALLOW_MISSING_MANIFESTS=1 (local builds, CI smoke builds without the API)
# keeps the old behaviour: warn and build without that manifest.
MANIFEST_ATTEMPTS="${MANIFEST_ATTEMPTS:-4}"
# Sizes on 2026-09-24: main 10.4 MB, articles ~100 MB.
MIN_BUILD_MANIFEST_BYTES="${MIN_BUILD_MANIFEST_BYTES:-5000000}"
MIN_ARTICLES_MANIFEST_BYTES="${MIN_ARTICLES_MANIFEST_BYTES:-50000000}"

# fetch_manifest <label> <path> <out-file> <main|articles> <min-bytes> <max-time>
# Returns 0 when <out-file> holds a valid manifest.
fetch_manifest() {
  local label="$1" path="$2" out="$3" kind="$4" min="$5" max_time="$6"
  local url="${API_URL:-https://api.leyabierta.es}${path}"
  local attempt http rc check delay
  for attempt in $(seq 1 "$MANIFEST_ATTEMPTS"); do
    rm -f "$out"
    rc=0
    http=$(curl -sS --max-time "$max_time" -H "x-api-key: ${API_BYPASS_KEY:-}" \
      -o "$out" -w '%{http_code}' "$url") || rc=$?
    if [ "$rc" -eq 0 ] && [ "$http" = "200" ]; then
      if check=$(bun scripts/check-manifest.ts "$out" "$kind" "$min" 2>&1); then
        echo "[build] ${label} OK (${check}), attempt ${attempt}"
        return 0
      fi
      echo "[build] ${label}: attempt ${attempt}/${MANIFEST_ATTEMPTS} invalid: ${check}"
    else
      echo "[build] ${label}: attempt ${attempt}/${MANIFEST_ATTEMPTS} failed (curl exit ${rc}, HTTP ${http:-none})"
      # A 4xx (bad key, wrong path) will not fix itself: fail now. 408/429
      # are transient and still retried.
      case "$http" in
        408 | 429) ;;
        4??)
          echo "[build] ${label}: HTTP ${http} is not retryable"
          rm -f "$out"
          return 1
          ;;
      esac
    fi
    if [ "$attempt" -lt "$MANIFEST_ATTEMPTS" ]; then
      delay=$((attempt * 10))
      echo "[build] ${label}: retrying in ${delay}s"
      sleep "$delay"
    fi
  done
  rm -f "$out"
  return 1
}

# require_manifest <label> <env-var> <path> <out-file> <kind> <min-bytes> <max-time>
require_manifest() {
  local label="$1" var="$2"
  echo "[build] Fetching ${label}..."
  if fetch_manifest "$label" "$3" "$4" "$5" "$6" "$7"; then
    export "$var=$(pwd)/$4"
  elif [ "${ALLOW_MISSING_MANIFESTS:-}" = "1" ]; then
    echo "[build] WARNING: ${label} unavailable; building without it (ALLOW_MISSING_MANIFESTS=1)"
  else
    echo "[build] ERROR: ${label} unavailable (see the attempts above). Refusing to build a site without its own content (ALLOW_MISSING_MANIFESTS=1 for local/smoke builds)." >&2
    exit 1
  fi
}

# Main manifest: citizen summaries, tags, materias, omnibus, reform headlines
# (1 API call instead of ~12K per-page calls).
require_manifest "build manifest" BUILD_MANIFEST_PATH \
  /v1/build-manifest .build-manifest.json main "$MIN_BUILD_MANIFEST_BYTES" 120
# Article summaries: shipped separately because of its size; baked into the
# static HTML (SEO-visible) instead of a client fetch.
require_manifest "article-summaries manifest" BUILD_ARTICLE_SUMMARIES_PATH \
  /v1/build-manifest/articles .build-manifest-articles.json articles "$MIN_ARTICLES_MANIFEST_BYTES" 300

echo "[build] Building $TOTAL law pages + static pages"
START=$(date +%s)

# Use process substitution instead of pipe to avoid subshell variable scoping.
# In a pipe (cmd | while read), the while loop runs in a subshell so COUNT
# never increments in the parent shell. Process substitution keeps everything
# in the same shell. A process substitution's exit status is lost (and
# `wait $!` needs bash >= 4.4), so astro's status comes as the last line,
# after a newline in case astro's last output lacks one. (No quotes in
# comments inside the substitution: bash 3.2 misparses them.)
COUNT=0
BUILD_STATUS=""
while IFS= read -r line; do
  if [[ "$line" == __ASTRO_BUILD_EXIT__=* ]]; then
    BUILD_STATUS="${line#__ASTRO_BUILD_EXIT__=}"
  elif echo "$line" | grep -qE '├─|└─|\(\+[0-9]'; then
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
done < <(
  set +e
  bunx astro build 2>&1
  rc=$?
  printf '\n__ASTRO_BUILD_EXIT__=%s\n' "$rc"
)

# A failed build must fail this script: otherwise the asset guard passes and
# a partial dist/ could be deployed.
if [ "$BUILD_STATUS" != "0" ]; then
  echo "[build] ERROR: astro build failed (exit ${BUILD_STATUS:-unknown})" >&2
  exit "${BUILD_STATUS:-1}"
fi

ELAPSED=$(( $(date +%s) - START ))
echo "[build] Done: $COUNT pages in ${ELAPSED}s"

# Workers Free caps a deploy at 20,000 static assets: fail here, clearly,
# rather than at `wrangler deploy` (see scripts/check-asset-count.sh).
bash scripts/check-asset-count.sh dist
