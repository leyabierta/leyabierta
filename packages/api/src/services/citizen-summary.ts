/**
 * On-demand citizen article summary generation.
 *
 * When an article has no citizen_summary, generates one, caches it in the DB
 * and returns it. Subsequent requests are instant. Generation, validation and
 * storage are the ones every path shares (@leyabierta/pipeline
 * ai/article-summary.ts: prompt v10, ARTICLE_SUMMARIES_MODEL, whole article,
 * model/prompt_version/generated_at stored). Used by GET
 * /v1/laws/:id/summaries (fire-and-forget) and the RAG background fill.
 */

import type { Database } from "bun:sqlite";
import {
	articleHasSubstance,
	articleSummariesModel,
	generateArticleSummary,
	storeArticleSummary,
} from "@leyabierta/pipeline";

// Lazy calls run in the background, so a slow upstream never delays a
// response; give reasoning models room before giving up.
const LAZY_TIMEOUT_MS = 90_000;

interface GeneratedSummary {
	citizen_summary: string;
	citizen_tags: string[];
}

export class CitizenSummaryService {
	private apiKey: string | null;
	private db: Database;
	private stmtGet: ReturnType<Database["prepare"]>;
	private stmtGetTags: ReturnType<Database["prepare"]>;
	private stmtGetArticle: ReturnType<Database["prepare"]>;
	// Track in-flight requests to avoid duplicate LLM calls for the same article
	private pending = new Map<string, Promise<GeneratedSummary | null>>();
	// Articles already attempted in this process that produced nothing to cache
	// (a placeholder article, a summary that failed validation, or a failed
	// call). Without this, every request re-paid the LLM for the same article:
	// GET /v1/laws/:id/summaries fires up to 5 generations per hit, so a crawler
	// looping over a law full of such articles was an unbounded spend.
	// Per-process (cleared on the daily API restart) and size-capped.
	private attempted = new Set<string>();
	private static readonly MAX_ATTEMPTED = 50_000;

	constructor(db: Database) {
		this.db = db;
		this.apiKey = process.env.OPENROUTER_API_KEY ?? null;

		this.stmtGet = db.prepare(
			"SELECT summary FROM citizen_article_summaries WHERE norm_id = ? AND block_id = ?",
		);
		this.stmtGetTags = db.prepare(
			"SELECT tag FROM citizen_tags WHERE norm_id = ? AND block_id = ?",
		);
		this.stmtGetArticle = db.prepare(
			`SELECT n.title AS normTitle, b.title AS blockTitle, b.current_text AS text
			 FROM blocks b JOIN norms n ON n.id = b.norm_id
			 WHERE b.norm_id = ? AND b.block_id = ?`,
		);
	}

	/**
	 * Get the citizen summary for an article. Returns from cache if available,
	 * otherwise generates on-demand via LLM.
	 */
	async getOrGenerate(
		normId: string,
		blockId: string,
		normTitle: string,
		articleTitle: string,
		articleText: string,
	): Promise<{ citizen_summary: string; citizen_tags: string[] } | null> {
		// 1. Check DB cache
		const cached = this.stmtGet.get(normId, blockId) as {
			summary: string;
		} | null;
		if (cached?.summary) {
			const tags = (
				this.stmtGetTags.all(normId, blockId) as { tag: string }[]
			).map((r) => r.tag);
			return { citizen_summary: cached.summary, citizen_tags: tags };
		}
		// An empty row is a deliberate "nothing to say" (older prompts returned
		// "" for procedural articles); storage never overwrites it, so a new
		// generation would be paid for nothing.
		if (cached) return null;

		// 2. No API key = no generation
		if (!this.apiKey) return null;

		// 3. Skip very short articles and placeholders ("(Derogado)", a bare
		// chapter heading): nothing to summarize.
		if (articleText.length < 50 || !articleHasSubstance(articleText))
			return null;

		// 4. Deduplicate in-flight requests
		const cacheKey = `${normId}:${blockId}`;
		const inflight = this.pending.get(cacheKey);
		if (inflight) {
			const result = await inflight;
			return result;
		}

		// 5. Already tried in this process and nothing was cached: don't re-pay.
		if (this.attempted.has(cacheKey)) return null;
		if (this.attempted.size >= CitizenSummaryService.MAX_ATTEMPTED) {
			// FIFO: a Set iterates in insertion order, so evict only the oldest
			// entry instead of re-exposing every attempted article at once.
			const oldest = this.attempted.values().next().value;
			if (oldest !== undefined) this.attempted.delete(oldest);
		}
		this.attempted.add(cacheKey);

		const promise = this.generate(
			normId,
			blockId,
			normTitle,
			articleTitle,
			articleText,
		);
		this.pending.set(cacheKey, promise);

		try {
			const result = await promise;
			return result;
		} finally {
			this.pending.delete(cacheKey);
		}
	}

	/**
	 * Background fill for an article known only by its ids (the RAG path cites
	 * articles, sometimes through a sub-chunk of them): the whole current text
	 * is read from the DB, never the retrieved fragment. Never throws.
	 */
	async generateForBlock(
		normId: string,
		blockId: string,
	): Promise<GeneratedSummary | null> {
		const article = this.stmtGetArticle.get(normId, blockId) as {
			normTitle: string;
			blockTitle: string;
			text: string;
		} | null;
		if (!article) return null;
		return this.getOrGenerate(
			normId,
			blockId,
			article.normTitle,
			article.blockTitle,
			article.text,
		);
	}

	private async generate(
		normId: string,
		blockId: string,
		normTitle: string,
		articleTitle: string,
		articleText: string,
	): Promise<GeneratedSummary | null> {
		const result = await generateArticleSummary({
			apiKey: this.apiKey!,
			article: {
				norm_title: normTitle,
				block_title: articleTitle,
				current_text: articleText,
			},
			model: articleSummariesModel(),
			timeoutMs: LAZY_TIMEOUT_MS,
		});
		if (!result.ok) {
			// A language switch, second person, a summary too long for the
			// article...: never stored or shown.
			console.error(
				`citizen-summary: not stored for ${normId}/${blockId}: ${result.reason}`,
			);
			return null;
		}
		try {
			storeArticleSummary(this.db, normId, blockId, result);
		} catch (err) {
			console.error(`citizen-summary: failed for ${normId}/${blockId}: ${err}`);
			return null;
		}
		// Serve what is stored: a concurrent writer (cron, import) may have won.
		const stored = this.stmtGet.get(normId, blockId) as {
			summary: string;
		} | null;
		const tags = (
			this.stmtGetTags.all(normId, blockId) as { tag: string }[]
		).map((r) => r.tag);
		return {
			citizen_summary: stored?.summary ?? result.summary,
			citizen_tags: tags,
		};
	}
}
