/**
 * Tests for the RagPipeline class.
 * Mocks external dependencies (OpenRouter, embeddings).
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock modules before importing the pipeline
const mockCallOpenRouter = mock(() =>
	Promise.resolve({
		data: { keywords: ["test"], materias: [], temporal: false } as Record<
			string,
			unknown
		>,
		cost: 0,
		tokensIn: 0,
		tokensOut: 0,
		elapsed: 100,
	}),
);

const mockEmbedQuery = mock(() =>
	Promise.resolve({
		embedding: new Float32Array([1, 0, 0]),
		cost: 0,
		tokens: 0,
	}),
);

const mockLoadEmbeddings = mock(() =>
	Promise.resolve({
		model: "test",
		dimensions: 3,
		count: 0,
		articles: [],
		vectors: new Float32Array(0),
	}),
);

const mockVectorSearch = mock(
	() => [] as Array<{ normId: string; blockId: string; score: number }>,
);

mock.module("../services/openrouter.ts", () => ({
	callOpenRouter: mockCallOpenRouter,
	OpenRouterError: class extends Error {
		code: string;
		constructor(code: string, message: string) {
			super(message);
			this.code = code;
		}
	},
}));

mock.module("../services/rag/embeddings.ts", () => ({
	embedQuery: mockEmbedQuery,
	loadEmbeddings: mockLoadEmbeddings,
	vectorSearch: mockVectorSearch,
	EMBEDDING_MODELS: {
		"openai-small": { id: "openai/text-embedding-3-small", dimensions: 1536 },
	},
}));

// Import after mocking
const { RagPipeline } = await import("../services/rag/pipeline.ts");

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	db.exec(`
		CREATE TABLE norms (
			id TEXT PRIMARY KEY,
			title TEXT
		)
	`);
	db.exec(`
		CREATE TABLE blocks (
			norm_id TEXT,
			block_id TEXT,
			title TEXT,
			block_type TEXT,
			current_text TEXT
		)
	`);
	db.exec(`
		CREATE TABLE citizen_article_summaries (
			norm_id TEXT,
			block_id TEXT,
			summary TEXT,
			UNIQUE(norm_id, block_id)
		)
	`);
	db.exec(`
		CREATE TABLE versions (
			norm_id TEXT,
			block_id TEXT,
			date TEXT,
			source_id TEXT,
			text TEXT
		)
	`);

	// Reset all mocks
	mockCallOpenRouter.mockReset();
	mockEmbedQuery.mockReset();
	mockLoadEmbeddings.mockReset();
	mockVectorSearch.mockReset();

	// Default implementations
	mockEmbedQuery.mockResolvedValue({
		embedding: new Float32Array([1, 0, 0]),
		cost: 0,
		tokens: 0,
	});
	mockLoadEmbeddings.mockResolvedValue({
		model: "test",
		dimensions: 3,
		count: 0,
		articles: [],
		vectors: new Float32Array(0),
	});
	// Default callOpenRouter that won't break fire-and-forget calls
	mockCallOpenRouter.mockResolvedValue({
		data: { keywords: [], materias: [], temporal: false, summary: "" },
		cost: 0,
		tokensIn: 0,
		tokensOut: 0,
		elapsed: 50,
	});
});

describe("RagPipeline", () => {
	test("returns declined=false when no articles match vector search (empty retrieval is not a refusal)", async () => {
		mockCallOpenRouter.mockResolvedValueOnce({
			data: { keywords: ["test"], materias: [], temporal: false },
			cost: 0,
			tokensIn: 0,
			tokensOut: 0,
			elapsed: 50,
		});
		mockVectorSearch.mockReturnValue([]);

		const pipeline = new RagPipeline(db, "fake-key", "/fake/path");
		const result = await pipeline.ask({ question: "What are my rights?" });

		expect(result.declined).toBe(false);
		expect(result.citations).toHaveLength(0);
		expect(result.meta.articlesRetrieved).toBe(0);
	});

	test("analyzeQuery fallback on LLM error returns temporal=true for temporal keywords", async () => {
		// First call (analyzeQuery) fails, second call (synthesize) succeeds
		mockCallOpenRouter
			.mockRejectedValueOnce(new Error("LLM unavailable"))
			.mockResolvedValueOnce({
				data: {
					answer: "La ley ha cambiado.",
					citations: [],
					declined: false,
				},
				cost: 0,
				tokensIn: 0,
				tokensOut: 0,
				elapsed: 100,
			});

		// Provide matching articles in the DB
		db.exec("INSERT INTO norms VALUES ('BOE-A-2024-001', 'Test Law')");
		db.exec(
			"INSERT INTO blocks VALUES ('BOE-A-2024-001', 'art1', 'Articulo 1', 'precepto', 'Texto del articulo')",
		);

		mockVectorSearch.mockReturnValue([
			{ normId: "BOE-A-2024-001", blockId: "art1", score: 0.9 },
		]);

		const pipeline = new RagPipeline(db, "fake-key", "/fake/path");
		// Question with temporal keyword "cambio"
		const result = await pipeline.ask({
			question: "Como ha cambiado la ley de empleo?",
		});

		expect(result.meta.temporalEnriched).toBe(true);
	});

	test(">50% invalid citations triggers warning note in answer", async () => {
		// Set up DB with one article
		db.exec("INSERT INTO norms VALUES ('BOE-A-2024-001', 'Test Law')");
		db.exec(
			"INSERT INTO blocks VALUES ('BOE-A-2024-001', 'art1', 'Articulo 1', 'precepto', 'Texto real')",
		);

		mockCallOpenRouter
			.mockResolvedValueOnce({
				data: { keywords: ["test"], materias: [], temporal: false },
				cost: 0,
				tokensIn: 0,
				tokensOut: 0,
				elapsed: 50,
			})
			.mockResolvedValueOnce({
				data: {
					answer: "Tienes derecho a vacaciones.",
					citations: [
						// One valid norm
						{ norm_id: "BOE-A-2024-001", article_title: "Articulo 1" },
						// Two fabricated norms (not in evidence at all)
						{ norm_id: "BOE-A-FAKE-999", article_title: "Articulo 99" },
						{ norm_id: "BOE-A-FAKE-888", article_title: "Articulo 88" },
						{ norm_id: "BOE-A-FAKE-777", article_title: "Articulo 77" },
					],
					declined: false,
				},
				cost: 0,
				tokensIn: 0,
				tokensOut: 0,
				elapsed: 100,
			});

		mockVectorSearch.mockReturnValue([
			{ normId: "BOE-A-2024-001", blockId: "art1", score: 0.9 },
		]);

		const pipeline = new RagPipeline(db, "fake-key", "/fake/path");
		const result = await pipeline.ask({
			question: "Cuantas vacaciones tengo?",
		});

		expect(result.answer).toContain("no ha podido ser verificada");
	});

	test("generateMissingSummaries skips when all citations have summaries", async () => {
		// Set up article WITH a citizen summary
		db.exec("INSERT INTO norms VALUES ('BOE-A-2024-001', 'Test Law')");
		db.exec(
			"INSERT INTO blocks VALUES ('BOE-A-2024-001', 'art1', 'Articulo 1', 'precepto', 'Texto')",
		);
		db.exec(
			"INSERT INTO citizen_article_summaries VALUES ('BOE-A-2024-001', 'art1', 'Ya tiene resumen')",
		);

		mockCallOpenRouter
			.mockResolvedValueOnce({
				data: { keywords: ["test"], materias: [], temporal: false },
				cost: 0,
				tokensIn: 0,
				tokensOut: 0,
				elapsed: 50,
			})
			.mockResolvedValueOnce({
				data: {
					answer: "Respuesta.",
					citations: [
						{ norm_id: "BOE-A-2024-001", article_title: "Articulo 1" },
					],
					declined: false,
				},
				cost: 0,
				tokensIn: 0,
				tokensOut: 0,
				elapsed: 100,
			});

		mockVectorSearch.mockReturnValue([
			{ normId: "BOE-A-2024-001", blockId: "art1", score: 0.9 },
		]);

		const pipeline = new RagPipeline(db, "fake-key", "/fake/path");
		const result = await pipeline.ask({ question: "Pregunta de prueba" });

		// callOpenRouter should only be called twice: analyzeQuery + synthesize
		// NOT a third time for summary generation
		expect(mockCallOpenRouter).toHaveBeenCalledTimes(2);
		expect(result.citations[0]!.citizenSummary).toBe("Ya tiene resumen");
	});

	test("citation verification filters fabricated normIds", async () => {
		db.exec("INSERT INTO norms VALUES ('BOE-A-2024-001', 'Real Law')");
		db.exec(
			"INSERT INTO blocks VALUES ('BOE-A-2024-001', 'art1', 'Articulo 1', 'precepto', 'Texto real')",
		);

		mockCallOpenRouter
			.mockResolvedValueOnce({
				data: { keywords: ["test"], materias: [], temporal: false },
				cost: 0,
				tokensIn: 0,
				tokensOut: 0,
				elapsed: 50,
			})
			.mockResolvedValueOnce({
				data: {
					answer: "Respuesta con citas.",
					citations: [
						{ norm_id: "BOE-A-2024-001", article_title: "Articulo 1" },
						{ norm_id: "BOE-A-INVENTADO-999", article_title: "Art. 42" },
					],
					declined: false,
				},
				cost: 0,
				tokensIn: 0,
				tokensOut: 0,
				elapsed: 100,
			});

		mockVectorSearch.mockReturnValue([
			{ normId: "BOE-A-2024-001", blockId: "art1", score: 0.9 },
		]);

		const pipeline = new RagPipeline(db, "fake-key", "/fake/path");
		const result = await pipeline.ask({ question: "Mis derechos?" });

		// Only the real citation should survive
		expect(result.citations).toHaveLength(1);
		expect(result.citations[0]!.normId).toBe("BOE-A-2024-001");
	});
});
