#!/usr/bin/env bash
# Rebuild data/vectors-int8.bin from the qwen3-nan embeddings when it is stale,
# then restart the API so it loads the fresh index.
#
# Why this exists: the daily pipeline embeds new norms into the DB (Step 3b) but
# nothing rebuilt the flat vector index, so it drifted ~2 months out of date
# (fixed manually 2026-07-21). This closes that gap.
#
# Memory-safe by design (the API container is RAM-capped and OOM'd before):
#   1. A streamed DB → f32 export (row-by-row, no ~10GB in-RAM load like
#      ensureVectorIndex does).
#   2. Chunked int8 quantization (a few hundred MB peak).
# Both run inside the API container (uid 1001, the only writer of /data).
#
# Idempotent + cheap when nothing changed: if the int8 index already matches the
# DB row count, it exits without touching anything. Safe to run daily.
#
# Usage: scripts/rebuild-vector-index.sh   (from the repo root on the host)

set -euo pipefail

CONTAINER="${API_CONTAINER:-code-api-1}"
# Quantizer lives in the image. TODO: promote out of research/archive.
QUANTIZER="packages/api/research/archive/2026-05/experiments/quantize-vectors.ts"

log() { echo "[rebuild-vector-index] $*"; }

dex() { docker exec "$CONTAINER" "$@"; }

# ── Staleness check: DB qwen3-nan count vs meta.jsonl line count ─────────────
DBN=$(dex bun -e 'const {Database}=require("bun:sqlite");console.log(new Database("/data/leyabierta.db",{readonly:true}).query("select count(*) c from embeddings where model=?").get("qwen3-nan").c)')
METAN=$(dex sh -c 'test -f /data/vectors.meta.jsonl && wc -l < /data/vectors.meta.jsonl || echo 0')
log "DB qwen3-nan vectors: ${DBN} · current index: ${METAN}"

if [ "$DBN" = "$METAN" ] && [ "$DBN" != "0" ]; then
	log "index is fresh — nothing to rebuild."
	exit 0
fi

log "index is stale — rebuilding ${METAN} → ${DBN}."
STAMP="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo bak)"

# ── Step 1: streamed DB → f32 vectors.bin + meta.jsonl (memory-bounded) ──────
dex sh -c 'cat > /data/_export-vectors.mjs' <<'JS'
const { Database } = require("bun:sqlite");
const db = new Database("/data/leyabierta.db", { readonly: true });
const total = db.query("select count(*) c from embeddings where model='qwen3-nan'").get().c;
const q = db.query("select norm_id n, block_id b, vector v from embeddings where model='qwen3-nan' order by norm_id, block_id");
const vec = Bun.file("/data/vectors.bin.new").writer();
const meta = Bun.file("/data/vectors.meta.jsonl.new").writer();
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
dex bun run /data/_export-vectors.mjs
dex rm -f /data/_export-vectors.mjs

# Verify the export before we overwrite anything canonical.
NEWN=$(dex sh -c 'wc -l < /data/vectors.meta.jsonl.new')
if [ "$NEWN" != "$DBN" ]; then
	log "ERROR: export line count ${NEWN} != DB ${DBN}; aborting, index untouched."
	dex rm -f /data/vectors.bin.new /data/vectors.meta.jsonl.new
	exit 1
fi

# ── Back up the current int8 index, then promote the new f32 + meta ──────────
dex sh -c "cp -f /data/vectors-int8.bin /data/vectors-int8.bin.bak-${STAMP} 2>/dev/null || true; \
           cp -f /data/vectors-int8.norms.bin /data/vectors-int8.norms.bin.bak-${STAMP} 2>/dev/null || true; \
           mv /data/vectors.bin.new /data/vectors.bin && \
           mv /data/vectors.meta.jsonl.new /data/vectors.meta.jsonl"

# ── Step 2: quantize f32 → int8 (+ norms). Memory-bounded, reuses meta.jsonl ──
dex bun run "$QUANTIZER" --in /data/vectors.bin --out /data/vectors-int8.bin --dims 4096

# ── Step 3: restart the API to load the fresh index (non-fatal on failure) ───
log "restarting ${CONTAINER} to load the new index…"
if docker restart "$CONTAINER" >/dev/null 2>&1; then
	for _ in $(seq 1 24); do
		sleep 5
		if docker exec "$CONTAINER" curl -sf -m 5 http://127.0.0.1:3000/health >/dev/null 2>&1; then
			docker logs --since 150s "$CONTAINER" 2>&1 | grep -i "vectors-int8.bin" | tail -1
			log "done — API healthy with the fresh index."
			exit 0
		fi
	done
	log "WARNING: API did not report healthy within 2m; check 'docker logs ${CONTAINER}'."
else
	log "WARNING: could not restart ${CONTAINER}; the new index is on disk and will load on the next restart."
fi
