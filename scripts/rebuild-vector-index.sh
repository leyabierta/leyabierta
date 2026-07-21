#!/usr/bin/env bash
# Rebuild data/vectors-int8.bin from the qwen3-nan embeddings when it is stale,
# then restart the API so it loads the fresh index.
#
# Why: the daily pipeline embeds new norms into the DB (Step 3b) but nothing
# rebuilt the flat int8 vector index, so it drifted ~2 months out of date
# (fixed manually 2026-07-21). This closes that gap.
#
# Crash-safety is the whole point (the API container is RAM-capped and OOM-loops
# on boot if it ever has to load the ~8 GB f32 index or re-export from the DB):
#   - Everything is built in a temp dir and only promoted to the canonical names
#     AFTER the int8 file is fully written and verified — never a half state
#     where meta says "fresh" but int8 doesn't match (which would send the
#     runtime into the f32/re-export OOM path).
#   - Staleness is judged from the int8 file's own vector count (its size), not
#     from meta, so a stale/short int8 always forces a rebuild.
#   - Watchtower is paused across the promote+restart so an image update can't
#     restart the container mid-swap.
#   - One rotating backup; a free-space precheck; temp files trap-cleaned.
#
# Memory: streamed DB→f32 export (no ~10 GB in-RAM load) + chunked quantize —
# both run inside the API container via `docker exec -i` (uid 1001 owns /data).
#
# Idempotent + cheap: if the on-disk int8 already covers the DB row count, it
# exits without touching anything. Safe to run daily.
#
# Usage: scripts/rebuild-vector-index.sh   (from the repo root on the host)

set -euo pipefail

CONTAINER="${API_CONTAINER:-code-api-1}"
WATCHTOWER="${WATCHTOWER_CONTAINER:-code-watchtower-1}"
# Quantizer lives in the image. TODO: promote out of research/archive.
QUANTIZER="packages/api/research/archive/2026-05/experiments/quantize-vectors.ts"
TMP=/data/.vec-rebuild        # temp workdir inside the container's /data
BYTES_PER_VEC=4100            # int8 layout: 4-byte f32 scale + 4096 int8
HEADER_BYTES=32              # "INT8VEC1" header
MIN_FREE_GB=12               # abort if less free (peak ≈ f32 8G + int8 2G + tmp)

log() { echo "[rebuild-vector-index] $*"; }
# `-i` is REQUIRED: without it the heredoc stdin is not forwarded and `cat`
# writes an empty file. All exec calls use it for consistency.
dex() { docker exec -i "$CONTAINER" "$@"; }

resume_watchtower() { docker start "$WATCHTOWER" >/dev/null 2>&1 || true; }
cleanup() { dex rm -rf "$TMP" >/dev/null 2>&1 || true; }
trap 'cleanup' EXIT

# ── Staleness: DB qwen3-nan count vs the int8 file's own vector count ────────
DBN=$(dex bun -e 'const {Database}=require("bun:sqlite");console.log(new Database("/data/leyabierta.db",{readonly:true}).query("select count(*) c from embeddings where model=?").get("qwen3-nan").c)')
case "$DBN" in ''|*[!0-9]*) log "ERROR: bad DB count '$DBN'"; exit 1;; esac

INT8_SIZE=$(dex sh -c 'test -f /data/vectors-int8.bin && stat -c%s /data/vectors-int8.bin || echo 0')
case "$INT8_SIZE" in ''|*[!0-9]*) INT8_SIZE=0;; esac
INT8_N=0
if [ "$INT8_SIZE" -gt "$HEADER_BYTES" ]; then
	INT8_N=$(( (INT8_SIZE - HEADER_BYTES) / BYTES_PER_VEC ))
fi
log "DB qwen3-nan vectors: ${DBN} · int8 index vectors: ${INT8_N}"

if [ "$INT8_N" -eq "$DBN" ]; then
	log "index is fresh — nothing to rebuild."
	exit 0
fi
log "index is stale — rebuilding ${INT8_N} → ${DBN}."

# ── Free-space precheck (host side; /data lives under /opt) ──────────────────
FREE_GB=$(df -BG --output=avail /opt/leyabierta/data 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$FREE_GB" ] && [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
	log "ERROR: only ${FREE_GB}G free on /data, need ≥${MIN_FREE_GB}G. Aborting."
	exit 1
fi

# ── Quantizer presence (fail clearly, not with an opaque bun error) ──────────
# QUANTIZER is resolved by bun INSIDE the container (WORKDIR = repo root), so
# test it the same way. If research/archive is ever reorganised, this aborts
# with a readable message instead of a cryptic module-not-found mid-rebuild.
if ! dex test -f "$QUANTIZER"; then
	log "ERROR: quantizer not found in image at $QUANTIZER — promote it out of research/archive/ first. Aborting."
	exit 1
fi

# ── Step 1: streamed DB → f32 + meta into the temp dir (memory-bounded) ──────
dex sh -c "rm -rf $TMP && mkdir -p $TMP"
dex sh -c "cat > $TMP/export.mjs" <<'JS'
const { Database } = require("bun:sqlite");
const db = new Database("/data/leyabierta.db", { readonly: true });
const total = db.query("select count(*) c from embeddings where model='qwen3-nan'").get().c;
const q = db.query("select norm_id n, block_id b, vector v from embeddings where model='qwen3-nan' order by norm_id, block_id");
const vec = Bun.file("/data/.vec-rebuild/vectors.bin").writer();
const meta = Bun.file("/data/.vec-rebuild/vectors.meta.jsonl").writer();
let count = 0;
for (const r of q.iterate()) {
	if (r.v.byteLength !== 16384) throw new Error(`bad vector len ${r.v.byteLength} at ${r.n}/${r.b}`);
	vec.write(r.v);
	meta.write(JSON.stringify({ n: r.n, b: r.b }) + "\n");
	if (++count % 50000 === 0) { vec.flush(); meta.flush(); }
}
await vec.end();
await meta.end();
if (count !== total) throw new Error(`exported ${count} != ${total}`);
console.log(`export DONE: ${count} vectors`);
JS
dex bun run "$TMP/export.mjs"

METAN=$(dex sh -c "wc -l < $TMP/vectors.meta.jsonl")
case "$METAN" in ''|*[!0-9]*) log "ERROR: bad meta count '$METAN'"; exit 1;; esac
if [ "$METAN" -ne "$DBN" ]; then
	log "ERROR: exported meta ${METAN} != DB ${DBN}; aborting (canonical index untouched)."
	exit 1
fi

# ── Step 2: quantize f32 → int8 (+ norms) in the temp dir ────────────────────
dex bun run "$QUANTIZER" --in "$TMP/vectors.bin" --out "$TMP/vectors-int8.bin" --dims 4096
NEW_INT8_SIZE=$(dex sh -c "stat -c%s $TMP/vectors-int8.bin")
NEW_INT8_N=$(( (NEW_INT8_SIZE - HEADER_BYTES) / BYTES_PER_VEC ))
if [ "$NEW_INT8_N" -ne "$DBN" ]; then
	log "ERROR: quantized int8 has ${NEW_INT8_N} vectors != DB ${DBN}; aborting."
	exit 1
fi
if ! dex sh -c "test -f $TMP/vectors-int8.norms.bin"; then
	log "ERROR: quantizer did not produce norms sidecar; aborting."
	exit 1
fi
log "verified: temp int8 has ${NEW_INT8_N} vectors + norms sidecar."

# ── Step 3: back up (single rotating), pause Watchtower, promote atomically ──
dex sh -c '
	cp -f /data/vectors-int8.bin       /data/vectors-int8.bin.bak       2>/dev/null || true
	cp -f /data/vectors-int8.norms.bin /data/vectors-int8.norms.bin.bak 2>/dev/null || true
	cp -f /data/vectors.meta.jsonl     /data/vectors.meta.jsonl.bak     2>/dev/null || true
'
log "pausing ${WATCHTOWER} for the swap…"
docker stop "$WATCHTOWER" >/dev/null 2>&1 || true
trap 'cleanup; resume_watchtower' EXIT

# Promote everything at once. int8 (what staleness keys on) is renamed LAST so a
# crash mid-swap never leaves a fresh int8 next to a stale meta.
dex sh -c '
	mv -f /data/.vec-rebuild/vectors.bin            /data/vectors.bin &&
	mv -f /data/.vec-rebuild/vectors-int8.norms.bin /data/vectors-int8.norms.bin &&
	mv -f /data/.vec-rebuild/vectors.meta.jsonl     /data/vectors.meta.jsonl &&
	mv -f /data/.vec-rebuild/vectors-int8.bin       /data/vectors-int8.bin
'
log "promoted fresh index (${DBN} vectors)."

# ── Step 4: restart the API and confirm it loaded the fresh int8 ─────────────
log "restarting ${CONTAINER}…"
docker restart "$CONTAINER" >/dev/null 2>&1 || { log "ERROR: docker restart failed"; exit 1; }

ok=0
for _ in $(seq 1 30); do
	sleep 5
	# Health via logs (no dependency on curl existing in the image).
	if docker logs --since 200s "$CONTAINER" 2>&1 | grep -q "\[preload\] vector index ready"; then
		line=$(docker logs --since 200s "$CONTAINER" 2>&1 | grep "Loaded vectors-int8.bin" | tail -1)
		log "API ready. ${line}"
		# Sanity: the loaded count must match the DB.
		if echo "$line" | grep -q "(${DBN} vectors"; then ok=1; fi
		break
	fi
done
resume_watchtower
if [ "$ok" -eq 1 ]; then
	log "done — fresh index (${DBN} vectors) live."
else
	log "ERROR: API did not report a healthy fresh index within ~150s. Check 'docker logs ${CONTAINER}'. Backups: /data/*.bak"
	exit 1
fi
