/*
 * SIMD brute-force cosine top-K for the RAG vector index.
 *
 * One exported function:
 *   cosine_topk(query, query_norm, vectors, doc_norms, n_docs, dim,
 *               top_k, out_indices, out_scores)
 *
 * - `query`          : float32[dim]
 * - `query_norm`     : precomputed L2 norm of the query (host computes once)
 * - `vectors`        : float32[n_docs * dim]  flat row-major
 * - `doc_norms`      : float32[n_docs] precomputed L2 norms
 * - `n_docs`, `dim`  : sizes
 * - `top_k`          : how many to return (out arrays must be sized for top_k)
 * - `out_indices`    : int32[top_k]   filled with selected document indices
 * - `out_scores`     : float32[top_k] filled with cosine scores
 *
 * Returns the actual number of results written (= min(top_k, n_docs)).
 *
 * The implementation:
 *   - Computes dot products with AVX2 (`__m256` + `_mm256_fmadd_ps`).
 *     `dim` is 3072 in production = 384 lanes of 8 floats, no tail.
 *     We still write the tail loop to be safe for other dims (e.g. tests).
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
 * On arm64 we fall back to a plain scalar loop for now. AVX2 isn't
 * available; NEON could be added later but dev correctness is what
 * darwin builds need, and dev corpora are small.
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

    /* Heap-sort: extract min repeatedly into the *end* of the array,
     * then reverse — output is descending by score. */
    int32_t n = heap_size;
    for (int32_t end = n - 1; end > 0; end--) {
        HeapItem tmp = heap[0]; heap[0] = heap[end]; heap[end] = tmp;
        heap_sift_down(heap, end, 0);
    }
    /* Now heap[0..n-1] is ascending by score; copy reversed. */
    for (int32_t i = 0; i < n; i++) {
        out_scores[i]  = heap[n - 1 - i].score;
        out_indices[i] = heap[n - 1 - i].index;
    }
    return n;
}
