/**
 * Ollama adapter for embedding generation + querying.
 *
 * Kept separate from the production embeddings.ts so the A/B experiment
 * touches zero code in the hot path. If Qwen3 wins, merge later.
 *
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md#generate-embeddings
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

export interface OllamaEmbedRequest {
	model: string;
	/** Single string or array; Ollama batches server-side. */
	input: string | string[];
	/** Optional: truncate long inputs instead of erroring. Default true. */
	truncate?: boolean;
	/** Optional model options, e.g. { num_ctx: 32768 }. */
	options?: Record<string, unknown>;
	/** Keep the model warm; "24h" avoids cold-start reloads during a batch. */
	keep_alive?: string;
}

interface OllamaEmbedResponse {
	model: string;
	embeddings: number[][];
	total_duration?: number;
	prompt_eval_count?: number;
}

/**
 * Call Ollama /api/embed. Returns one Float32Array per input.
 * Retries on transient network failures (not on 4xx).
 */
export async function ollamaEmbed(
	model: string,
	input: string | string[],
	opts: { keepAlive?: string; numCtx?: number } = {},
): Promise<Float32Array[]> {
	const body: OllamaEmbedRequest = {
		model,
		input,
		truncate: true,
		keep_alive: opts.keepAlive ?? "24h",
	};
	if (opts.numCtx) {
		body.options = { num_ctx: opts.numCtx };
	}

	const maxRetries = 3;
	let lastErr: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const res = await fetch(`${OLLAMA_URL}/api/embed`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const txt = await res.text();
				// 4xx = input error, don't retry
				if (res.status >= 400 && res.status < 500) {
					throw new Error(`Ollama ${res.status}: ${txt.slice(0, 300)}`);
				}
				throw new Error(`Ollama ${res.status}: ${txt.slice(0, 300)}`);
			}
			const data = (await res.json()) as OllamaEmbedResponse;
			return data.embeddings.map((e) => new Float32Array(e));
		} catch (err) {
			lastErr = err;
			if (attempt < maxRetries) {
				await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
			}
		}
	}
	throw lastErr;
}

/**
 * Query embedding with the Qwen3-Embedding recommended instruction prefix.
 * Docs: https://huggingface.co/Qwen/Qwen3-Embedding-8B
 *
 * Qwen3 uses asymmetric retrieval: queries get "Instruct: ... \nQuery: ..."
 * and documents are embedded raw.
 */
export function qwen3QueryPrefix(query: string): string {
	return `Instruct: Given a Spanish citizen's legal question, retrieve the article of Spanish law that best answers it.\nQuery: ${query}`;
}

/**
 * Matryoshka truncation: take first N dimensions, renormalize to unit length.
 * Qwen3-Embedding supports MRL, so truncated vectors remain semantically valid.
 */
export function matryoshkaTruncate(
	vec: Float32Array,
	targetDim: number,
): Float32Array {
	if (targetDim > vec.length) {
		throw new Error(`targetDim ${targetDim} > vector dim ${vec.length}`);
	}
	if (targetDim === vec.length) return vec;
	const out = new Float32Array(targetDim);
	let sum = 0;
	for (let i = 0; i < targetDim; i++) {
		const v = vec[i]!;
		out[i] = v;
		sum += v * v;
	}
	const norm = Math.sqrt(sum);
	if (norm === 0) return out;
	for (let i = 0; i < targetDim; i++) {
		out[i] = out[i]! / norm;
	}
	return out;
}
