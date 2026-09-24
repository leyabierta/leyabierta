/**
 * Prompt (v10), output schema and response parser for per-article citizen
 * summaries. They live in @leyabierta/pipeline (ai/article-summary-prompt.ts)
 * so the daily cron can share them; re-exported here for the offline and
 * backfill scripts, tests and model evaluations.
 */

export {
	ARTICLE_SUMMARY_PROMPT_VERSION,
	BATCH_SCHEMA,
	type BackfillArticle,
	type BatchSummary,
	buildBatchPrompt,
	parseBatchContent,
	SYSTEM_PROMPT,
} from "@leyabierta/pipeline";
