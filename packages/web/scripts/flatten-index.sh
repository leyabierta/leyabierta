#!/usr/bin/env bash
# flatten-index.sh — Converts nested index.html files to flat .html files.
#
# Cloudflare Pages auto-redirects /path/ → /path (308) when the file is
# /path/index.html. By renaming to /path.html and removing the empty dir,
# CF Pages serves /path directly — no redirect, no SEO penalty.
#
# Only processes directories 2+ levels deep (skips top-level index.html).
# Run after `astro build`: bun run build && bash scripts/flatten-index.sh

set -euo pipefail

DIST_DIR="${1:-dist}"

if [ ! -d "$DIST_DIR" ]; then
  echo "Error: dist directory '$DIST_DIR' not found"
  exit 1
fi

count=0

# Use process substitution to avoid subshell (preserves count variable)
while read -r file; do
  dir="$(dirname "$file")"
  parent="$(dirname "$dir")"
  name="$(basename "$dir")"

  # Skip if parent already has a file with that name
  if [ -f "$parent/$name.html" ]; then
    echo "SKIP: $parent/$name.html already exists"
    continue
  fi

  # Only flatten if index.html is the sole file in the directory
  file_count="$(find "$dir" -maxdepth 1 -type f | wc -l | tr -d ' ')"
  if [ "$file_count" -ne 1 ]; then
    continue
  fi

  mv "$file" "$parent/$name.html"
  rmdir "$dir" 2>/dev/null || true
  count=$((count + 1))
done < <(find "$DIST_DIR" -mindepth 2 -name "index.html" -type f)

echo "Flattened $count index.html files"
