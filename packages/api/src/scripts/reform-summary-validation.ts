/**
 * Validation for LLM-generated reform summaries (generate-reform-summaries.ts).
 *
 * Kept in its own module so it can be unit-tested without running the script's
 * top-level CLI/DB code.
 */

import { hasForeignScript } from "@leyabierta/pipeline";

export interface SummaryResponse {
	headline: string;
	summary: string;
	importance: "high" | "normal" | "low" | "skip";
	reform_type: "new_law" | "modification" | "correction" | "derogation";
}

export function validateReformSummary(data: unknown): {
	result: SummaryResponse | null;
	reason: string;
} {
	if (!data || typeof data !== "object")
		return { result: null, reason: "not an object" };
	const d = data as Record<string, unknown>;

	let headline = typeof d.headline === "string" ? d.headline.trim() : "";
	let summary = typeof d.summary === "string" ? d.summary.trim() : "";
	const importance = typeof d.importance === "string" ? d.importance : "";
	const reformType = typeof d.reform_type === "string" ? d.reform_type : "";

	// Truncate instead of rejecting — structured outputs should prevent this,
	// but belt-and-suspenders for models that don't fully support json_schema
	if (headline.length > 100) {
		headline = `${headline.slice(0, 97)}...`;
	}
	if (summary.length > 500) {
		summary = `${summary.slice(0, 497)}...`;
	}

	if (!["high", "normal", "low", "skip"].includes(importance))
		return { result: null, reason: `invalid importance: "${importance}"` };
	if (
		!["new_law", "modification", "correction", "derogation"].includes(
			reformType,
		)
	)
		return { result: null, reason: `invalid reform_type: "${reformType}"` };

	// A row in reform_summaries is never regenerated (the generator only picks
	// reforms WITHOUT a row), so persisting a blank headline/summary would leave
	// that reform with an empty card forever (the single-reform page and the law
	// history read the row whatever its importance). Reject it so the next run
	// retries.
	if (!headline || !summary)
		return { result: null, reason: "empty headline or summary" };
	// Not stored: the reform stays without a row and the next run retries.
	if (hasForeignScript(headline, summary))
		return { result: null, reason: "foreign script (model switched language)" };

	return {
		result: {
			headline,
			summary,
			importance: importance as SummaryResponse["importance"],
			reform_type: reformType as SummaryResponse["reform_type"],
		},
		reason: "ok",
	};
}
