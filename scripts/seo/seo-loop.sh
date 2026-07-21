#!/usr/bin/env bash
# Autonomous biweekly SEO loop for leyabierta.es.
#
#   pull GSC + Umami  →  model proposes a plan  →  claude -p implements it
#   →  verify (tsgo + biome + build)  →  open a PR  →  append PROGRESS.md
#
# It NEVER pushes to main or deploys. A human reviews and merges the PR.
# See .goals/seo/GOAL.md and .goals/seo/PLAYBOOK.md.
#
# Env (from ${SEO_ENV_FILE:-/opt/leyabierta/.env.seo}, mode 600):
#   SEO_GSC_SA_JSON      path to the GSC service-account key JSON
#   NAN_API_KEY          for nan:* models (the valid token, ending pcNg)
#   claude auth          CLAUDE_CODE_OAUTH_TOKEN (or a prior `claude` login) for
#                        claude:* models and the implement step
# Optional:
#   SEO_MODEL            planning model (default claude:sonnet)
#   SEO_REPO             repo checkout (default /opt/leyabierta/code)
#   SEO_STATE_DIR        persistent dir for iteration counter + PROGRESS/STATE
#   SEO_DEPLOY_KEY       SSH deploy key (r/w) for git push
#                        (default /opt/leyabierta/.ssh/seo_deploy)
#   SEO_DRY_RUN=1        do everything except push (the PR is opened by CI)
#   SEO_RUN_BUILD=1      also run the full local astro build (CI runs it anyway)
#
# No GitHub API token lives on this host: the branch is pushed over SSH with a
# read/write deploy key, and the PR is opened by the seo-open-pr.yml workflow
# using the built-in GITHUB_TOKEN.

set -euo pipefail

# ── Config from the env file FIRST ──────────────────────────────────────────
# The env file may set SEO_REPO / SEO_MODEL / SEO_STATE_DIR / PATH, so it must
# be sourced before those defaults are resolved (sourcing it later left REPO
# pinned to the wrong default and the loop wrote to the prod checkout).
ENV_FILE="${SEO_ENV_FILE:-/opt/leyabierta/.env.seo}"
if [ -f "$ENV_FILE" ]; then
	set -a; # shellcheck disable=SC1090
	source "$ENV_FILE"; set +a
fi

REPO="${SEO_REPO:-/opt/leyabierta/code}"
MODEL="${SEO_MODEL:-claude:sonnet}"
STATE_DIR="${SEO_STATE_DIR:-/opt/leyabierta/seo-state}"
DATE="$(date +%F)"

cd "$REPO"

# ── Single-instance lock ────────────────────────────────────────────────────
exec 9>"/var/lock/leyabierta-seo-loop.lock" || exec 9>"/tmp/leyabierta-seo-loop.lock"
flock -n 9 || { echo "another seo-loop is already running"; exit 0; }

mkdir -p "$STATE_DIR"
IT_FILE="$STATE_DIR/iteration"
ITER="$(( $(cat "$IT_FILE" 2>/dev/null || echo 0) + 1 ))"
export SEO_ITERATION="$ITER"
# Keep the persistent bitácora reachable by the TS scripts (data/seo is gitignored).
export SEO_DATA_DIR="$REPO/data/seo"
mkdir -p "$SEO_DATA_DIR"
# Carry the running STATE/PROGRESS in from the persistent dir.
cp -f "$STATE_DIR/STATE.md"    "$SEO_DATA_DIR/STATE.md"    2>/dev/null || true
cp -f "$STATE_DIR/PROGRESS.md" "$SEO_DATA_DIR/PROGRESS.md" 2>/dev/null || true

BRANCH="seo-loop/iter-${ITER}-${DATE}"
echo "== SEO loop · iter ${ITER} · ${DATE} · model=${MODEL} =="

# ── Fresh branch off main ───────────────────────────────────────────────────
git fetch --quiet origin main
git checkout -q -B "$BRANCH" origin/main
# Start from a pristine tree: discard leftovers from a previous aborted run (the
# implement step edits the working tree before we commit). `git clean` without
# -x leaves gitignored data/ + node_modules untouched.
git reset -q --hard origin/main
git clean -fdq

# ── 1. Snapshots ────────────────────────────────────────────────────────────
bun run scripts/seo/pull-gsc.ts
bun run scripts/seo/pull-umami.ts

# ── 2. Plan ─────────────────────────────────────────────────────────────────
MODEL="$MODEL" bun run scripts/seo/plan.ts
PLAN_FILE="$(ls -t "$SEO_DATA_DIR"/plan-*-"${DATE}".json | head -1)"
echo "plan: $PLAN_FILE"

# Refresh STATE.md so the next iteration has current context (it was read but
# never written before).
bun run scripts/seo/write-state.ts "$PLAN_FILE" || true

# ── 3. Implement via claude -p ──────────────────────────────────────────────
read -r -d '' PROMPT <<EOF || true
You are the implementer of the leyabierta.es SEO loop. Apply the action plan in
${PLAN_FILE}. Hard rules:
- Obey .goals/seo/PLAYBOOK.md exactly. Only edit whitelisted paths.
- SKIP any action with requiresHumanReview=true, and any action touching a
  blacklisted path — note it in the summary instead.
- Keep legal accuracy sacred: never misrepresent a norm to rank.
- After editing, ensure \`bun run check\` (biome) passes. If a change breaks it,
  revert just that change. Do NOT run tsgo/tsc: it is not configured for the
  Astro web package and floods hundreds of pre-existing false errors — ignore it.
- Do NOT git commit, git push, open PRs, or touch main — leave your edits in the
  working tree; the loop stages, commits and pushes them.
- You do NOT need to run \`astro build\` to verify: CI builds the PR. Skip it to
  save time unless you specifically need to confirm a risky change compiles.
- Write a short summary of what you applied/skipped to ${SEO_DATA_DIR}/impl-${DATE}.md.
EOF

if command -v claude >/dev/null 2>&1; then
	claude -p "$PROMPT" --permission-mode acceptEdits --allowedTools "Bash Edit Write Read Glob Grep" \
		|| echo "warning: claude implement step returned non-zero"
else
	echo "ERROR: claude CLI not found — cannot implement" >&2
	exit 1
fi

# ── 4. Verify ───────────────────────────────────────────────────────────────
# Match how the repo actually gates (there is NO tsgo/tsc/astro-check step in
# CI): biome here for a fast local check, and the full astro build as the real
# type+build gate. The build runs on the PR via pr-checks.yml (push to
# seo-loop/**); locally it is opt-in (SEO_RUN_BUILD=1) because the 12k-page
# build is slow and needs the leyes content.
# NOTE: `bunx tsgo --noEmit` from the repo root does NOT work for the Astro web
# package (it needs `astro sync`-generated types + the web tsconfig's DOM lib)
# and floods hundreds of false errors, so it is deliberately not used here.
echo "verifying…"
bun run check
if [ "${SEO_RUN_BUILD:-0}" = "1" ]; then
	bun run --cwd packages/web astro build
fi

# ── 5. Commit + push (skip if nothing changed) ──────────────────────────────
# Stage/inspect ONLY the whitelisted source tree. This matches the PLAYBOOK
# whitelist (defence-in-depth: nothing outside it can ever be committed) and
# avoids the footgun that `git add -A -- ':!data'` exits 1 on gitignored paths —
# data/, plus dist//.astro that the implementer's optional `astro build` leaves
# behind — which under `set -e` aborted the run before it could commit or push.
WHITELIST='packages/web/src'
if git diff --quiet -- "$WHITELIST" && git diff --cached --quiet -- "$WHITELIST"; then
	echo "no source changes produced — nothing to PR"
	echo "$ITER" > "$IT_FILE"
	exit 0
fi

git add -A -- "$WHITELIST"

SUMMARY="$(cat "$SEO_DATA_DIR/impl-${DATE}.md" 2>/dev/null || echo "(no implementer summary)")"
# The PR title + body travel in the commit message: seo-open-pr.yml reads
# `git log -1 --format=%s` (subject → title) and `%b` (body → PR body). Keep the
# subject short; the body is markdown.
PR_TITLE="SEO loop · iter ${ITER} (${DATE})"
PR_BODY="$(printf 'Automated iteration **%s** of the SEO loop (model: `%s`).\n\nPlan: `%s`\n\n## What the implementer applied\n%s\n\n> Generated by scripts/seo/seo-loop.sh. Review against .goals/seo/PLAYBOOK.md before merging.' \
	"$ITER" "$MODEL" "$(basename "$PLAN_FILE")" "$SUMMARY")"

git commit -q -F - <<EOF
${PR_TITLE}

${PR_BODY}
EOF

if [ "${SEO_DRY_RUN:-0}" = "1" ]; then
	echo "DRY RUN — would push $BRANCH via the deploy key (PR opened by seo-open-pr.yml). Diff:"
	git --no-pager diff --stat origin/main
else
	# Push over SSH with the read/write deploy key. This push is made by the
	# deploy key (NOT GITHUB_TOKEN), so it triggers seo-open-pr.yml, which opens
	# the PR — no PAT and no API token ever live on this host.
	DEPLOY_KEY="${SEO_DEPLOY_KEY:-/opt/leyabierta/.ssh/seo_deploy}"
	if [ ! -f "$DEPLOY_KEY" ]; then
		echo "ERROR: deploy key not found at $DEPLOY_KEY — cannot push." >&2
		exit 1
	fi
	git -c core.sshCommand="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
		push -q git@github.com:leyabierta/leyabierta.git "HEAD:refs/heads/${BRANCH}"
	echo "pushed ${BRANCH} — seo-open-pr.yml will open the PR."
fi

# ── 6. Persist bitácora + counter ───────────────────────────────────────────
{
	echo ""
	echo "## Iter ${ITER} — ${DATE} (model: ${MODEL})"
	echo "$SUMMARY"
} >> "$STATE_DIR/PROGRESS.md"
cp -f "$SEO_DATA_DIR/STATE.md" "$STATE_DIR/STATE.md" 2>/dev/null || true
echo "$ITER" > "$IT_FILE"
echo "== done · iter ${ITER} =="
