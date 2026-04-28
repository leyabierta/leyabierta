# Int8 vector index — production rollout

The runtime now prefers `data/vectors-int8.bin` (1.49 GB) over
`data/vectors.bin` (5.95 GB) when the int8 file plus its norms sidecar
are present. Falling back to float32 is the rollback path — no code
change needed.

## File contract

```
data/vectors.meta.jsonl        ← shared by both formats (one JSON line per vector)
data/vectors.bin               ← float32 corpus (5.95 GB), legacy / fallback
data/vectors-int8.bin          ← INT8VEC1 quantized corpus (1.49 GB)
data/vectors-int8.norms.bin    ← float32 norms of original vectors (~1.9 MB)
```

The int8 file format is documented in `quantize-vectors.ts`:

- 32-byte header: ASCII `INT8VEC1` + uint32 `dims` + uint32 `n_vectors`.
- Per vector (`4 + dims` bytes): float32 `scale` + int8[`dims`] data.
- Norms sidecar: flat float32, one L2 norm per vector. **Computed on
  the original float32 vector** so cosine reconstruction is exact —
  the runtime needs both the scales (from `vectors-int8.bin`) and the
  norms (from the sidecar) for `cos(q, v) = (q · v_int8 * scale) /
  (‖q‖ · ‖v_orig‖)`.

The runtime loader (`embeddings.ts > loadInt8VectorsToMemory`)
deinterleaves the on-disk layout into separate `Int8Array` and
`Float32Array` chunks (one SAB each) so the worker pool can share a
single physical copy across all workers.

## Build

The shared library now exports two symbols: `cosine_topk` (f32 path)
and `cosine_topk_int8` (int8 path). Recompile with the existing
script — there are no extra dependencies.

```bash
./scripts/build-vector-simd.sh                 # auto-detect host
./scripts/build-vector-simd.sh linux-amd64     # KonarServer target
./scripts/build-vector-simd.sh darwin-arm64    # local dev
```

The Dockerfile already runs the linux-amd64 build during the
`simd-builder` stage. **No Dockerfile change is needed** — the same
`gcc -O3 -mavx2 -mfma` invocation picks up the new symbol because
both are in `vector-simd.c`.

## Rollout plan

### Day 0 — deploy code only

Deploy the API container with this branch merged. **Do not ship the
int8 files yet.** On boot the runtime sees no `vectors-int8.bin` in
`/data` and silently falls through to `vectors.bin` (existing
behavior). Zero-risk deploy: only the kernel and loader changed, the
f32 path is byte-equivalent.

### Day 1 — ship the int8 files

```bash
# From the dev box where we just generated them:
scp data/vectors-int8.bin       konar:/srv/leyabierta/data/
scp data/vectors-int8.norms.bin konar:/srv/leyabierta/data/

# Restart the API to load the new index:
ssh konar 'docker compose -f /srv/leyabierta/docker-compose.yml restart api'
```

The API logs `[rag] Loaded vectors-int8.bin: 1.49GB in N chunks ...`
on boot — confirm before traffic resumes. Watch `/v1/ask` p95 for
the next hour. Recall@1/5/10 is unchanged from the offline experiment
(R@1=28%, R@5=62%, R@10=80%); latency is expected to drop a bit
because each cache line now holds 4× more vectors.

### Day 1+N (≈2 weeks) — reclaim 5.95 GB

If int8 has run cleanly with no rollback signals, delete
`vectors.bin` to reclaim disk:

```bash
ssh konar 'rm /srv/leyabierta/data/vectors.bin'
```

Keep the dual generation in `sync-embeddings.ts` active — the next
sync cycle will recreate `vectors.bin` and `vectors-int8.bin` together
from SQLite, so a future rollback is still one SCP away.

## Rollback

If the int8 path misbehaves (recall regression, segfault, score
NaNs):

```bash
ssh konar 'rm /srv/leyabierta/data/vectors-int8.bin'
ssh konar 'docker compose -f /srv/leyabierta/docker-compose.yml restart api'
```

The loader sees no int8 file and loads `vectors.bin`. If you also
deleted `vectors.bin` (Day 1+N), regenerate it from SQLite first via
`bun run packages/api/research/sync-embeddings.ts --remove-only`
(adds nothing, but the post-sync hook re-exports `vectors.bin`).

## Sync pipeline

`sync-embeddings.ts` now regenerates **both** `vectors.bin` and
`vectors-int8.bin` (+ `vectors-int8.norms.bin`) at the end of any run
that adds or removes embeddings. Runs that find SQLite already in
sync skip the rebuild. The order is:

1. Add/remove rows in SQLite.
2. Stream the embeddings table into `vectors.bin`.
3. Quantize `vectors.bin` → `vectors-int8.bin` + `.norms.bin` in one
   pass (see `quantizeVectorsFile` in `quantize-vectors.ts`).

Quantization runs at ~43K vectors/s on dev (≈11s for 484K vectors).
Negligible compared to the embedding API call cost that precedes it.
