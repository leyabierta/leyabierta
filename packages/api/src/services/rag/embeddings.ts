/**
 * Embedding generation and vector search for RAG.
 *
 * Generates embeddings via OpenRouter API and stores them as a binary file.
 * Supports brute-force cosine similarity search (sufficient for ~13K articles).
 */

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const BATCH_SIZE = 50; // articles per API call
const BACKOFF_MS = 1000;

export interface EmbeddingModel {
	id: string;
	dimensions: number;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModel> = {
	"openai-small": {
		id: "openai/text-embedding-3-small",
		dimensions: 1536,
	},
	"openai-large": {
		id: "openai/text-embedding-3-large",
		dimensions: 3072,
	},
	qwen3: {
		id: "qwen/qwen3-embedding-8b",
		dimensions: 4096,
	},
	"gemini-embedding-2": {
		id: "google/gemini-embedding-2-preview",
		dimensions: 3072,
	},
};

export interface ArticleEmbedding {
	normId: string;
	blockId: string;
	embedding: Float32Array;
}

export interface EmbeddingStore {
	model: string;
	dimensions: number;
	count: number;
	articles: Array<{ normId: string; blockId: string }>;
	vectors: Float32Array; // flattened: count × dimensions
	norms: Float32Array; // pre-computed L2 norms per document
}

function computeNorms(
	vectors: Float32Array,
	count: number,
	dims: number,
): Float32Array {
	const norms = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		const offset = i * dims;
		let sum = 0;
		for (let j = 0; j < dims; j++) {
			const v = vectors[offset + j] ?? 0;
			sum += v * v;
		}
		norms[i] = Math.sqrt(sum);
	}
	return norms;
}

// ── Shared fetch with retry ──

async function fetchWithRetry(
	apiKey: string,
	modelId: string,
	input: string | string[],
): Promise<Response> {
	const maxRetries = 3;
	let attempts = 0;

	while (true) {
		let response: Response;
		try {
			response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://leyabierta.es",
					"X-Title": "Ley Abierta RAG",
				},
				body: JSON.stringify({ model: modelId, input }),
			});

			if (response.status === 429) {
				attempts++;
				if (attempts > maxRetries) {
					throw new Error("Rate limited after max retries");
				}
				const delay = BACKOFF_MS * attempts * 2;
				await new Promise((r) => setTimeout(r, delay));
				continue;
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Embedding API error ${response.status}: ${errorText.slice(0, 200)}`,
				);
			}

			return response;
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("Rate limited"))
				throw err;
			attempts++;
			if (attempts > maxRetries) throw err;
			await new Promise((r) => setTimeout(r, BACKOFF_MS * attempts));
		}
	}
}

// ── Generate embeddings ──

export async function generateEmbeddings(
	apiKey: string,
	modelKey: string,
	articles: Array<{ normId: string; blockId: string; text: string }>,
	onProgress?: (done: number, total: number) => void,
): Promise<EmbeddingStore> {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) {
		throw new Error(
			`Unknown model: ${modelKey}. Available: ${Object.keys(EMBEDDING_MODELS).join(", ")}`,
		);
	}

	const allEmbeddings: Float32Array[] = [];
	const articleMeta: Array<{ normId: string; blockId: string }> = [];
	let totalCost = 0;
	let totalTokens = 0;

	for (let i = 0; i < articles.length; i += BATCH_SIZE) {
		const batch = articles.slice(i, i + BATCH_SIZE);
		const texts = batch.map((a) => {
			// Truncate to ~2000 chars (~500 tokens) per article to manage costs
			const content = a.text.slice(0, 2000);
			return content;
		});

		const response = await fetchWithRetry(apiKey, model.id, texts);
		// biome-ignore lint/suspicious/noExplicitAny: OpenRouter API response shape
		const data: any = await response.json();
		const usage = data.usage ?? {};
		totalCost += usage.cost ?? 0;
		totalTokens += usage.total_tokens ?? 0;

		for (const item of data.data) {
			const embedding = new Float32Array(item.embedding);
			allEmbeddings.push(embedding);
			const batchItem = batch[item.index]!;
			articleMeta.push({
				normId: batchItem.normId,
				blockId: batchItem.blockId,
			});
		}

		onProgress?.(Math.min(i + BATCH_SIZE, articles.length), articles.length);

		// Small delay between batches
		if (i + BATCH_SIZE < articles.length) {
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	// Flatten all embeddings into a single Float32Array
	const dims = allEmbeddings[0]?.length ?? model.dimensions;
	const vectors = new Float32Array(allEmbeddings.length * dims);
	for (let i = 0; i < allEmbeddings.length; i++) {
		vectors.set(allEmbeddings[i]!, i * dims);
	}

	console.log(
		`  Embedding stats: ${allEmbeddings.length} articles, ${totalTokens.toLocaleString()} tokens, $${totalCost.toFixed(4)} cost`,
	);

	const norms = computeNorms(vectors, allEmbeddings.length, dims);
	return {
		model: modelKey,
		dimensions: dims,
		count: allEmbeddings.length,
		articles: articleMeta,
		vectors,
		norms,
	};
}

// ── Save/Load embeddings ──

export async function saveEmbeddings(
	store: EmbeddingStore,
	path: string,
): Promise<void> {
	const meta = {
		model: store.model,
		dimensions: store.dimensions,
		count: store.count,
		articles: store.articles,
	};
	// Save metadata as JSON
	await Bun.write(`${path}.meta.json`, JSON.stringify(meta));
	// Save vectors as binary
	await Bun.write(`${path}.vectors.bin`, store.vectors.buffer);
}

export async function loadEmbeddings(path: string): Promise<EmbeddingStore> {
	const metaFile = Bun.file(`${path}.meta.json`);
	if (!(await metaFile.exists())) {
		throw new Error(`Embeddings not found at ${path}`);
	}
	const meta = JSON.parse(await metaFile.text());
	const vectorsBuffer = await Bun.file(`${path}.vectors.bin`).arrayBuffer();
	const vectors = new Float32Array(vectorsBuffer);
	const norms = computeNorms(vectors, meta.count, meta.dimensions);
	return { ...meta, vectors, norms };
}

// ── Vector search (brute-force cosine similarity) ──

export async function embedQuery(
	apiKey: string,
	modelKey: string,
	query: string,
): Promise<{ embedding: Float32Array; cost: number; tokens: number }> {
	const model = EMBEDDING_MODELS[modelKey];
	if (!model) throw new Error(`Unknown model: ${modelKey}`);

	const response = await fetchWithRetry(apiKey, model.id, query);
	// biome-ignore lint/suspicious/noExplicitAny: OpenRouter API response shape
	const data: any = await response.json();
	const usage = data.usage ?? {};
	return {
		embedding: new Float32Array(data.data[0].embedding),
		cost: usage.cost ?? 0,
		tokens: usage.total_tokens ?? 0,
	};
}

export interface VectorSearchResult {
	normId: string;
	blockId: string;
	score: number;
}

export function vectorSearch(
	queryEmbedding: Float32Array,
	store: EmbeddingStore,
	topK: number = 10,
): VectorSearchResult[] {
	const dims = store.dimensions;

	if (queryEmbedding.length !== dims) {
		throw new Error(
			`Dimension mismatch: query=${queryEmbedding.length}, store=${dims}`,
		);
	}

	const scores: Array<{ index: number; score: number }> = [];

	// Precompute query norm
	let queryNorm = 0;
	for (let i = 0; i < dims; i++) {
		queryNorm += (queryEmbedding[i] ?? 0) * (queryEmbedding[i] ?? 0);
	}
	queryNorm = Math.sqrt(queryNorm);

	for (let i = 0; i < store.count; i++) {
		const offset = i * dims;
		const docNorm = store.norms[i] ?? 0;

		// Cosine similarity using pre-computed doc norms
		let dotProduct = 0;
		for (let j = 0; j < dims; j++) {
			dotProduct += (queryEmbedding[j] ?? 0) * (store.vectors[offset + j] ?? 0);
		}

		const score =
			queryNorm > 0 && docNorm > 0 ? dotProduct / (queryNorm * docNorm) : 0;

		scores.push({ index: i, score });
	}

	scores.sort((a, b) => b.score - a.score);

	return scores.slice(0, topK).map((s) => {
		const article = store.articles[s.index]!;
		return {
			normId: article.normId,
			blockId: article.blockId,
			score: s.score,
		};
	});
}
