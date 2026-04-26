#!/bin/bash
# upload-db-snapshot.sh — Publish a public snapshot of leyabierta.db.
#
# Two snapshots are produced per run:
#   1. leyes-snapshot-YYYY-MM-DD.db.gz       — main product, no embeddings, ~2 GB
#   2. leyes-embeddings-YYYY-MM-DD.db.gz     — opt-in, embeddings table only, ~3 GB
#
# Both are uploaded to Hugging Face Datasets (primary, discoverability) and to
# archive.org (mirror, permanence). A public manifest JSON is updated with the
# last 12 snapshots (3 months of weekly retention).
#
# Hosting choice rationale: HF Datasets gives the project visibility in the
# legaltech / data community and free egress; archive.org gives permanent
# citable URLs (`leyabierta-snapshot-YYYY-MM-DD`). Both align with the
# "datos abiertos" ethos of the project. See docs/ADRs/001-public-database-snapshot.md.
#
# Usage:
#   scripts/upload-db-snapshot.sh                # full run
#   scripts/upload-db-snapshot.sh --dry-run      # build snapshots locally, do not upload
#   scripts/upload-db-snapshot.sh --skip-hf      # skip Hugging Face upload
#   scripts/upload-db-snapshot.sh --skip-ia      # skip archive.org upload
#   scripts/upload-db-snapshot.sh --keep-local   # do not delete local snapshots after upload
#
# Required environment (in production cron):
#   HF_TOKEN              — Hugging Face write token (huggingface-cli login alt.)
#   IA_ACCESS_KEY         — archive.org S3 access key
#   IA_SECRET_KEY         — archive.org S3 secret key
#   SSH_TARGET            — defaults to KonarServer
#
# Tooling required on the runner:
#   - ssh, gzip, sha256sum, jq
#   - sqlite3 (CLI, for verification)
#   - huggingface-cli (pip install --user huggingface_hub) OR curl + manual API
#   - ia (pip install --user internetarchive)
#
# This script never executes destructive operations against production data.
# It uses sqlite3 .backup for an online, non-blocking copy, then mutates only
# the local copy.

set -euo pipefail

# ─── Config ─────────────────────────────────────────────────────────────────

SSH_TARGET="${SSH_TARGET:-KonarServer}"
REMOTE_CONTAINER="${REMOTE_CONTAINER:-code-api-1}"
REMOTE_DB_PATH="${REMOTE_DB_PATH:-/data/leyabierta.db}"
REMOTE_TMP_DIR="${REMOTE_TMP_DIR:-/tmp/leyabierta-snapshot}"
LOCAL_OUT_DIR="${LOCAL_OUT_DIR:-./snapshots-out}"
HF_REPO="${HF_REPO:-leyabierta/leyes-snapshot}"
IA_COLLECTION="${IA_COLLECTION:-leyabierta}"
RETENTION_COUNT="${RETENTION_COUNT:-12}"
MANIFEST_PATH="${MANIFEST_PATH:-${LOCAL_OUT_DIR}/manifest.json}"

# Tables that MUST be removed from any public snapshot. RGPD / privacy.
# Subscribers contain emails + HMAC tokens. ask_log can contain user PII in
# free-form questions. The tracking tables are operational state with no
# value for downstream users.
PRIVATE_TABLES=(
	subscribers
	ask_log
	notified_reforms
	norm_follows
	digests
	notification_runs
)

DRY_RUN=0
SKIP_HF=0
SKIP_IA=0
KEEP_LOCAL=0

for arg in "$@"; do
	case "$arg" in
		--dry-run) DRY_RUN=1 ;;
		--skip-hf) SKIP_HF=1 ;;
		--skip-ia) SKIP_IA=1 ;;
		--keep-local) KEEP_LOCAL=1 ;;
		-h|--help)
			# Print the leading comment block (everything up to the first
			# blank line that is followed by a non-comment line — i.e. the
			# header). Won't truncate as the script grows.
			awk '/^#/{print; next} {exit}' "$0" | sed 's/^# \?//'
			exit 0
			;;
		*)
			echo "Unknown argument: $arg" >&2
			exit 2
			;;
	esac
done

DATE_TAG="$(date -u +%Y-%m-%d)"
MAIN_NAME="leyes-snapshot-${DATE_TAG}.db"
EMB_NAME="leyes-embeddings-${DATE_TAG}.db"
IA_ITEM="leyabierta-snapshot-${DATE_TAG}"

mkdir -p "$LOCAL_OUT_DIR"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
fail() { echo "FATAL: $*" >&2; exit 1; }

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_cmd ssh
require_cmd gzip
require_cmd sha256sum
require_cmd jq
require_cmd sqlite3

# Always clean up the remote tmp dir on exit, success or failure.
# Without this, a crash in steps 1-6 leaves up to 13 GB of snapshot files
# on the production server in REMOTE_TMP_DIR until the operator notices.
# `2>/dev/null || true` keeps the trap from masking the real exit code.
cleanup_remote() {
	ssh "$SSH_TARGET" "rm -rf ${REMOTE_TMP_DIR}" 2>/dev/null || true
}
trap cleanup_remote EXIT

# ─── Step 1. Online .backup on the production server ────────────────────────
# sqlite3 .backup is online and non-blocking. We run it inside the container
# because the volume mount path is `/data/leyabierta.db`. The host path
# `/opt/leyabierta/code/data/leyabierta.db` would also work but the container
# path is the canonical reference in DEPLOY.md.
#
# `bun run` is used because the container runtime image does not ship with
# the sqlite3 CLI. Bun's bun:sqlite supports the backup() API.

log "Step 1/7  online .backup on ${SSH_TARGET}:${REMOTE_DB_PATH}"

ssh "$SSH_TARGET" "mkdir -p ${REMOTE_TMP_DIR}"

# Online backup. We invoke `bun` inside the container because the runtime
# image does not ship the sqlite3 CLI but does ship bun:sqlite, which
# implements VACUUM INTO. We write the snapshot directly to the bind-mount
# (`/data/...` in the container == `/opt/leyabierta/code/data/...` on the
# host), which lets us move it to REMOTE_TMP_DIR with a host-side mv
# instead of `docker cp` (avoids copying 13 GB twice).
ssh "$SSH_TARGET" "docker exec ${REMOTE_CONTAINER} bun -e \"
import { Database } from 'bun:sqlite';
const src = new Database('${REMOTE_DB_PATH}', { readonly: true });
src.exec(\\\"VACUUM INTO '/data/snapshot-${DATE_TAG}.db'\\\");
console.log('backup done /data/snapshot-${DATE_TAG}.db');
\""

ssh "$SSH_TARGET" "mv /opt/leyabierta/code/data/snapshot-${DATE_TAG}.db ${REMOTE_TMP_DIR}/${MAIN_NAME}"

log "  backup done on remote: ${REMOTE_TMP_DIR}/${MAIN_NAME}"

# Steps 2-3 mutate the snapshot copies on the host filesystem. We use the
# host's `sqlite3` CLI (auto-installed once) instead of bun-in-container,
# because REMOTE_TMP_DIR is not bind-mounted into the container — there is
# no clean container path to the snapshot, and adding a mount just for
# this script would change the prod docker-compose.yml.
ssh "$SSH_TARGET" "command -v sqlite3 >/dev/null 2>&1 || sudo apt-get install -qq -y sqlite3"

# ─── Step 2. Strip private tables on the main snapshot ──────────────────────

log "Step 2/7  drop private tables on main snapshot"

DROP_SQL=""
for t in "${PRIVATE_TABLES[@]}"; do
	DROP_SQL="${DROP_SQL}DROP TABLE IF EXISTS ${t}; "
done

ssh "$SSH_TARGET" "sqlite3 ${REMOTE_TMP_DIR}/${MAIN_NAME} '${DROP_SQL}'"

# ─── Step 3. Build embeddings-only snapshot from the same source ───────────
# Cheapest path: copy the just-cleaned snapshot (private tables already
# removed), then drop everything except `embeddings`, then VACUUM. We do
# NOT take a second .backup against prod.

log "Step 3/7  build embeddings-only snapshot"

ssh "$SSH_TARGET" "cp ${REMOTE_TMP_DIR}/${MAIN_NAME} ${REMOTE_TMP_DIR}/${EMB_NAME}.tmp"

# Pipe a generated DROP-list into sqlite3, drop everything except embeddings,
# VACUUM, rename. `sqlite_%` tables are SQLite internals and skip themselves.
ssh "$SSH_TARGET" "sqlite3 ${REMOTE_TMP_DIR}/${EMB_NAME}.tmp \"
SELECT 'DROP TABLE IF EXISTS \\\"' || name || '\\\";'
FROM sqlite_master WHERE type='table'
  AND name NOT LIKE 'sqlite_%'
  AND name != 'embeddings';
\" | sqlite3 ${REMOTE_TMP_DIR}/${EMB_NAME}.tmp"
ssh "$SSH_TARGET" "sqlite3 ${REMOTE_TMP_DIR}/${EMB_NAME}.tmp 'VACUUM'"
ssh "$SSH_TARGET" "mv ${REMOTE_TMP_DIR}/${EMB_NAME}.tmp ${REMOTE_TMP_DIR}/${EMB_NAME}"

# Drop `embeddings` from the main snapshot (it's the heavy table) + VACUUM.
ssh "$SSH_TARGET" "sqlite3 ${REMOTE_TMP_DIR}/${MAIN_NAME} 'DROP TABLE IF EXISTS embeddings; VACUUM'"

# ─── Step 4. Verify private tables are gone (assertion) ─────────────────────

log "Step 4/7  verify exclusion of private tables"

verify_no_private() {
	local snap="$1"
	for t in "${PRIVATE_TABLES[@]}"; do
		local count
		count=$(ssh "$SSH_TARGET" "sqlite3 ${snap} \"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${t}';\"")
		if [ "$count" != "0" ]; then
			fail "private table '${t}' still present in ${snap}"
		fi
	done
	log "  ${snap}: all ${#PRIVATE_TABLES[@]} private tables absent"
}

verify_no_private "${REMOTE_TMP_DIR}/${MAIN_NAME}"
verify_no_private "${REMOTE_TMP_DIR}/${EMB_NAME}"

# Sanity: main snapshot should NOT contain `embeddings`; embeddings snapshot
# should ONLY contain `embeddings`.
main_has_emb=$(ssh "$SSH_TARGET" "sqlite3 ${REMOTE_TMP_DIR}/${MAIN_NAME} \"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='embeddings';\"")
[ "$main_has_emb" = "0" ] || fail "main snapshot still contains embeddings table"

emb_tables=$(ssh "$SSH_TARGET" "sqlite3 ${REMOTE_TMP_DIR}/${EMB_NAME} \"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';\"")
[ "$emb_tables" = "embeddings" ] || fail "embeddings snapshot has unexpected tables: ${emb_tables}"

log "  schema invariants OK"

# ─── Step 5. gzip + sha256 on remote (avoid streaming 13 GB twice) ──────────

log "Step 5/7  gzip + sha256 on remote"

ssh "$SSH_TARGET" "cd ${REMOTE_TMP_DIR} && gzip -f ${MAIN_NAME} && gzip -f ${EMB_NAME}"
ssh "$SSH_TARGET" "cd ${REMOTE_TMP_DIR} && sha256sum ${MAIN_NAME}.gz ${EMB_NAME}.gz > checksums.txt"

# Pull only the small artifacts (gzipped DBs + checksums) to the runner.
log "  pulling artifacts to ${LOCAL_OUT_DIR}"
scp "${SSH_TARGET}:${REMOTE_TMP_DIR}/${MAIN_NAME}.gz" "${LOCAL_OUT_DIR}/"
scp "${SSH_TARGET}:${REMOTE_TMP_DIR}/${EMB_NAME}.gz" "${LOCAL_OUT_DIR}/"
scp "${SSH_TARGET}:${REMOTE_TMP_DIR}/checksums.txt" "${LOCAL_OUT_DIR}/"

MAIN_BYTES=$(stat -f%z "${LOCAL_OUT_DIR}/${MAIN_NAME}.gz" 2>/dev/null || stat -c%s "${LOCAL_OUT_DIR}/${MAIN_NAME}.gz")
EMB_BYTES=$(stat -f%z "${LOCAL_OUT_DIR}/${EMB_NAME}.gz" 2>/dev/null || stat -c%s "${LOCAL_OUT_DIR}/${EMB_NAME}.gz")

MAIN_SHA=$(awk -v f="${MAIN_NAME}.gz" '$2==f{print $1}' "${LOCAL_OUT_DIR}/checksums.txt")
EMB_SHA=$(awk -v f="${EMB_NAME}.gz" '$2==f{print $1}' "${LOCAL_OUT_DIR}/checksums.txt")

log "  main:  ${MAIN_NAME}.gz  ${MAIN_BYTES} bytes  sha256=${MAIN_SHA}"
log "  emb:   ${EMB_NAME}.gz   ${EMB_BYTES} bytes  sha256=${EMB_SHA}"

if [ "$DRY_RUN" = "1" ]; then
	log "DRY RUN: stopping before upload. Artifacts in ${LOCAL_OUT_DIR}/"
	# Clean remote so we don't accumulate 13 GB of stale snapshots.
	ssh "$SSH_TARGET" "rm -rf ${REMOTE_TMP_DIR}"
	exit 0
fi

# ─── Step 6. Upload ─────────────────────────────────────────────────────────

if [ "$SKIP_HF" = "0" ]; then
	log "Step 6a/7  upload to Hugging Face: ${HF_REPO}"
	require_cmd huggingface-cli
	[ -n "${HF_TOKEN:-}" ] || fail "HF_TOKEN not set"

	huggingface-cli upload \
		"${HF_REPO}" \
		"${LOCAL_OUT_DIR}/${MAIN_NAME}.gz" \
		"snapshots/${MAIN_NAME}.gz" \
		--repo-type dataset \
		--token "${HF_TOKEN}" \
		--commit-message "Snapshot ${DATE_TAG} (main, no embeddings)"

	huggingface-cli upload \
		"${HF_REPO}" \
		"${LOCAL_OUT_DIR}/${EMB_NAME}.gz" \
		"snapshots/${EMB_NAME}.gz" \
		--repo-type dataset \
		--token "${HF_TOKEN}" \
		--commit-message "Snapshot ${DATE_TAG} (embeddings only)"

	huggingface-cli upload \
		"${HF_REPO}" \
		"${LOCAL_OUT_DIR}/checksums.txt" \
		"snapshots/checksums-${DATE_TAG}.txt" \
		--repo-type dataset \
		--token "${HF_TOKEN}" \
		--commit-message "Checksums ${DATE_TAG}"
else
	log "Step 6a/7  skipping Hugging Face upload (--skip-hf)"
fi

if [ "$SKIP_IA" = "0" ]; then
	log "Step 6b/7  upload to archive.org: ${IA_ITEM}"
	require_cmd ia
	[ -n "${IA_ACCESS_KEY:-}" ] || fail "IA_ACCESS_KEY not set"
	[ -n "${IA_SECRET_KEY:-}" ] || fail "IA_SECRET_KEY not set"

	ia upload "${IA_ITEM}" \
		"${LOCAL_OUT_DIR}/${MAIN_NAME}.gz" \
		"${LOCAL_OUT_DIR}/${EMB_NAME}.gz" \
		"${LOCAL_OUT_DIR}/checksums.txt" \
		--metadata="title:Ley Abierta — Spanish legislation database snapshot ${DATE_TAG}" \
		--metadata="collection:${IA_COLLECTION}" \
		--metadata="creator:Ley Abierta" \
		--metadata="date:${DATE_TAG}" \
		--metadata="subject:legislation;spain;boe;open-data;legaltech" \
		--metadata="licenseurl:https://creativecommons.org/publicdomain/zero/1.0/" \
		--metadata="description:SQLite snapshot of consolidated Spanish legislation built from BOE open data. See https://leyabierta.es/datos for schema and usage."
else
	log "Step 6b/7  skipping archive.org upload (--skip-ia)"
fi

# ─── Step 7. Update public manifest ─────────────────────────────────────────

log "Step 7/7  update manifest (retention: last ${RETENTION_COUNT} snapshots)"

NEW_ENTRY=$(jq -n \
	--arg date "$DATE_TAG" \
	--arg main_name "${MAIN_NAME}.gz" \
	--arg emb_name "${EMB_NAME}.gz" \
	--arg main_sha "$MAIN_SHA" \
	--arg emb_sha "$EMB_SHA" \
	--argjson main_bytes "$MAIN_BYTES" \
	--argjson emb_bytes "$EMB_BYTES" \
	--arg hf_repo "$HF_REPO" \
	--arg ia_item "$IA_ITEM" \
	'{
		date: $date,
		main: {
			filename: $main_name,
			sha256: $main_sha,
			bytes: $main_bytes,
			hf_url: ("https://huggingface.co/datasets/" + $hf_repo + "/resolve/main/snapshots/" + $main_name),
			archive_url: ("https://archive.org/download/" + $ia_item + "/" + $main_name)
		},
		embeddings: {
			filename: $emb_name,
			sha256: $emb_sha,
			bytes: $emb_bytes,
			hf_url: ("https://huggingface.co/datasets/" + $hf_repo + "/resolve/main/snapshots/" + $emb_name),
			archive_url: ("https://archive.org/download/" + $ia_item + "/" + $emb_name)
		}
	}')

if [ -f "$MANIFEST_PATH" ]; then
	OLD=$(cat "$MANIFEST_PATH")
else
	OLD='{"snapshots": []}'
fi

echo "$OLD" | jq \
	--argjson entry "$NEW_ENTRY" \
	--argjson keep "$RETENTION_COUNT" \
	'.snapshots = ([$entry] + .snapshots) | .snapshots |= unique_by(.date) | .snapshots |= sort_by(.date) | .snapshots |= reverse | .snapshots |= .[0:$keep] | .updated_at = (now | todate)' \
	> "$MANIFEST_PATH"

log "  manifest updated: $MANIFEST_PATH"

if [ "$SKIP_HF" = "0" ]; then
	huggingface-cli upload \
		"${HF_REPO}" \
		"${MANIFEST_PATH}" \
		"manifest.json" \
		--repo-type dataset \
		--token "${HF_TOKEN}" \
		--commit-message "Manifest update ${DATE_TAG}"
fi

# ─── Cleanup ────────────────────────────────────────────────────────────────
# Remote tmp dir cleanup is handled by the EXIT trap installed near the top
# of the script — runs on success and on failure both.

if [ "$KEEP_LOCAL" = "0" ]; then
	rm -f "${LOCAL_OUT_DIR}/${MAIN_NAME}.gz" "${LOCAL_OUT_DIR}/${EMB_NAME}.gz"
	log "  local snapshots cleaned (manifest kept)"
fi

log "=== upload-db-snapshot.sh done ==="
