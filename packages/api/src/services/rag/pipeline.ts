/**
 * RAG Pipeline — orchestrator.
 *
 * Sprint 3 split: this file is now the thin orchestration layer over
 *   - `analyzer.ts`      query intent + helpers
 *   - `bm25-dispatch.ts` 5-stage BM25 fan-out
 *   - `retrieval.ts`     `runRetrievalCore` (vector || BM25, fuse, rerank)
 *   - `synthesis.ts`     prompts, evidence builder, JSON + streaming synth,
 *                        citation verification, citizen-summary backfill
 *
 * Both `ask()` (non-streaming) and `askStream()` (SSE) call the same
 * `runRetrievalCore` so retrieval quality is observably identical between
 * the two paths. See research/eval-gate.ts for the post-rerank R@K probe.
 */

import type { Database } from "bun:sqlite";
import {
	bm25HybridSearch,
	ensureBlocksFts,
	ensureBlocksFtsVocab,
} from "./blocks-fts.ts";
import {
	ensureVectorIndex,
	getEmbeddedNormIds,
	getEmbeddingCount,
} from "./embeddings.ts";
import {
	EMBEDDING_MODEL_KEY,
	LOW_CONFIDENCE_THRESHOLD,
	type RetrievedArticle,
	runRetrievalCore,
	TOP_K,
} from "./retrieval.ts";
import {
	buildEvidence,
	type Citation,
	generateMissingSummaries,
	INLINE_CITE_PATTERN,
	SYNTHESIS_MODEL,
	synthesizeAnswer,
	synthesizeStream,
	verifyCitations,
} from "./synthesis.ts";
import { type RagTrace, startTrace } from "./tracing.ts";

// Re-exports kept for backwards compatibility with existing tests + external
// imports. Tests import { articleTypePenalty, normalizePeriodicTitle } from
// this module; keep that surface stable.
export { articleTypePenalty } from "./retrieval.ts";
export { normalizePeriodicTitle } from "./analyzer.ts";
export type { Citation } from "./synthesis.ts";

// Suppress unused-import warning: bm25HybridSearch is imported only so the
// module is type-checked from this entry point and any failure surfaces
// here rather than deep in retrieval.ts.
void bm25HybridSearch;

// ── Public types ──

export interface AskRequest {
	question: string;
	jurisdiction?: string;
}

export interface AskResponse {
	answer: string;
	citations: Citation[];
	declined: boolean;
	meta: {
		articlesRetrieved: number;
		temporalEnriched: boolean;
		latencyMs: number;
		model: string;
	};
}

// ── Decline canned responses ──

const DECLINE_NON_LEGAL =
	"Solo puedo ayudarte con preguntas sobre legislación y derechos en España. Tu pregunta no parece estar relacionada con temas legales.";
const DECLINE_NO_ARTICLES =
	"No he encontrado artículos relevantes en la legislación española consolidada para responder a tu pregunta.";
const DECLINE_LOW_CONFIDENCE =
	"No he encontrado legislación relevante para responder a tu pregunta. Solo puedo ayudarte con preguntas sobre leyes y derechos en España.";

// ── Pipeline ──

export class RagPipeline {
	private cohereApiKey: string | null;
	private embeddedNormIds: string[] | null = null;
	private vectorIndex: Awaited<ReturnType<typeof ensureVectorIndex>> = null;
	private vectorIndexPromise: Promise<void> | null = null;

	private insertSummaryStmt: ReturnType<Database["prepare"]>;
	private insertAskLogStmt: ReturnType<Database["prepare"]>;

	constructor(
		private db: Database,
		private apiKey: string,
		private dataDir: string = "./data",
	) {
		this.cohereApiKey = process.env.COHERE_API_KEY ?? null;

		// Initialize article-level BM25 index for hybrid search
		ensureBlocksFts(this.db);
		// Vocab table powers the OR-fallback token pruning in bm25ArticleSearch.
		// Main thread owns the schema; workers only SELECT.
		ensureBlocksFtsVocab(this.db);

		this.insertSummaryStmt = this.db.prepare(
			"INSERT OR IGNORE INTO citizen_article_summaries (norm_id, block_id, summary) VALUES (?, ?, ?)",
		);

		// ask_log table is defined in schema.ts — ensure it exists for standalone API usage
		this.db.run(`CREATE TABLE IF NOT EXISTS ask_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			question TEXT NOT NULL,
			jurisdiction TEXT,
			answer TEXT,
			declined INTEGER NOT NULL DEFAULT 0,
			citations_count INTEGER NOT NULL DEFAULT 0,
			articles_retrieved INTEGER NOT NULL DEFAULT 0,
			latency_ms INTEGER NOT NULL DEFAULT 0,
			model TEXT,
			best_score REAL,
			tokens_in INTEGER,
			tokens_out INTEGER,
			cost_usd REAL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);

		// Idempotent migration for pre-existing DBs that lack the cost columns.
		const existingCols = new Set(
			this.db
				.query<{ name: string }, []>(`PRAGMA table_info(ask_log)`)
				.all()
				.map((r) => r.name),
		);
		for (const [col, ddl] of [
			["tokens_in", "INTEGER"],
			["tokens_out", "INTEGER"],
			["cost_usd", "REAL"],
		] as const) {
			if (!existingCols.has(col)) {
				this.db.run(`ALTER TABLE ask_log ADD COLUMN ${col} ${ddl}`);
			}
		}

		this.insertAskLogStmt = this.db.prepare(
			`INSERT INTO ask_log (question, jurisdiction, answer, declined, citations_count, articles_retrieved, latency_ms, model, best_score, tokens_in, tokens_out, cost_usd)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
	}

	async ask(request: AskRequest): Promise<AskResponse> {
		const start = Date.now();
		const trace = startTrace(request.question, {
			jurisdiction: request.jurisdiction,
			model: SYNTHESIS_MODEL,
		});

		try {
			const result = await this.runAsk(request, start, trace);
			try {
				this.insertAskLogStmt.run(
					request.question,
					request.jurisdiction ?? null,
					result.answer,
					result.declined ? 1 : 0,
					result.citations.length,
					result.meta.articlesRetrieved,
					result.meta.latencyMs,
					result.meta.model,
					result._bestScore ?? null,
					result._tokensIn ?? null,
					result._tokensOut ?? null,
					result._cost ?? null,
				);
			} catch (logErr) {
				console.warn(
					"ask_log insert failed:",
					logErr instanceof Error ? logErr.message : "unknown",
				);
			}
			const {
				_bestScore: _bs,
				_cost: _c,
				_tokensIn: _ti,
				_tokensOut: _to,
				...response
			} = result;
			return response;
		} catch (err) {
			trace.end({
				error: err instanceof Error ? err.message : String(err),
				latencyMs: Date.now() - start,
			});
			throw err;
		}
	}

	private async runAsk(
		request: AskRequest,
		start: number,
		trace: RagTrace,
	): Promise<
		AskResponse & {
			_bestScore?: number;
			_cost?: number;
			_tokensIn?: number;
			_tokensOut?: number;
		}
	> {
		const retrieval = await runRetrievalCore({
			db: this.db,
			apiKey: this.apiKey,
			cohereApiKey: this.cohereApiKey,
			question: request.question,
			requestJurisdiction: request.jurisdiction,
			embeddedNormIds: this.getEmbeddedNormIdsCached(),
			vectorIndex: await this.getVectorIndex(),
			trace,
		});

		const totalCost = retrieval.cost.analyze + retrieval.cost.embedding;
		const totalIn = retrieval.tokens.analyzeIn + retrieval.tokens.embedding;
		const totalOut = retrieval.tokens.analyzeOut;

		if (retrieval.type === "early") {
			const answer =
				retrieval.reason === "non_legal"
					? DECLINE_NON_LEGAL
					: retrieval.reason === "no_articles"
						? DECLINE_NO_ARTICLES
						: DECLINE_LOW_CONFIDENCE;
			const result: AskResponse & {
				_bestScore?: number;
				_cost?: number;
				_tokensIn?: number;
				_tokensOut?: number;
			} = {
				answer,
				citations: [],
				declined: true,
				meta: {
					articlesRetrieved: 0,
					temporalEnriched: false,
					latencyMs: Date.now() - start,
					model: SYNTHESIS_MODEL,
				},
				_bestScore: retrieval.bestScore,
				_cost: totalCost,
				_tokensIn: totalIn,
				_tokensOut: totalOut,
			};
			trace.end({ ...result, reason: retrieval.reason });
			return result;
		}

		const { articles, useTemporal, bestScore } = retrieval;

		// Build evidence + synthesise (JSON mode).
		const { evidenceText, systemPrompt } = buildEvidence({
			db: this.db,
			articles,
			useTemporal,
			streaming: false,
		});

		const synthesisSpan = trace.span("synthesis", "llm", {
			question: request.question,
			evidenceChars: evidenceText.length,
			evidenceApproxTokens: Math.ceil(evidenceText.length / 4),
			temporal: useTemporal,
		});
		const synthesis = await synthesizeAnswer({
			apiKey: this.apiKey,
			question: request.question,
			evidenceText,
			systemPrompt,
		});
		synthesisSpan.end({
			declined: synthesis.declined,
			answerLength: synthesis.answer.length,
			rawCitationCount: synthesis.citations.length,
			rawCitations: synthesis.citations,
		});

		// Verify citations against the evidence pool.
		const verificationSpan = trace.span("citation-verification", "tool", {
			rawCitations: synthesis.citations,
			evidenceNormIds: [...new Set(articles.map((a) => a.normId))],
		});
		const validCitations = verifyCitations(synthesis.citations, articles);
		const verifiedCount = validCitations.filter((c) => c.verified).length;
		const approxCount = validCitations.filter((c) => !c.verified).length;
		const fabricatedCount = synthesis.citations.length - validCitations.length;
		verificationSpan.end({
			totalRaw: synthesis.citations.length,
			verified: verifiedCount,
			approximate: approxCount,
			fabricated: fabricatedCount,
			validCitations: validCitations.map((c) => ({
				normId: c.normId,
				articleTitle: c.articleTitle,
				verified: c.verified,
			})),
		});

		// Fire-and-forget background citizen-summary backfill.
		generateMissingSummaries({
			apiKey: this.apiKey,
			citations: validCitations,
			articles,
			insertSummaryStmt: this.insertSummaryStmt,
		});

		// Soft-fail watermark when most citations are unverifiable.
		const invalidCount = synthesis.citations.length - validCitations.length;
		let finalAnswer = synthesis.answer;
		if (
			synthesis.citations.length > 0 &&
			invalidCount > synthesis.citations.length / 2
		) {
			finalAnswer +=
				"\n\n(Nota: Parte de la información no ha podido ser verificada con las fuentes disponibles.)";
		}

		// Citation completeness signal (inline norm+article vs bare article ref).
		const inlineCitePattern =
			/\[([A-Z]{2,5}-[A-Za-z]-\d{4}-\d+),\s*(Art(?:ículo|\.)\s*\d+[^\]]*)\]/g;
		const inlineCites = [...finalAnswer.matchAll(inlineCitePattern)];
		const bareArticlePattern =
			/(?<!\[[A-Z]{2,5}-[A-Za-z]-\d{4}-\d+,\s*)(?:artículo|art\.)\s+\d+/gi;
		const bareCites = [...finalAnswer.matchAll(bareArticlePattern)];
		const citationCompleteness =
			inlineCites.length + bareCites.length > 0
				? inlineCites.length / (inlineCites.length + bareCites.length)
				: synthesis.declined
					? 1
					: 0;

		trace.score(
			"citation_accuracy",
			synthesis.citations.length > 0
				? verifiedCount / synthesis.citations.length
				: 1,
			`${verifiedCount} verified, ${approxCount} approx, ${fabricatedCount} fabricated`,
		);
		trace.score(
			"citation_completeness",
			citationCompleteness,
			`${inlineCites.length} complete inline, ${bareCites.length} bare article refs`,
		);

		const totalSynthCost = totalCost + synthesis.cost;
		const totalSynthIn = totalIn + synthesis.tokensIn;
		const totalSynthOut = totalOut + synthesis.tokensOut;

		const result: AskResponse & {
			_bestScore?: number;
			_cost?: number;
			_tokensIn?: number;
			_tokensOut?: number;
		} = {
			answer: finalAnswer,
			citations: validCitations,
			declined: synthesis.declined,
			meta: {
				articlesRetrieved: articles.length,
				temporalEnriched: useTemporal,
				latencyMs: Date.now() - start,
				model: SYNTHESIS_MODEL,
			},
			_bestScore: bestScore,
			_cost: totalSynthCost,
			_tokensIn: totalSynthIn,
			_tokensOut: totalSynthOut,
		};

		trace.end({
			answer: finalAnswer.slice(0, 500),
			declined: synthesis.declined,
			articlesRetrieved: articles.length,
			citationsVerified: verifiedCount,
			citationsFabricated: fabricatedCount,
			citationCompleteness,
			inlineCitationsFound: inlineCites.length,
			bareArticleRefs: bareCites.length,
			latencyMs: Date.now() - start,
		});

		return result;
	}

	/**
	 * Streaming variant of ask(). Yields text chunks as they arrive from the
	 * LLM, then a final event with citations and metadata.
	 */
	async *askStream(request: AskRequest): AsyncGenerator<
		| { type: "chunk"; text: string }
		| { type: "keepalive" }
		| {
				type: "done";
				citations: Citation[];
				meta: AskResponse["meta"];
				declined: boolean;
		  }
	> {
		const start = Date.now();
		const trace = startTrace(request.question, {
			jurisdiction: request.jurisdiction,
			model: SYNTHESIS_MODEL,
			stream: true,
		});

		try {
			// Retrieval can take >100s on the production server, longer than the
			// Cloudflare Tunnel idle timeout. Interleave keepalive events every
			// 10s so the route handler can flush an SSE comment and the proxy
			// keeps the connection open.
			const retrievalPromise = runRetrievalCore({
				db: this.db,
				apiKey: this.apiKey,
				cohereApiKey: this.cohereApiKey,
				question: request.question,
				requestJurisdiction: request.jurisdiction,
				embeddedNormIds: this.getEmbeddedNormIdsCached(),
				vectorIndex: await this.getVectorIndex(),
				trace,
			});
			let retrievalDone = false;
			retrievalPromise.finally(() => {
				retrievalDone = true;
			});
			while (!retrievalDone) {
				const tick = new Promise<"tick">((r) =>
					setTimeout(() => r("tick"), 10_000),
				);
				const winner = await Promise.race([
					retrievalPromise.then(() => "done" as const),
					tick,
				]);
				if (winner === "tick" && !retrievalDone) {
					yield { type: "keepalive" };
				}
			}
			const retrieval = await retrievalPromise;

			const totalRetrieveCost =
				retrieval.cost.analyze + retrieval.cost.embedding;
			const totalRetrieveIn =
				retrieval.tokens.analyzeIn + retrieval.tokens.embedding;
			const totalRetrieveOut = retrieval.tokens.analyzeOut;

			if (retrieval.type === "early") {
				const answer =
					retrieval.reason === "non_legal"
						? DECLINE_NON_LEGAL
						: retrieval.reason === "no_articles"
							? DECLINE_NO_ARTICLES
							: DECLINE_LOW_CONFIDENCE;
				const meta = {
					articlesRetrieved: 0,
					temporalEnriched: false,
					latencyMs: Date.now() - start,
					model: SYNTHESIS_MODEL,
				};
				yield { type: "chunk", text: answer };
				yield { type: "done", citations: [], meta, declined: true };
				try {
					this.insertAskLogStmt.run(
						request.question,
						request.jurisdiction ?? null,
						answer,
						1,
						0,
						0,
						meta.latencyMs,
						SYNTHESIS_MODEL,
						null,
						totalRetrieveIn,
						totalRetrieveOut,
						totalRetrieveCost,
					);
				} catch {
					/* ignore */
				}
				trace.end({
					answer,
					declined: true,
					reason: retrieval.reason,
					latencyMs: meta.latencyMs,
					totalCostUsd: totalRetrieveCost,
					totalTokensIn: totalRetrieveIn,
					totalTokensOut: totalRetrieveOut,
				});
				return;
			}

			const { articles, useTemporal, bestScore } = retrieval;
			const { evidenceText, systemPrompt } = buildEvidence({
				db: this.db,
				articles,
				useTemporal,
				streaming: true,
			});

			const synthesisSpan = trace.span("synthesis", "llm", {
				question: request.question,
				evidenceChars: evidenceText.length,
				evidenceApproxTokens: Math.ceil(evidenceText.length / 4),
				temporal: useTemporal,
				streaming: true,
			});

			let fullText = "";
			let synthesisTokensIn = 0;
			let synthesisTokensOut = 0;
			let synthesisCost = 0;
			for await (const event of synthesizeStream({
				apiKey: this.apiKey,
				question: request.question,
				evidenceText,
				systemPrompt,
			})) {
				if (event.type === "delta") {
					fullText += event.text;
					yield { type: "chunk", text: event.text };
				} else if (event.type === "done") {
					synthesisTokensIn = event.tokensIn;
					synthesisTokensOut = event.tokensOut;
					synthesisCost = event.cost;
				}
			}

			// Parse citations from the accumulated text
			const rawCitations: Array<{ normId: string; articleTitle: string }> = [];
			for (const match of fullText.matchAll(INLINE_CITE_PATTERN)) {
				rawCitations.push({ normId: match[1]!, articleTitle: match[2]! });
			}

			const seen = new Set<string>();
			const uniqueCitations = rawCitations.filter((c) => {
				const key = `${c.normId}:${c.articleTitle}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});

			const validCitations = verifyCitations(uniqueCitations, articles);

			const declined =
				fullText.includes("Solo puedo ayudarte con preguntas") ||
				fullText.includes("No he encontrado legislación");

			synthesisSpan.end(
				{
					declined,
					answerLength: fullText.length,
					rawCitationCount: uniqueCitations.length,
					validCitationCount: validCitations.length,
				},
				{
					synthesisCost: `$${synthesisCost.toFixed(8)}`,
					synthesisTokensIn,
					synthesisTokensOut,
				},
			);

			generateMissingSummaries({
				apiKey: this.apiKey,
				citations: validCitations,
				articles,
				insertSummaryStmt: this.insertSummaryStmt,
			});

			const latencyMs = Date.now() - start;
			const totalCost = totalRetrieveCost + synthesisCost;
			const totalTokensIn = totalRetrieveIn + synthesisTokensIn;
			const totalTokensOut = totalRetrieveOut + synthesisTokensOut;

			try {
				this.insertAskLogStmt.run(
					request.question,
					request.jurisdiction ?? null,
					fullText,
					declined ? 1 : 0,
					validCitations.length,
					articles.length,
					latencyMs,
					SYNTHESIS_MODEL,
					bestScore,
					totalTokensIn,
					totalTokensOut,
					totalCost,
				);
			} catch {
				/* ignore */
			}

			trace.end({
				answer: fullText.slice(0, 500),
				declined,
				articlesRetrieved: articles.length,
				citationsVerified: validCitations.filter((c) => c.verified).length,
				citationsTotal: validCitations.length,
				latencyMs,
				totalCostUsd: totalCost,
				totalTokensIn,
				totalTokensOut,
			});

			yield {
				type: "done",
				citations: validCitations,
				meta: {
					articlesRetrieved: articles.length,
					temporalEnriched: useTemporal,
					latencyMs,
					model: SYNTHESIS_MODEL,
				},
				declined,
			};
		} catch (err) {
			trace.end({
				error: err instanceof Error ? err.message : String(err),
				latencyMs: Date.now() - start,
			});
			throw err;
		}
	}

	/**
	 * Eval-gate hook: runs only the retrieval stage and returns the post-rerank
	 * article list plus the unfiltered fused pool. Used by
	 * `packages/api/research/eval-gate.ts` to capture R@1/R@5/R@10 baselines
	 * without paying the synthesis cost. Not part of the public HTTP surface.
	 */
	async _retrieveForEval(request: AskRequest): Promise<{
		articles: RetrievedArticle[];
		allFusedArticles: RetrievedArticle[];
		bestScore: number;
		declined: boolean;
		reason?: string;
	}> {
		const retrieval = await runRetrievalCore({
			db: this.db,
			apiKey: this.apiKey,
			cohereApiKey: this.cohereApiKey,
			question: request.question,
			requestJurisdiction: request.jurisdiction,
			embeddedNormIds: this.getEmbeddedNormIdsCached(),
			vectorIndex: await this.getVectorIndex(),
		});
		if (retrieval.type === "early") {
			return {
				articles: [],
				allFusedArticles: [],
				bestScore: retrieval.bestScore,
				declined: true,
				reason: retrieval.reason,
			};
		}
		return {
			articles: retrieval.articles,
			allFusedArticles: retrieval.allFusedArticles,
			bestScore: retrieval.bestScore,
			declined: false,
		};
	}

	// ── Internals ──

	/**
	 * Ensure the flat binary vector index exists and is up to date.
	 * Built once from SQLite on first request (~30s), then cached.
	 */
	private async getVectorIndex() {
		if (this.vectorIndex) return this.vectorIndex;
		if (!this.vectorIndexPromise) {
			this.vectorIndexPromise = ensureVectorIndex(
				this.db,
				EMBEDDING_MODEL_KEY,
				this.dataDir,
			)
				.then((idx) => {
					this.vectorIndex = idx;
				})
				.catch((err) => {
					this.vectorIndexPromise = null;
					throw err;
				});
		}
		await this.vectorIndexPromise;
		return this.vectorIndex;
	}

	/**
	 * Cached list of norm IDs with embeddings — used to scope BM25 search.
	 * Loaded once on first query, then reused. ~10K string IDs = negligible RAM.
	 */
	private getEmbeddedNormIdsCached(): string[] {
		if (!this.embeddedNormIds) {
			this.embeddedNormIds = getEmbeddedNormIds(this.db, EMBEDDING_MODEL_KEY);
			console.log(
				`[rag] ${this.embeddedNormIds.length} norms with embeddings (streaming search, no bulk RAM)`,
			);
		}
		return this.embeddedNormIds;
	}

	/** Total embeddings count (used by health/diagnostics). */
	getEmbeddingCount(): number {
		return getEmbeddingCount(this.db, EMBEDDING_MODEL_KEY);
	}

	/** Expose the configured TOP_K for diagnostics / eval scripts. */
	get topK() {
		return TOP_K;
	}

	/** Expose the low-confidence threshold for diagnostics. */
	get lowConfidenceThreshold() {
		return LOW_CONFIDENCE_THRESHOLD;
	}
}
