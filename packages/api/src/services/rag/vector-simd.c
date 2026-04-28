/*
 * SIMD brute-force cosine top-K for the RAG vector index.
 *
 * Two exported functions:
 *
 *   cosine_topk(query, query_norm, vectors, doc_norms, n_docs, dim,
 *               top_k, out_indices, out_scores)
 *      — float32 corpus path. Dot product with AVX2 FMA on linux/x86_64,
 *        scalar fallback elsewhere.
 *
 *   cosine_topk_int8(query, query_norm, corpus_int8, scales, doc_norms,
 *                    n_docs, dim, top_k, out_indices, out_scores)
 *      — int8 quantized corpus path. Each document is stored as
 *        int8[dim] + a per-vector float32 scale. Reconstructed dot is
 *        `(query · v_int8) * scale`. Norms come from a sidecar that
 *        holds ||v_original_float32|| (host responsibility — see
 *        `quantize-vectors.ts` and `vectors-int8.norms.bin`).
 *
 * Inputs (shared):
 *   - `query`          : float32[dim]
 *   - `query_norm`     : precomputed L2 norm of the query (host computes once)
 *   - `n_docs`, `dim`  : sizes
 *   - `top_k`          : how many to return (out arrays must be sized for top_k)
 *   - `out_indices`    : int32[top_k]   filled with selected document indices
 *   - `out_scores`     : float32[top_k] filled with cosine scores
 *
 * Returns the actual number of results written (= min(top_k, n_docs)).
 *
 * f32 implementation:
 *   - Computes dot products with AVX2 (`__m256` + `_mm256_fmadd_ps`).
 *     `dim` is 3072 in production = 384 lanes of 8 floats, no tail.
 *     We still write the tail loop to be safe for other dims (e.g. tests).
 *
 * int8 implementation:
 *   - linux/x86_64 + AVX2: convert int8 → int32 via `_mm256_cvtepi8_epi32`
 *     in 8-lane batches, then to float and `_mm256_fmadd_ps` with the
 *     query. This is simpler than madd_epi16 chains and CPU-friendly on
 *     modern Skylake+/Zen2+.
 *   - darwin/arm64 + NEON: load 8 int8 lanes via `vld1_s8`, widen to
 *     int16 (`vmovl_s8`), then to int32, then to float32 and FMA with
 *     `vfmaq_f32`.
 *   - Else: scalar fallback.
 *
 * Heap:
 *   - Maintains a min-heap of (score, index) of size `top_k`. The heap
 *     is keyed on score; the smallest score sits at slot 0 so we can
 *     reject without doing the full FMA chain when a document can't
 *     beat the current floor.
 *   - The per-vector floor check happens AFTER computing the dot
 *     product (since we don't have an upper bound for cosine without
 *     extra info). It still saves the heap update on most documents.
 *
 * Build:
 *   linux/amd64:  gcc -O3 -mavx2 -mfma -shared -fPIC -o vector-simd.linux-amd64.so vector-simd.c
 *   darwin/arm64: clang -O3 -shared -fPIC -arch arm64 -o vector-simd.darwin-arm64.dylib vector-simd.c
 *
 * On arm64 we use NEON for both f32 and int8 paths via the simple
 * widen-to-float approach. AVX2 isn't available there.
 */

#include <stdint.h>
#include <stddef.h>
#include <math.h>

#if defined(__AVX2__) && defined(__FMA__)
#include <immintrin.h>
#define HAVE_AVX2_FMA 1
#else
#define HAVE_AVX2_FMA 0
#endif

#if defined(__ARM_NEON) || defined(__aarch64__)
#include <arm_neon.h>
#define HAVE_NEON 1
#else
#define HAVE_NEON 0
#endif

/* ---------- dot product ---------- */

static inline float dot_product(const float* a, const float* b, size_t dim) {
#if HAVE_AVX2_FMA
    __m256 acc0 = _mm256_setzero_ps();
    __m256 acc1 = _mm256_setzero_ps();
    size_t i = 0;
    /* Two-way unrolled accumulator helps hide FMA latency. */
    for (; i + 16 <= dim; i += 16) {
        __m256 va0 = _mm256_loadu_ps(a + i);
        __m256 vb0 = _mm256_loadu_ps(b + i);
        acc0 = _mm256_fmadd_ps(va0, vb0, acc0);
        __m256 va1 = _mm256_loadu_ps(a + i + 8);
        __m256 vb1 = _mm256_loadu_ps(b + i + 8);
        acc1 = _mm256_fmadd_ps(va1, vb1, acc1);
    }
    for (; i + 8 <= dim; i += 8) {
        __m256 va = _mm256_loadu_ps(a + i);
        __m256 vb = _mm256_loadu_ps(b + i);
        acc0 = _mm256_fmadd_ps(va, vb, acc0);
    }
    __m256 acc = _mm256_add_ps(acc0, acc1);
    /* Horizontal sum of the 8 lanes. */
    __m128 lo = _mm256_castps256_ps128(acc);
    __m128 hi = _mm256_extractf128_ps(acc, 1);
    __m128 s = _mm_add_ps(lo, hi);
    s = _mm_hadd_ps(s, s);
    s = _mm_hadd_ps(s, s);
    float total = _mm_cvtss_f32(s);
    /* Tail (dims not divisible by 8). */
    for (; i < dim; i++) total += a[i] * b[i];
    return total;
#else
    float total = 0.0f;
    for (size_t i = 0; i < dim; i++) total += a[i] * b[i];
    return total;
#endif
}

/* ---------- int8 dot product (returns dot * scale) ----------
 *
 * Computes  dot(query_f32, doc_int8) * scale   — i.e. the dot product
 * in the *original* float32 space, undoing the per-vector quantization.
 * `scale` is the float32 scale factor recorded by quantize-vectors.ts
 * (where v_int8[i] = round(v_f32[i] / scale * 127), so the inverse is
 * v_f32[i] ≈ v_int8[i] * scale / 127).
 *
 * Returns sum_i (q[i] * doc[i] * scale / 127). We pull the (scale/127)
 * factor out of the inner loop and multiply once at the end.
 */
static inline float dot_int8_f32(
    const int8_t* doc, const float* query, float scale, size_t dim
) {
    const float k = scale / 127.0f;
#if HAVE_AVX2_FMA
    __m256 acc0 = _mm256_setzero_ps();
    __m256 acc1 = _mm256_setzero_ps();
    size_t i = 0;
    /* Process 16 int8 per iteration: two 8-lane converts + two FMAs. */
    for (; i + 16 <= dim; i += 16) {
        /* Load 16 int8 (low 16 bytes) into an __m128i, widen to int32 in
         * two steps via cvtepi8_epi32, then convert to float. */
        __m128i raw = _mm_loadu_si128((const __m128i*)(doc + i));
        __m256i lo32 = _mm256_cvtepi8_epi32(raw);                  /* lanes 0..7 */
        __m256i hi32 = _mm256_cvtepi8_epi32(_mm_srli_si128(raw, 8)); /* 8..15 */
        __m256 lo = _mm256_cvtepi32_ps(lo32);
        __m256 hi = _mm256_cvtepi32_ps(hi32);
        __m256 q0 = _mm256_loadu_ps(query + i);
        __m256 q1 = _mm256_loadu_ps(query + i + 8);
        acc0 = _mm256_fmadd_ps(q0, lo, acc0);
        acc1 = _mm256_fmadd_ps(q1, hi, acc1);
    }
    for (; i + 8 <= dim; i += 8) {
        /* Load 8 int8 into the low half of an __m128i. */
        int64_t raw64;
        __builtin_memcpy(&raw64, doc + i, 8);
        __m128i raw = _mm_set_epi64x(0, raw64);
        __m256i v32 = _mm256_cvtepi8_epi32(raw);
        __m256 vf = _mm256_cvtepi32_ps(v32);
        __m256 qv = _mm256_loadu_ps(query + i);
        acc0 = _mm256_fmadd_ps(qv, vf, acc0);
    }
    __m256 acc = _mm256_add_ps(acc0, acc1);
    __m128 lo = _mm256_castps256_ps128(acc);
    __m128 hi = _mm256_extractf128_ps(acc, 1);
    __m128 s = _mm_add_ps(lo, hi);
    s = _mm_hadd_ps(s, s);
    s = _mm_hadd_ps(s, s);
    float total = _mm_cvtss_f32(s);
    for (; i < dim; i++) total += query[i] * (float)doc[i];
    return total * k;
#elif HAVE_NEON
    float32x4_t acc0 = vdupq_n_f32(0.0f);
    float32x4_t acc1 = vdupq_n_f32(0.0f);
    size_t i = 0;
    for (; i + 8 <= dim; i += 8) {
        int8x8_t  d8  = vld1_s8(doc + i);
        int16x8_t d16 = vmovl_s8(d8);
        int32x4_t d32_lo = vmovl_s16(vget_low_s16(d16));
        int32x4_t d32_hi = vmovl_s16(vget_high_s16(d16));
        float32x4_t df_lo = vcvtq_f32_s32(d32_lo);
        float32x4_t df_hi = vcvtq_f32_s32(d32_hi);
        float32x4_t q_lo = vld1q_f32(query + i);
        float32x4_t q_hi = vld1q_f32(query + i + 4);
        acc0 = vfmaq_f32(acc0, q_lo, df_lo);
        acc1 = vfmaq_f32(acc1, q_hi, df_hi);
    }
    float32x4_t acc = vaddq_f32(acc0, acc1);
    float total = vaddvq_f32(acc);
    for (; i < dim; i++) total += query[i] * (float)doc[i];
    return total * k;
#else
    float total = 0.0f;
    for (size_t i = 0; i < dim; i++) total += query[i] * (float)doc[i];
    return total * k;
#endif
}

/* ---------- min-heap of size top_k ---------- *
 *
 * Slot 0 holds the *smallest* score so far. When we have a new candidate
 * with score > heap[0].score, we replace slot 0 and sift-down.
 */

typedef struct { float score; int32_t index; } HeapItem;

static inline void heap_sift_down(HeapItem* h, int32_t n, int32_t start) {
    int32_t i = start;
    for (;;) {
        int32_t l = 2 * i + 1;
        int32_t r = 2 * i + 2;
        int32_t smallest = i;
        if (l < n && h[l].score < h[smallest].score) smallest = l;
        if (r < n && h[r].score < h[smallest].score) smallest = r;
        if (smallest == i) break;
        HeapItem tmp = h[i]; h[i] = h[smallest]; h[smallest] = tmp;
        i = smallest;
    }
}

static inline void heap_sift_up(HeapItem* h, int32_t start) {
    int32_t i = start;
    while (i > 0) {
        int32_t parent = (i - 1) / 2;
        if (h[parent].score <= h[i].score) break;
        HeapItem tmp = h[i]; h[i] = h[parent]; h[parent] = tmp;
        i = parent;
    }
}

/* ---------- exported function ---------- */

int32_t cosine_topk(
    const float* query,
    float        query_norm,
    const float* vectors,
    const float* doc_norms,
    int32_t      n_docs,
    int32_t      dim,
    int32_t      top_k,
    int32_t*     out_indices,
    float*       out_scores
) {
    if (n_docs <= 0 || top_k <= 0 || query_norm == 0.0f) return 0;
    if (top_k > n_docs) top_k = n_docs;

    /* Use a static-sized stack heap up to 4096; for larger top_k, host
     * is expected to keep top_k modest (rerank pool ~80). */
    HeapItem heap[4096];
    if (top_k > (int32_t)(sizeof(heap)/sizeof(heap[0]))) {
        top_k = (int32_t)(sizeof(heap)/sizeof(heap[0]));
    }
    int32_t heap_size = 0;
    float floor_score = -INFINITY;

    for (int32_t i = 0; i < n_docs; i++) {
        const float* doc = vectors + (size_t)i * (size_t)dim;
        float dn = doc_norms[i];
        if (dn == 0.0f) continue;

        float dot = dot_product(query, doc, dim);
        float score = dot / (query_norm * dn);

        if (heap_size < top_k) {
            heap[heap_size].score = score;
            heap[heap_size].index = i;
            heap_size++;
            heap_sift_up(heap, heap_size - 1);
            if (heap_size == top_k) floor_score = heap[0].score;
        } else if (score > floor_score) {
            heap[0].score = score;
            heap[0].index = i;
            heap_sift_down(heap, top_k, 0);
            floor_score = heap[0].score;
        }
    }

    /* Heap-sort using a min-heap: repeatedly swap heap[0] (the smallest
     * remaining score) into the *end* of the live region, then sift
     * down. After the loop heap[0..n-1] is *descending* by score
     * (largest at index 0, smallest at index n-1). The copy below
     * reverses that, so the output arrays end up *ascending*. JS callers
     * re-sort descending themselves; we don't rely on either ordering
     * downstream, but the comments here matter for anyone adding a new
     * caller that skips the re-sort. */
    int32_t n = heap_size;
    for (int32_t end = n - 1; end > 0; end--) {
        HeapItem tmp = heap[0]; heap[0] = heap[end]; heap[end] = tmp;
        heap_sift_down(heap, end, 0);
    }
    /* heap[0..n-1] is descending; copying via heap[n-1-i] yields ascending. */
    for (int32_t i = 0; i < n; i++) {
        out_scores[i]  = heap[n - 1 - i].score;
        out_indices[i] = heap[n - 1 - i].index;
    }
    return n;
}

/* ---------- exported function: int8 corpus path ----------
 *
 * `corpus_int8` is a flat int8 buffer of n_docs * dim bytes.
 * `scales`     is a float32 array of n_docs entries, scale per doc.
 * `doc_norms`  is a float32 array of n_docs entries holding the L2
 *              norm of the *original* float32 vector (NOT the int8 one)
 *              — the host computes it once when quantizing.
 *
 * Behavior is otherwise identical to cosine_topk: builds a min-heap of
 * size top_k, returns indices/scores in descending score order.
 */
int32_t cosine_topk_int8(
    const float*  query,
    float         query_norm,
    const int8_t* corpus_int8,
    const float*  scales,
    const float*  doc_norms,
    int32_t       n_docs,
    int32_t       dim,
    int32_t       top_k,
    int32_t*      out_indices,
    float*        out_scores
) {
    if (n_docs <= 0 || top_k <= 0 || query_norm == 0.0f) return 0;
    if (top_k > n_docs) top_k = n_docs;

    HeapItem heap[4096];
    if (top_k > (int32_t)(sizeof(heap)/sizeof(heap[0]))) {
        top_k = (int32_t)(sizeof(heap)/sizeof(heap[0]));
    }
    int32_t heap_size = 0;
    float floor_score = -INFINITY;

    for (int32_t i = 0; i < n_docs; i++) {
        const int8_t* doc = corpus_int8 + (size_t)i * (size_t)dim;
        float dn = doc_norms[i];
        if (dn == 0.0f) continue;

        float scale = scales[i];
        float dot = dot_int8_f32(doc, query, scale, (size_t)dim);
        float score = dot / (query_norm * dn);

        if (heap_size < top_k) {
            heap[heap_size].score = score;
            heap[heap_size].index = i;
            heap_size++;
            heap_sift_up(heap, heap_size - 1);
            if (heap_size == top_k) floor_score = heap[0].score;
        } else if (score > floor_score) {
            heap[0].score = score;
            heap[0].index = i;
            heap_sift_down(heap, top_k, 0);
            floor_score = heap[0].score;
        }
    }

    int32_t n = heap_size;
    for (int32_t end = n - 1; end > 0; end--) {
        HeapItem tmp = heap[0]; heap[0] = heap[end]; heap[end] = tmp;
        heap_sift_down(heap, end, 0);
    }
    for (int32_t i = 0; i < n; i++) {
        out_scores[i]  = heap[n - 1 - i].score;
        out_indices[i] = heap[n - 1 - i].index;
    }
    return n;
}
