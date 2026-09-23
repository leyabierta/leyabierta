#!/usr/bin/env bash
# Fail the build when dist/ has more static files than a Worker deploy allows.
#
# The Cloudflare Workers Free plan caps a Worker version at 20,000 static
# asset files; above that `wrangler deploy` fails and production stays on the
# previous build (that is how #181's /leyes/[id]/texto/ pages, ~24,900 files,
# broke the deploy). We stop at 19,000 so there is margin, and fail here,
# where the message is clear, instead of at the deploy step.
#
# Counted like wrangler's asset manifest (buildAssetManifest): every regular
# file under the assets directory, minus the metafiles it ignores at the root
# (.assetsignore, _headers, _redirects). Patterns inside a dist/.assetsignore
# are NOT applied, so this can only over-count (safe side). Note: wrangler's
# "Read N files from the assets directory" line counts directories too (it is
# a raw recursive readdir), so it shows roughly twice this number.
#
# Usage: bash scripts/check-asset-count.sh [dist-dir] [limit]
set -euo pipefail

DIST="${1:-dist}"
LIMIT="${2:-${MAX_STATIC_ASSETS:-19000}}"

if [ ! -d "$DIST" ]; then
  echo "[assets] ERROR: $DIST does not exist — did the build run?" >&2
  exit 1
fi

COUNT=$(find "$DIST" -type f \
  ! -path "$DIST/.assetsignore" ! -path "$DIST/_headers" ! -path "$DIST/_redirects" \
  | wc -l | tr -d ' ')

if [ "$COUNT" -gt "$LIMIT" ]; then
  echo "[assets] ERROR: $DIST has $COUNT static files; the limit is $LIMIT." >&2
  echo "[assets] Cloudflare Workers Free rejects deploys with more than 20,000 static assets," >&2
  echo "[assets] so this build would not deploy. Find what added files (e.g. a new page per law;" >&2
  echo "[assets] /leyes/[id]/texto/ is behind BUILD_TEXT_PAGES for this reason) and cut it back." >&2
  exit 1
fi

echo "[assets] $COUNT static files in $DIST (limit $LIMIT, Workers Free max 20,000)"
